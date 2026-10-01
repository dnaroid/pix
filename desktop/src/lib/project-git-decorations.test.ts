import { describe, expect, it } from "vitest";
import type { GitFileChange } from "./git";
import { projectGitDecorations } from "./project-git-decorations";

function change(path: string, overrides: Partial<GitFileChange> = {}): GitFileChange {
  return { path, indexStatus: ".", worktreeStatus: "M", staged: false,
    unstaged: true, untracked: false, conflicted: false, ...overrides };
}

describe("Project Explorer Git decorations", () => {
  it.each(["M", "A", "D", "R", "C", "T"])("decorates staged and unstaged %s", (code) => {
    expect(projectGitDecorations([change("file", { worktreeStatus: code })]).files.get("file")?.code).toBe(code);
    expect(projectGitDecorations([change("file", { indexStatus: code, worktreeStatus: ".", staged: true, unstaged: false })]).files.get("file")?.code).toBe(code);
  });

  it("gives working-tree changes precedence and describes both scopes", () => {
    const value = projectGitDecorations([change("file", { indexStatus: "A", staged: true })]).files.get("file");
    expect(value).toMatchObject({ code: "M", label: "Added (staged); Modified (working tree)" });
  });

  it("distinguishes untracked and conflicted files using semantic colors", () => {
    const { files } = projectGitDecorations([
      change("new", { untracked: true }), change("conflict", { conflicted: true }),
      change("deleted", { worktreeStatus: "D" }),
    ]);
    expect(files.get("new")).toMatchObject({ code: "U", label: "Untracked", color: "text-tool-success" });
    expect(files.get("conflict")).toMatchObject({ code: "!", label: "Conflict", color: "text-tool-error" });
    expect(files.get("deleted")).toMatchObject({ code: "D", color: "text-tool-warning" });
  });

  it("aggregates all ancestors including collapsed folders without prefix collisions", () => {
    const { directories, files } = projectGitDecorations([change("src/nested/file"), change("src-other/file")]);
    expect([...directories.keys()]).toEqual(["src/nested", "src", "src-other"]);
    expect(directories.get("src")).toMatchObject({ code: "M", label: "Contains Git changes" });
    expect(directories.has("sr")).toBe(false);
    expect(files.has("src")).toBe(false);
  });

  it("keeps conflict priority independent of input order", () => {
    const conflict = change("dir/conflict", { conflicted: true });
    const modified = change("dir/modified");
    for (const changes of [[conflict, modified], [modified, conflict]]) {
      expect(projectGitDecorations(changes).directories.get("dir")).toMatchObject({ label: "Contains conflicts", color: "text-tool-error" });
    }
  });

  it("marks old rename parents but not copy sources or nonexistent old files", () => {
    const renamed = change("new/file", { indexStatus: "R", staged: true, originalPath: "old/file" });
    expect(projectGitDecorations([renamed]).directories.has("old")).toBe(true);
    expect(projectGitDecorations([renamed]).files.has("old/file")).toBe(false);
    expect(projectGitDecorations([{ ...renamed, indexStatus: "C" }]).directories.has("old")).toBe(false);
  });

  it("clears decorations for clean/unavailable snapshots and never leaks previous maps", () => {
    const previous = projectGitDecorations([change("src/file")]);
    const next = projectGitDecorations();
    expect(next.files.size).toBe(0);
    expect(next.directories.size).toBe(0);
    expect(previous.files.size).toBe(1);
  });
});
