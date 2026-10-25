import { describe, expect, it } from "vitest";
import { projectFileRequestClaims } from "./project-explorer-file-claims";
import { createProjectExplorerOperations } from "./project-explorer-operations.svelte";

describe("Files batch reservations", () => {
  it("reserves every move source, destination parent and exact destination without blocking siblings", () => {
    const operations = createProjectExplorerOperations();
    operations.begin("move", projectFileRequestClaims({ type: "move", paths: ["source/a", "source/b"], destination: "target" }, "/project"));
    for (const path of ["source/a", "source/b/child", "target", "target/a", "target/b"]) expect(operations.canStart([{ path, kind: "tree" }])).toBe(false);
    expect(operations.canStart([{ path: "target/c", kind: "tree" }])).toBe(true);
    expect(operations.canStart([{ path: "unrelated", kind: "tree" }])).toBe(true);
    expect(operations.canStart([{ path: "", kind: "tree" }])).toBe(false);
  });
  it("reserves copy destinations and same-workspace sources but not foreign paths", () => {
    expect(projectFileRequestClaims({ type: "copy", paths: ["file"], destination: "target", sourceWorkspace: "/foreign" }, "/project")).toEqual([{ path: "target", kind: "tree" }]);
    expect(projectFileRequestClaims({ type: "copy", paths: ["file"], destination: "target" }, "/project")).toContainEqual({ path: "file", kind: "tree" });
    expect(projectFileRequestClaims({ type: "delete", paths: ["a", "b"] }, "/project")).toHaveLength(2);
  });
});
