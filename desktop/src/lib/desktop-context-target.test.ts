import { describe, expect, it } from "vitest";
import { relativeImagePath } from "./desktop-context-target";

describe("workspace-relative image paths", () => {
  it("preserves spaces and handles outside-workspace paths without prefix confusion", () => {
    expect(relativeImagePath("/project/assets/my chart.png", "/project/")).toBe("assets/my chart.png");
    expect(relativeImagePath("/projects/chart.png", "/project")).toBe("../projects/chart.png");
    expect(relativeImagePath("/tmp/chart.png", "/project/nested")).toBe("../../tmp/chart.png");
    expect(relativeImagePath("/tmp/chart.png", "")).toBeUndefined();
    expect(relativeImagePath("https://example.com/chart.png", "/project")).toBeUndefined();
  });
});
