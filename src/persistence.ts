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
 * - The active backup handle lives at `backup-handle.json` in R2.
 */
const BACKUP_DIR = "/home/hermes";
const HANDLE_KEY = "backup-handle.json";
const RESTORE_NEEDED_KEY = "restore-needed";

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
 * Snapshot /home/hermes to R2. Replaces the previous backup atomically.
 */
export async function createSnapshot(
  sandbox: Sandbox,
  bucket: R2Bucket,
): Promise<BackupHandle> {
  // Ensure permissions are readable for mksquashfs.
  await sandbox.exec(`chmod -R a+rX ${BACKUP_DIR} 2>/dev/null; true`);

  // Delete previous objects to keep R2 usage bounded.
  const prev = await getStoredHandle(bucket);
  if (prev) {
    await bucket.delete(`backups/${prev.id}/data.sqsh`);
    await bucket.delete(`backups/${prev.id}/meta.json`);
  }

  console.log("[persistence] creating snapshot");
  const t0 = Date.now();
  // /home/hermes is ~100 MB now (Hermes install moved to /opt/hermes-install,
  // see Dockerfile), so default mksquashfs gzip finishes within the Worker
  // budget. An earlier version forced lz4 via `compression: { format: "lz4" }`
  // for speed when the tree was 1.5 GB — that option isn't in the SDK's
  // BackupOptions type and broke `npm run typecheck` (#10).
  const handle = await sandbox.createBackup({ dir: BACKUP_DIR });
  await storeHandle(bucket, handle);
  console.log(`[persistence] snapshot ${handle.id} created in ${Date.now() - t0}ms`);
  return handle;
}

/** Force every Worker isolate to re-restore on its next request. */
export async function signalRestoreNeeded(bucket: R2Bucket): Promise<void> {
  restoredInThisIsolate = false;
  await bucket.put(RESTORE_NEEDED_KEY, "1");
}
