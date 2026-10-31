import { describe, expect, it } from "vitest";
import panel from "./ProjectWikiPanel.svelte?raw";
import search from "./ProjectWikiSearch.svelte?raw";
import tree from "./ProjectWikiTree.svelte?raw";
import preview from "./PreviewPane.svelte?raw";

describe("Wiki search integration", () => {
  it("replaces the redundant home row and configuration footer with scoped search", () => {
    expect(panel).toContain('<ProjectWikiSearch {workspace} path={config.path}');
    expect(panel).toContain("<ProjectWikiTree");
    expect(panel).not.toContain("Wiki home</span>");
    expect(panel).not.toContain("<footer");
    expect(panel).not.toContain("Folder and index are configured");
    expect(panel).toContain("Create index");
    expect(panel).toContain("Automatic contents");
    expect(panel).not.toContain("No index page");
  });

  it("opens folders without indexes in Preview and prevents fake file actions", () => {
    expect(tree).toContain("onMissingIndex: (path) => onOpenFile(projectPath(path))");
    expect(tree).toContain('if (activePath === config.path) path = ""');
    expect(preview).toContain("editable: () => editable && !file?.virtualWikiDirectory");
    expect(preview).toContain("file && !file.virtualWikiDirectory");
  });

  it("submits explicitly, cancels edits, restores the mounted tree and supports Escape", () => {
    expect(search).toContain('role="search" aria-label="Wiki search"');
    expect(search).toContain('requests?.submit(query, ["knowledge"])');
    expect(search).toContain("oninput={() => requests?.invalidate()}");
    expect(search).toContain('event.key === "Escape"');
    expect(search).toContain("input.focus()");
    expect(search).toContain('class:hidden={searching}');
    expect(search).toContain("{@render children()}");
    expect(search).toContain("onOpenFile(hit.path, { startLine: hit.startLine, endLine: hit.endLine })");
    expect(search).toContain('aria-current={hit.path === activePath ? "page" : undefined}');
  });

  it("disposes its owner on workspace/config changes and removes policy listeners", () => {
    expect(search).toContain("const target = searchWorkspace, directory = searchDirectory");
    expect(search).toContain("next.dispose()");
    expect(search).toContain("window.removeEventListener(SEARCH_SOURCE_SELECTION_CHANGED, invalidate)");
    expect(search).toContain('window.removeEventListener("pix-semantic-config-changed", invalidate)');
    expect(search).toContain('diagnostics.warn("wiki:search-notice", notice)');
    expect(search).toContain('aria-live="polite"');
    expect(search).toContain("aria-busy={busy}");
  });
});
