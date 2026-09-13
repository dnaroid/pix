import { describe, expect, it } from "vitest";
import explorerSource from "./ProjectExplorer.svelte?raw";
import treeControllerSource from "./project-explorer-tree-controller.svelte.ts?raw";

describe("ProjectExplorer keyboard tree", () => {
  it("uses tree semantics with one roving tab stop", () => {
    expect(explorerSource).toContain('role="tree"');
    expect(explorerSource).toContain('role="treeitem"');
    expect(explorerSource).toContain("tabindex={tabbablePath === entry.path ? 0 : -1}");
    expect(explorerSource).toContain("aria-level={row.depth + 1}");
  });

  it("supports IDE tree navigation and a keyboard route to the external editor", () => {
    expect(treeControllerSource).toContain('event.key === "ArrowRight"');
    expect(treeControllerSource).toContain('event.key === "ArrowLeft"');
    expect(treeControllerSource).toContain("projectTreeParentIndex(visibleRows, index)");
    expect(explorerSource).toContain('aria-keyshortcuts="Shift+Enter"');
    expect(treeControllerSource).toContain("typeaheadFocusIndex");
  });

  it("keeps dotfiles and dotfolders visible but visually muted", () => {
    expect(explorerSource).not.toContain('filter((entry) => !entry.name.startsWith("."))');
    expect(explorerSource).toContain('entry.name.startsWith(".")');
    expect(explorerSource).toContain("opacity-55 transition-opacity hover:opacity-100 focus-visible:opacity-100");
  });
});
