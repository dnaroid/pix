import { describe, expect, it } from "vitest";
import {
  flattenProjectTree,
  insertProjectTreePromptPath,
  parseProjectTreeDrag,
  projectTreePromptPath,
  serializeProjectTreeDrag,
  type ProjectTreeEntry,
} from "./project-tree";

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

  it("round-trips only workspace-relative drag payloads", () => {
    const entry: ProjectTreeEntry = { name: "App.svelte", path: "desktop/src/App.svelte", kind: "file" };
    expect(parseProjectTreeDrag(serializeProjectTreeDrag(entry))).toEqual({
      path: "desktop/src/App.svelte",
      kind: "file",
    });
    expect(parseProjectTreeDrag(JSON.stringify({ version: 1, path: "../secret", kind: "file" }))).toBeUndefined();
    expect(parseProjectTreeDrag(JSON.stringify({ version: 1, path: "/tmp/secret", kind: "file" }))).toBeUndefined();
  });

  it("inserts file and folder references as relative prompt paths", () => {
    expect(projectTreePromptPath({ path: "desktop/src", kind: "directory" })).toBe("`desktop/src/`");
    expect(projectTreePromptPath({ path: "desktop/src/App.svelte", kind: "file" })).toBe("`desktop/src/App.svelte`");

    expect(insertProjectTreePromptPath(
      "review this please",
      7,
      7,
      { path: "desktop/src/App.svelte", kind: "file" },
    )).toEqual({
      text: "review `desktop/src/App.svelte` this please",
      cursor: 32,
    });

    expect(insertProjectTreePromptPath(
      "check",
      5,
      5,
      { path: "desktop/src", kind: "directory" },
    )).toEqual({
      text: "check `desktop/src/`",
      cursor: 20,
    });
  });
});
