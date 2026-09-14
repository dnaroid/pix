import { describe, expect, it } from "vitest";
import {
  RECENT_PROJECTS_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
} from "../lib/recent-projects";
import { restoreProjectWorkspace } from "./project-workspace.svelte";

describe("project workspace startup restore", () => {
  it("gives an encoded URL workspace precedence over stale localStorage", () => {
    const restored = restoreProjectWorkspace(
      "http://127.0.0.1:1420/?workspace=%2Fqa%2Fproject%20with%20spaces",
      {
        getItem(key) {
          if (key === WORKSPACE_STORAGE_KEY) return "/stale/project";
          if (key === RECENT_PROJECTS_STORAGE_KEY) return JSON.stringify(["/stale/project"]);
          return null;
        },
      },
    );

    expect(restored.workspace).toBe("/qa/project with spaces");
    expect(restored.recentProjects).toEqual(["/qa/project with spaces", "/stale/project"]);
  });

  it("preserves a valid URL workspace when localStorage is unavailable", () => {
    const restored = restoreProjectWorkspace("http://127.0.0.1:1420/?workspace=%2Fqa%2Fproject", {
      getItem() {
        throw new Error("storage disabled");
      },
    });

    expect(restored.workspace).toBe("/qa/project");
    expect(restored.recentProjects).toEqual(["/qa/project"]);
    expect(restored.activeSessionIds).toEqual(new Map());
  });
});
