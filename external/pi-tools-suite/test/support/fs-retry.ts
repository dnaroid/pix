import { renameSync, rmSync, unlinkSync } from "node:fs";

const RETRYABLE = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Windows keeps filesystem locks on files and directories owned by freshly
 * closed SQLite WAL handles for a short while after close(), so immediate
 * removal, unlink or rename of those paths can fail transiently with
 * EBUSY/EPERM. Retry a bounded number of times, then rethrow the last error. */
async function withRetry(operation: () => void, attempts: number, delayMs: number): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      operation();
      return;
    } catch (error) {
      if (attempt >= attempts || !RETRYABLE.has((error as NodeJS.ErrnoException)?.code ?? "")) throw error;
      await sleep(delayMs);
    }
  }
}

/** Removes every root recursively, draining the array like the existing
 * afterEach cleanup loops, retrying transient Windows lock errors. */
export async function removeDirsWithRetry(roots: string[], attempts = 20, delayMs = 50): Promise<void> {
  await Promise.all(roots.splice(0).map(root => withRetry(() => rmSync(root, { recursive: true, force: true }), attempts, delayMs)));
}

export function unlinkWithRetry(filename: string, attempts = 20, delayMs = 50): Promise<void> {
  return withRetry(() => unlinkSync(filename), attempts, delayMs);
}

export function renameWithRetry(from: string, to: string, attempts = 20, delayMs = 50): Promise<void> {
  return withRetry(() => renameSync(from, to), attempts, delayMs);
}
