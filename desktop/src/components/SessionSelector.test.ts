import { describe, expect, it } from "vitest";
import source from "./SessionSelector.svelte?raw";
import rowSource from "./SavedSessionRow.svelte?raw";

describe("SessionSelector opening and outside dismissal", () => {
  it("resolves highlighted ancestry from current rows and keeps pointer/focus separate", () => {
    expect(source).toContain("displayedSessions.find((row) => row.session.sessionId === (hoveredId ?? focusedId))");
    expect(source).toContain('if (source === "pointer")');
    expect(source).toContain("if (active || hoveredId === id)");
    expect(source).toContain("else if (active || focusedId === id)");
  });
  it("uses pointerdown for outside dismissal so the opening click cannot immediately close it", () => {
    expect(source).toContain("onpointerdown={handleWindowPointerDown}");
    expect(source).not.toContain("onclick={handleWindowClick}");
  });

  it("lets the titlebar picker button own its open/close toggle", () => {
    expect(source).toContain('target.closest("[data-session-picker]")');
  });

  it("marks forked saved conversations with the branch icon", () => {
    expect(rowSource).toContain("row.depth === 0 && sessionIsFork(row.session)");
    expect(rowSource).toContain("GitFork");
  });

  it("uses the shared tree without a query and leaves search results flat", () => {
    expect(source).toContain("if (!query.trim()) return expandedSessionRows(buildSessionTree(sessions), collapsed)");
    expect(source).toContain("flatSessionRow(match.value)");
  });
});
