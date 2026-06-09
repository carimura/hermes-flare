import type { Sandbox } from "@cloudflare/sandbox";

/**
 * Persistence layer for Hermes' data dir.
 *
 * The Sandbox SDK's createBackup/restoreBackup APIs snapshot a directory
 * to R2 as a squashfs image. The backup tree must live under one of
 * /home, /workspace, /tmp, /var/tmp — we use /home/hermes (Hermes' data
 * dir is at /home/hermes/.hermes, plus /opt/data is symlinked there).
 *
 * Strategy (lifted from cloudflare/moltworker):
 * - In-isolate flag for fast path (skip R2 read on every request).
 * - R2 marker key (`restore-needed`) lets other isolates know to re-restore
 *   after a config change or gateway restart.
 * - The newest backup handle lives at `backup-handle.json` (the restore
 *   target); `backups-index.json` lists all retained backups so old ones
 *   can be pruned by age (see BACKUP_RETENTION_DAYS).
 */
const BACKUP_DIR = "/home/hermes";
const HANDLE_KEY = "backup-handle.json";
const INDEX_KEY = "backups-index.json";
const RESTORE_NEEDED_KEY = "restore-needed";
const SECONDS_PER_DAY = 86_400;

let restoredInThisIsolate = false;

interface BackupHandle {
  id: string;
  dir: string;
}

async function getStoredHandle(bucket: R2Bucket): Promise<BackupHandle | null> {
  const obj = await bucket.get(HANDLE_KEY);
  if (!obj) return null;
  return obj.json();
}

async function storeHandle(bucket: R2Bucket, handle: BackupHandle): Promise<void> {
  await bucket.put(HANDLE_KEY, JSON.stringify(handle));
}

async function deleteStoredHandle(bucket: R2Bucket): Promise<void> {
  await bucket.delete(HANDLE_KEY);
}

/** One retained backup. `backups-index.json` is an array of these. */
interface BackupEntry {
  id: string;
  dir: string;
  createdAt: string; // ISO 8601
}

async function getIndex(bucket: R2Bucket): Promise<BackupEntry[]> {
  const obj = await bucket.get(INDEX_KEY);
  if (!obj) return [];
  try {
    return await obj.json();
  } catch {
    return [];
  }
}

async function putIndex(bucket: R2Bucket, entries: BackupEntry[]): Promise<void> {
  await bucket.put(INDEX_KEY, JSON.stringify(entries));
}

/**
 * Restore the latest backup if one exists and this isolate hasn't restored yet.
 * Cheap to call on every request — only hits R2 on cache miss.
 */
export async function restoreIfNeeded(
  sandbox: Sandbox,
  bucket: R2Bucket,
): Promise<void> {
  if (restoredInThisIsolate) {
    // Cross-isolate invalidation: check the marker.
    const marker = await bucket.head(RESTORE_NEEDED_KEY);
    if (!marker) return;
    console.log("[persistence] restore-needed marker found, re-restoring");
    restoredInThisIsolate = false;
  }

  const handle = await getStoredHandle(bucket);
  if (!handle) {
    console.log("[persistence] no prior backup, starting fresh");
    restoredInThisIsolate = true;
    return;
  }

  // Clear any stale FUSE overlay before re-restoring.
  try {
    await sandbox.exec(`umount ${BACKUP_DIR} 2>/dev/null; true`);
  } catch {
    /* may not be mounted */
  }

  console.log(`[persistence] restoring backup ${handle.id}`);
  const t0 = Date.now();
  try {
    await sandbox.restoreBackup(handle);
    await bucket.delete(RESTORE_NEEDED_KEY);
    restoredInThisIsolate = true;
    console.log(`[persistence] restored in ${Date.now() - t0}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/BACKUP_EXPIRED|BACKUP_NOT_FOUND|BackupExpiredError|BackupNotFoundError/.test(msg)) {
      console.log(`[persistence] backup ${handle.id} gone, clearing handle`);
      await deleteStoredHandle(bucket);
      restoredInThisIsolate = true;
      return;
    }
    throw err;
  }
}

/**
 * Snapshot /home/hermes to R2, then prune backups older than the retention
 * window. Snapshots accumulate (one entry per call in `backups-index.json`)
 * instead of replacing the previous one; anything older than retentionDays is
 * deleted from R2. `backup-handle.json` always points at the newest, which is
 * what restoreIfNeeded and the snapshotIfDue throttle read.
 */
export async function createSnapshot(
  sandbox: Sandbox,
  bucket: R2Bucket,
  retentionDays: number,
): Promise<BackupHandle> {
  // Ensure permissions are readable for mksquashfs.
  await sandbox.exec(`chmod -R a+rX ${BACKUP_DIR} 2>/dev/null; true`);

  console.log("[persistence] creating snapshot");
  const t0 = Date.now();
  // /home/hermes is ~100 MB now (Hermes install moved to /opt/hermes-install,
  // see Dockerfile), so default mksquashfs gzip finishes within the Worker
  // budget. An earlier version forced lz4 via `compression: { format: "lz4" }`
  // for speed when the tree was 1.5 GB — that option isn't in the SDK's
  // BackupOptions type and broke `npm run typecheck` (#10).
  //
  // ttl is set a day past the retention window so every retained backup stays
  // restorable until we prune it — the SDK refuses to restore past ttl, and
  // its 3-day default is exactly what expired on us. No upper limit on ttl.
  const ttl = (retentionDays + 1) * SECONDS_PER_DAY;
  const handle = await sandbox.createBackup({ dir: BACKUP_DIR, ttl });
  const createdAt = new Date().toISOString();
  console.log(`[persistence] snapshot ${handle.id} created in ${Date.now() - t0}ms`);

  // Append to the index, then prune entries older than the retention window.
  const index = await getIndex(bucket);
  index.push({ id: handle.id, dir: handle.dir, createdAt });
  const cutoff = Date.now() - retentionDays * SECONDS_PER_DAY * 1000;
  const kept: BackupEntry[] = [];
  for (const entry of index) {
    if (Date.parse(entry.createdAt) >= cutoff) {
      kept.push(entry);
    } else {
      await bucket.delete(`backups/${entry.id}/data.sqsh`);
      await bucket.delete(`backups/${entry.id}/meta.json`);
      console.log(`[persistence] pruned backup ${entry.id} (older than ${retentionDays}d)`);
    }
  }
  await putIndex(bucket, kept);
  await storeHandle(bucket, handle); // newest = restore target
  return handle;
}

/**
 * Snapshot /home/hermes only if the latest backup is older than maxAgeMs (or
 * there is none). Cheap to call on every cron tick — one R2 HEAD on the fast
 * path. Reuses backup-handle.json's own upload time, so there's no extra state
 * to track. Returns true if a snapshot was taken.
 */
export async function snapshotIfDue(
  sandbox: Sandbox,
  bucket: R2Bucket,
  maxAgeMs: number,
  retentionDays: number,
): Promise<boolean> {
  const meta = await bucket.head(HANDLE_KEY);
  if (meta && Date.now() - meta.uploaded.getTime() < maxAgeMs) return false;
  await createSnapshot(sandbox, bucket, retentionDays);
  return true;
}

/** Force every Worker isolate to re-restore on its next request. */
export async function signalRestoreNeeded(bucket: R2Bucket): Promise<void> {
  restoredInThisIsolate = false;
  await bucket.put(RESTORE_NEEDED_KEY, "1");
}
