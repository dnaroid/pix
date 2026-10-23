import type { GitSnapshot } from "./git";

/** Only state consumed by Activity Bar Git indicators and remote freshness. */
export function sidebarGitSignature(snapshot: GitSnapshot | undefined, error: string | null): string {
  return JSON.stringify([
    error,
    snapshot ? [
      snapshot.branch, snapshot.head, snapshot.upstream, snapshot.detached,
      snapshot.ahead, snapshot.behind, snapshot.changes.length > 0,
      snapshot.changes.some((change) => change.conflicted),
    ] : null,
  ]);
}
