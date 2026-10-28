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
  it("reserves local sources in mixed Finder batches and respects path boundaries", () => {
    const claims = projectFileRequestClaims({ type: "copy", paths: ["project/docs", "project-other/file", "other/a"], destination: "target", sourceWorkspace: "/" }, "/project");
    expect(claims).toEqual([{ path: "target", kind: "tree" }, { path: "docs", kind: "tree" }]);
    const operations = createProjectExplorerOperations();
    operations.begin("paste", claims);
    expect(operations.canStart([{ path: "docs/a", kind: "tree" }])).toBe(false);
    expect(operations.canStart([{ path: "unrelated", kind: "tree" }])).toBe(true);
  });
  it("reserves local sources and the complete destination for Cmd import moves", () => {
    const claims = projectFileRequestClaims({ type: "importMove", paths: ["project/docs", "outside/a"], sourceWorkspace: "/", destination: "target" }, "/project");
    expect(claims).toEqual([{ path: "target", kind: "tree" }, { path: "docs", kind: "tree" }]);
  });
});
