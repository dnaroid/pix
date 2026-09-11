import { describe, expect, it } from "vitest";
import source from "./SessionTabs.svelte?raw";

describe("SessionTabs desktop interaction", () => {
  it("uses a roving ARIA tablist and a separate conversation picker", () => {
    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain("aria-selected={active}");
    expect(source).toContain('aria-controls="conversation-workspace"');
    expect(source).toContain("sessionTabFocusIndex(index, event.key, sessions.length)");
    expect(source).toContain("data-session-picker");
  });

  it("keeps pointer close outside the normal Tab sequence and supports Delete", () => {
    expect(source).toContain('tabindex="-1"');
    expect(source).toContain('event.key !== "Delete"');
  });
});
