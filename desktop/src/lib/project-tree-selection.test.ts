import { describe, expect, it } from "vitest";
import { projectSelectionRange, projectSelectionRoots } from "./project-tree-selection";

describe("project tree multi-selection", () => {
  it("selects visible inclusive ranges in both directions, excluding the workspace root", () => {
    const paths = ["", "a", "b", "b/child", "c"];
    expect(projectSelectionRange(paths, "a", "c")).toEqual(["a", "b", "b/child", "c"]);
    expect(projectSelectionRange(paths, "c", "a")).toEqual(["a", "b", "b/child", "c"]);
    expect(projectSelectionRange(paths, "missing", "b")).toEqual(["b"]);
    expect(projectSelectionRange(paths, "a", "missing")).toEqual([]);
    expect(projectSelectionRange(paths, "", "a")).toEqual(["a"]);
  });
  it("deduplicates selected roots without losing similarly prefixed siblings", () => {
    const folder = { name: "dir", path: "dir", kind: "directory" as const };
    const child = { name: "file", path: "dir/file", kind: "file" as const };
    const sibling = { name: "sibling", path: "dir-sibling", kind: "file" as const };
    expect(projectSelectionRoots([child, folder, sibling, folder])).toEqual([folder, sibling]);
  });
});
