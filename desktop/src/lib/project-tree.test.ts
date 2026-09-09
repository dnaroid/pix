import { describe, expect, it } from "vitest";
import { flattenProjectTree, type ProjectTreeEntry } from "./project-tree";

describe("project tree", () => {
  it("flattens only expanded directories", () => {
    const root: ProjectTreeEntry[] = [
      { name: "src", path: "src", kind: "directory" },
      { name: "README.md", path: "README.md", kind: "file" },
    ];
    const nested: ProjectTreeEntry[] = [{ name: "main.ts", path: "src/main.ts", kind: "file" }];
    expect(flattenProjectTree(root, { src: nested }, new Set()).map((row) => row.entry.path)).toEqual([
      "src",
      "README.md",
    ]);
    expect(flattenProjectTree(root, { src: nested }, new Set(["src"]))).toEqual([
      { entry: root[0], depth: 0 },
      { entry: nested[0], depth: 1 },
      { entry: root[1], depth: 0 },
    ]);
  });
});
