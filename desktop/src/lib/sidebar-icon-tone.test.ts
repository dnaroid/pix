import { describe, expect, it } from "vitest";
import { sidebarIconTone } from "./sidebar-icon-tone";

describe("sidebarIconTone", () => {
  it("keeps ordinary and informational states neutral", () => {
    expect(sidebarIconTone()).toBe("");
    expect(sidebarIconTone({ tone: "info", reason: "Syncing", animated: true })).toBe("");
  });

  it("colors only warning and error states", () => {
    expect(sidebarIconTone({ tone: "warning", reason: "Review" })).toBe("text-tool-warning");
    expect(sidebarIconTone({ tone: "error", reason: "Failed" })).toBe("text-tool-error");
  });
});
