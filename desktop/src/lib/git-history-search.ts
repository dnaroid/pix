import type { GitHistoryEntry } from "./git-workflow";

type Invoke = <T>(command: string, args: Record<string, unknown>) => Promise<T>;

/** Full-history commit search; aborting the signal also kills the backend `git log` walk. */
export async function searchGitHistory(invoke: Invoke, workspace: string, query: string,
  signal: AbortSignal): Promise<GitHistoryEntry[]> {
  signal.throwIfAborted();
  const requestId = crypto.randomUUID();
  // The backend keeps a short-lived tombstone, so a cancel that overtakes its search still applies.
  const cancel = () => { void invoke("git_search_history_cancel", { requestId }).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const entries = await invoke<GitHistoryEntry[]>("git_search_history", { workspace, query, requestId });
    signal.throwIfAborted();
    return entries;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
