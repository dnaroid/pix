import { describe, expect, it } from "vitest";
import {
  MAX_RECENT_PROJECTS,
  buildRecentProjects,
  parseRecentProjects,
  projectWindowRoute,
  projectWindowUrl,
  projectFolderHue,
  projectName,
  workspaceFromLocation,
} from "./recent-projects";

describe("recent projects", () => {
  it("puts the selected project first, deduplicates paths, and keeps at most 20", () => {
    const paths = Array.from({ length: MAX_RECENT_PROJECTS + 5 }, (_, index) => `/projects/project-${index}`);
    expect(buildRecentProjects(paths, "/projects/project-4")).toEqual([
      "/projects/project-4",
      ...paths.filter((path) => path !== "/projects/project-4").slice(0, MAX_RECENT_PROJECTS - 1),
    ]);
  });

  it("ignores malformed storage and non-absolute entries", () => {
    expect(parseRecentProjects("not json", "/projects/current")).toEqual(["/projects/current"]);
    expect(parseRecentProjects(JSON.stringify(["relative", "/projects/valid", 42]))).toEqual(["/projects/valid"]);
  });

  it("handles Unix, Windows, and UNC project names", () => {
    expect(projectName("/projects/pix")).toBe("pix");
    expect(projectName("C:\\projects\\pix")).toBe("pix");
    expect(projectName("\\\\server\\projects\\pix")).toBe("pix");
  });

  it("derives a stable folder hue from the project name", () => {
    expect(projectFolderHue("/one/pix")).toBe(projectFolderHue("/another/pix"));
    expect(projectFolderHue("/one/pix")).not.toBe(projectFolderHue("/one/other"));
    expect(projectFolderHue("/one/pix")).toBeGreaterThanOrEqual(0);
    expect(projectFolderHue("/one/pix")).toBeLessThan(360);
  });

  it("round-trips a window-scoped project through the app URL", () => {
    const url = projectWindowUrl("http://localhost:1420/?debug=1#old", "/projects/pix next");
    expect(workspaceFromLocation(url)).toBe("/projects/pix next");
    expect(new URL(url).searchParams.get("debug")).toBe("1");
    expect(new URL(url).hash).toBe("");
    expect(projectWindowRoute(url, "/projects/other")).toBe("/?debug=1&workspace=%2Fprojects%2Fother");
  });

  it("ignores invalid project paths in window URLs", () => {
    expect(workspaceFromLocation("http://localhost/?workspace=relative/project")).toBeUndefined();
  });
});
