import { describe, expect, it } from "vitest";
import source from "./WorkspaceEditorTabs.svelte?raw";

describe("WorkspaceEditorTabs", () => {
  it("uses one roving-focus tablist for conversation and work surfaces", () => {
    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain('tabindex={active ? 0 : -1}');
    expect(source).toContain('linearFocusIndex(index, event.key, tabs.length, "horizontal", true)');
  });

  it("supports keyboard close with logical focus fallback", () => {
    expect(source).toContain('event.key !== "Delete"');
    expect(source).toContain("workspaceEditorCloseFallback(tabs, id)");
    expect(source).toContain("onFallbackFocus?.(fallbackId)");
  });
});
