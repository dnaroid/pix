import type { IdxCommandResult } from "./idx";
import type { SearchIndexQuery } from "./universal-search";

const tails = new Map<string, Promise<void>>();
const lockBusy = /Lock file is already being held|Indexing is already in progress/iu;
export const snapshotLockBusy = (error: unknown): boolean => lockBusy.test(String(error));

function wait<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Keep an uncancelable native invocation owned until it finishes, even after UI cancellation. */
export function querySnapshot(
  workspace: string, query: SearchIndexQuery, signal: AbortSignal,
  invoke: (workspace: string, query: SearchIndexQuery) => Promise<IdxCommandResult>,
): Promise<IdxCommandResult> {
  const previous = tails.get(workspace) ?? Promise.resolve();
  const operation = previous.then(async () => {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try {
        const response = await invoke(workspace, query);
        signal.throwIfAborted();
        if (attempt === 2 || response.exitCode === 0 || !lockBusy.test(response.stderr || response.stdout)) return response;
      } catch (error) {
        signal.throwIfAborted();
        if (attempt === 2 || !snapshotLockBusy(error)) throw error;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await wait(new Promise<void>(resolve => { timer = setTimeout(resolve, 150 * (attempt + 1)); }), signal); }
      finally { clearTimeout(timer); }
    }
  });
  const tail = operation.then(() => {}, () => {});
  tails.set(workspace, tail);
  void tail.then(() => { if (tails.get(workspace) === tail) tails.delete(workspace); });
  return wait(operation, signal);
}
