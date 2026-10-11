import { renameSync, rmSync, unlinkSync } from "node:fs";

const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Bounded filesystem retries for fixture removal, unlink and rename.
 * Bun's default SQLite close uses sqlite3_close_v2: uncached prepare() statements
 * can retain the native handle until GC even after their JS owners closed it.
 * Waiting alone need not trigger GC, so Windows keeps returning EBUSY. Collect
 * only unreachable statements on a retryable failure; never force-close live
 * resources or put a synchronous GC in production/UI code. Node closes its
 * SQLite statements with the connection and needs no such collection. */
export async function withFilesystemRetry(operation, attempts = 50, delayMs = 100) {
  for (let attempt = 1; ; attempt++) {
    try {
      operation();
      return;
    } catch (error) {
      if (attempt >= attempts || !RETRYABLE.has(error?.code ?? "")) throw error;
      globalThis.Bun?.gc(true);
      await sleep(delayMs);
    }
  }
}

/** Drain the fixture roots only after their owned connections/workers close. */
export async function removeDirsWithRetry(roots, attempts = 50, delayMs = 100) {
  await Promise.all(roots.splice(0).map(root => withFilesystemRetry(() => rmSync(root, { recursive: true, force: true }), attempts, delayMs)));
}

export function unlinkWithRetry(filename, attempts = 50, delayMs = 100) {
  return withFilesystemRetry(() => unlinkSync(filename), attempts, delayMs);
}

export function renameWithRetry(from, to, attempts = 50, delayMs = 100) {
  return withFilesystemRetry(() => renameSync(from, to), attempts, delayMs);
}
