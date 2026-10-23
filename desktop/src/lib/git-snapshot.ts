import type { GitFileChange, GitSnapshot } from "./git";

const changeFields = [
  "path", "originalPath", "indexStatus", "worktreeStatus", "staged", "unstaged",
  "untracked", "conflicted", "stagedAdditions", "stagedDeletions",
  "unstagedAdditions", "unstagedDeletions",
] as const satisfies readonly (keyof GitFileChange)[];

/** Keep equal polls from replacing reactive snapshots/decorations. */
export function sameGitSnapshot(previous: GitSnapshot | undefined, next: GitSnapshot): boolean {
  if (!previous) return false;
  return previous.branch === next.branch && previous.head === next.head
    && previous.upstream === next.upstream && previous.detached === next.detached
    && previous.ahead === next.ahead && previous.behind === next.behind
    && previous.remotes.length === next.remotes.length
    && previous.remotes.every((remote, index) => remote === next.remotes[index])
    && previous.branches.length === next.branches.length
    && previous.branches.every((branch, index) => {
      const other = next.branches[index]!;
      return branch.name === other.name && branch.upstream === other.upstream && branch.current === other.current;
    })
    && previous.changes.length === next.changes.length
    && previous.changes.every((change, index) => changeFields.every((key) => change[key] === next.changes[index]![key]));
}
