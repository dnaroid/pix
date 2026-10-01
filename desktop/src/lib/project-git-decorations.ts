import { gitChangeCode, gitChangeLabel, type GitFileChange } from "./git";

export interface ProjectGitDecoration {
  readonly code: string;
  readonly label: string;
  readonly color: string;
}

function decoration(change: GitFileChange): ProjectGitDecoration {
  const scope = change.unstaged ? "unstaged" : "staged";
  const code = gitChangeCode(change, scope);
  const labels: string[] = [];
  if (change.conflicted || change.untracked) labels.push(gitChangeLabel(change, scope));
  else {
    if (change.staged) labels.push(`${gitChangeLabel(change, "staged")} (staged)`);
    if (change.unstaged) labels.push(`${gitChangeLabel(change, "unstaged")} (working tree)`);
  }
  return {
    code,
    label: labels.join("; "),
    color: decorationColor(code),
  };
}

function decorationColor(code: string): string {
  if (code === "!") return "text-tool-error";
  if (code === "A" || code === "U") return "text-tool-success";
  if (code === "D") return "text-tool-warning";
  return "text-tool-info";
}

/** Index once per snapshot, not once per row; no filesystem traversal is needed. */
export function projectGitDecorations(changes: readonly GitFileChange[] = []): {
  files: Map<string, ProjectGitDecoration>;
  directories: Map<string, ProjectGitDecoration>;
} {
  const files = new Map<string, ProjectGitDecoration>();
  const directories = new Map<string, ProjectGitDecoration>();
  function markParents(path: string, value: ProjectGitDecoration): void {
    for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
      const parent = path.slice(0, slash);
      const previous = directories.get(parent);
      // Conflicts take precedence; otherwise folders use a neutral changed color.
      if (!previous || value.code === "!") directories.set(parent, {
        code: value.code === "!" ? "!" : "M",
        label: value.code === "!" ? "Contains conflicts" : "Contains Git changes",
        color: value.code === "!" ? "text-tool-error" : "text-tool-info",
      });
    }
  }
  for (const change of changes) {
    const value = decoration(change);
    files.set(change.path, value);
    markParents(change.path, value);
    // A moved file also changes the directory it was moved out of.
    if (change.originalPath && (change.indexStatus === "R" || change.worktreeStatus === "R")) {
      markParents(change.originalPath, value);
    }
  }
  return { files, directories };
}
