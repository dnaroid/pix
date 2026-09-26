import { describe, expect, it } from "vitest";
import {
  compactExpandedDirectories,
  MAX_STORED_EXPANDED_DIRECTORIES,
  projectExplorerExpandedDirectoriesFromWorkspaceConfig,
  workspaceConfigWithProjectExplorerExpandedDirectories,
} from "./project-explorer-expansion";

describe("project explorer expansion persistence", () => {
  it("round-trips a compact list in workspace.jsonc while preserving sibling settings and comments", () => {
    const source = `{
  // Project-local settings.
  "color": "#7aa2f7",
  "launchCommands": [],
}\n`;
    const next = workspaceConfigWithProjectExplorerExpandedDirectories(source, ["src", "src/app", "src"]);

    expect(next).toContain("// Project-local settings.");
    expect(next).toContain('"color": "#7aa2f7"');
    expect(next).toContain('"launchCommands": []');
    expect(next).toContain('"projectExplorer"');
    expect(next).toContain('"expandedDirectories"');
    expect(projectExplorerExpandedDirectoriesFromWorkspaceConfig(next)).toEqual(["src", "src/app"]);
  });

  it("removes empty state and rejects malformed workspace-owned fields instead of overwriting them", () => {
    const source = workspaceConfigWithProjectExplorerExpandedDirectories("{}\n", ["src"]);
    const cleared = workspaceConfigWithProjectExplorerExpandedDirectories(source, []);
    expect(projectExplorerExpandedDirectoriesFromWorkspaceConfig(cleared)).toEqual([]);
    expect(cleared).not.toContain("projectExplorer");

    expect(projectExplorerExpandedDirectoriesFromWorkspaceConfig("{")).toEqual([]);
    expect(() => workspaceConfigWithProjectExplorerExpandedDirectories("{", ["src"]))
      .toThrow("workspace.jsonc is malformed");
    expect(() => workspaceConfigWithProjectExplorerExpandedDirectories('{"projectExplorer":"bad"}', ["src"]))
      .toThrow("invalid projectExplorer field");
  });

  it("filters unsafe paths and bounds the persisted expansion list", () => {
    const paths = Array.from({ length: MAX_STORED_EXPANDED_DIRECTORIES + 20 }, (_, index) => `dir-${index}`);
    expect(compactExpandedDirectories(["src", "../outside", "/absolute", "src"])).toEqual(["src"]);
    expect(compactExpandedDirectories(paths)).toEqual(paths.slice(-MAX_STORED_EXPANDED_DIRECTORIES));
  });
});
