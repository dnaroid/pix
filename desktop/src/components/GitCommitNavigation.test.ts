import { describe, expect, it } from "vitest";
import app from "../App.svelte?raw";
import search from "./UniversalSearch.svelte?raw";
import sidebar from "./WorkspaceSidebar.svelte?raw";
import diffPane from "./GitDiffPane.svelte?raw";
import gitPanel from "./GitPanel.svelte?raw";
import logPanel from "./GitRepositoryTools.svelte?raw";
import workbench from "../app/desktop-workbench-prop-builders.ts?raw";

describe("search result -> Source Control -> historical Git Diff", () => {
  it("does not trap commit clicks inside the universal search dialog", () => {
    expect(search).not.toContain("if (hit.kind === \"commits\") { selectedCommit = hit; return; }");
    expect(search).not.toContain("selectedCommit");
    expect(search).toContain("await onSelect(hit)");
    expect(app).toContain("gitWorkspace.openCommitDiff(hit.hash, isCurrent)");
    expect(app).toContain("workspaceSidebar.openGitPanel(isCurrent)");
    expect(sidebar).toContain('setActiveTab("git")');
    expect(sidebar).toContain('export function openGitPanel(isCurrent: () => boolean');
  });

  it("keeps Git commit details in Source Control and reuses the editor diff surface", () => {
    expect(gitPanel).toContain('aria-label="Selected Git commit"');
    expect(gitPanel).toContain("workflow.selectedCommit.hash");
    expect(gitPanel).toContain("workflow.onShowCommitDiff");
    expect(logPanel).toContain("workflow.onOpenCommit(entry.hash)");
    expect(logPanel).toContain("View diff for commit");
    expect(diffPane).toContain('diff.commit ? "Commit"');
    expect(diffPane).toContain("{#if !diff.commit}");
    expect(diffPane).toContain('diff.content.split("\\n")');
    expect(workbench).toContain("!gitDiffPreview.commit");
  });
});
