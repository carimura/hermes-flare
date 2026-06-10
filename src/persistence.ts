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
 *
 * Shared bucket: every agent points at the SAME R2 bucket, so our metadata
 * keys are namespaced under `<agentName>/` to avoid collisions. The
 * SDK-written squashfs blobs (`backups/<id>/...`) are already globally unique
 * by id, so they need no prefix.
 */
const BACKUP_DIR = "/home/hermes";
/** Corruption sentinel: a healthy /home/hermes always has a non-empty hermes
 *  launcher (a symlink into /opt/hermes-install, baked into the image). A
 *  partial unsquashfs extraction — seen when a restore's archive transfer is
 *  truncated — leaves it as a 0-byte regular file. Checked before every
 *  snapshot (never archive a corrupt tree: that turns one bad restore into a
 *  permanently bad newest-backup) and after every restore (fail loudly). */
const SENTINEL_FILE = "/home/hermes/.local/bin/hermes";
const HANDLE_KEY = "backup-handle.json";
const INDEX_KEY = "backups-index.json";
const RESTORE_NEEDED_KEY = "restore-needed";
const SECONDS_PER_DAY = 86_400;

let restoredInThisIsolate = false;

async function assertTreeHealthy(sandbox: Sandbox, context: string): Promise<void> {
  const check = await sandbox.exec(`test -s ${SENTINEL_FILE} && echo __ok__ || true`);
  if (!check.stdout.includes("__ok__")) {
    throw new Error(
      `${context}: ${SENTINEL_FILE} is missing or empty — ${BACKUP_DIR} looks corrupt (partial restore?)`,
    );
  }
}

interface BackupHandle {
  id: string;
  dir: string;
}

/** Per-agent R2 key namespace. One Worker == one agent, so this is constant. */
function keysFor(agentName: string) {
  const prefix = `${agentName}/`;
  return {
    handle: prefix + HANDLE_KEY,
    index: prefix + INDEX_KEY,
    restoreNeeded: prefix + RESTORE_NEEDED_KEY,
  };
}

async function getStoredHandle(bucket: R2Bucket, key: string): Promise<BackupHandle | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return obj.json();
}

async function storeHandle(bucket: R2Bucket, key: string, handle: BackupHandle): Promise<void> {
  await bucket.put(key, JSON.stringify(handle));
}

async function deleteStoredHandle(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key);
}

/** One retained backup. `backups-index.json` is an array of these. */
interface BackupEntry {
  id: string;
  dir: string;
  createdAt: string; // ISO 8601
}

async function getIndex(bucket: R2Bucket, key: string): Promise<BackupEntry[]> {
  const obj = await bucket.get(key);
  if (!obj) return [];
  try {
    return await obj.json();
  } catch {
    return [];
  }
}

async function putIndex(bucket: R2Bucket, key: string, entries: BackupEntry[]): Promise<void> {
  await bucket.put(key, JSON.stringify(entries));
}

/**
 * Restore the latest backup if one exists and this isolate hasn't restored yet.
 * Cheap to call on every request — only hits R2 on cache miss.
 */
export async function restoreIfNeeded(
  sandbox: Sandbox,
  bucket: R2Bucket,
  agentName: string,
): Promise<void> {
  const keys = keysFor(agentName);
  if (restoredInThisIsolate) {
    // Cross-isolate invalidation: check the marker.
    const marker = await bucket.head(keys.restoreNeeded);
    if (!marker) return;
    console.log("[persistence] restore-needed marker found, re-restoring");
    restoredInThisIsolate = false;
  }

  const handle = await getStoredHandle(bucket, keys.handle);
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
    await assertTreeHealthy(sandbox, `restore ${handle.id}`);
    await bucket.delete(keys.restoreNeeded);
    restoredInThisIsolate = true;
    console.log(`[persistence] restored in ${Date.now() - t0}ms`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/BACKUP_EXPIRED|BACKUP_NOT_FOUND|BackupExpiredError|BackupNotFoundError/.test(msg)) {
      console.log(`[persistence] backup ${handle.id} gone, clearing handle`);
      await deleteStoredHandle(bucket, keys.handle);
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
  agentName: string,
  retentionDays: number,
): Promise<BackupHandle> {
  const keys = keysFor(agentName);
  await assertTreeHealthy(sandbox, "pre-snapshot check");
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
  // localBucket: write/read the squashfs through the bound BACKUP_BUCKET R2
  // binding instead of presigned URLs. This is what makes snapshots zero-setup
  // — no R2 API token, CLOUDFLARE_ACCOUNT_ID, or R2_ACCESS_KEY secrets needed;
  // the binding is always present. restoreBackup reads this mode off the
  // handle, so restores stay consistent with how the backup was written.
  const handle = await sandbox.createBackup({ dir: BACKUP_DIR, ttl, localBucket: true });
  const createdAt = new Date().toISOString();
  console.log(`[persistence] snapshot ${handle.id} created in ${Date.now() - t0}ms`);

  // Append to the index, then prune entries older than the retention window.
  const index = await getIndex(bucket, keys.index);
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
  await putIndex(bucket, keys.index, kept);
  await storeHandle(bucket, keys.handle, handle); // newest = restore target
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
  agentName: string,
  maxAgeMs: number,
  retentionDays: number,
): Promise<boolean> {
  const meta = await bucket.head(keysFor(agentName).handle);
  if (meta && Date.now() - meta.uploaded.getTime() < maxAgeMs) return false;
  await createSnapshot(sandbox, bucket, agentName, retentionDays);
  return true;
}

/** Force every Worker isolate to re-restore on its next request. */
export async function signalRestoreNeeded(bucket: R2Bucket, agentName: string): Promise<void> {
  restoredInThisIsolate = false;
  await bucket.put(keysFor(agentName).restoreNeeded, "1");
}
