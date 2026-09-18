import { describe, expect, it } from "vitest";
import source from "./SessionSelector.svelte?raw";

describe("SessionSelector opening and outside dismissal", () => {
  it("uses pointerdown for outside dismissal so the opening click cannot immediately close it", () => {
    expect(source).toContain("onpointerdown={handleWindowPointerDown}");
    expect(source).not.toContain("onclick={handleWindowClick}");
  });

  it("lets the titlebar picker button own its open/close toggle", () => {
    expect(source).toContain('target.closest("[data-session-picker]")');
  });

  it("marks forked saved conversations with the branch icon", () => {
    expect(source).toContain("!row.treePrefix && sessionIsFork(row.session)");
    expect(source).toContain("GitFork");
  });

  it("uses the shared tree without a query and leaves search results flat", () => {
    expect(source).toContain("if (!query.trim()) return buildSessionTree(sessions)");
    expect(source).toContain('treePrefix: ""');
  });
});
