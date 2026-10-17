import { describe, expect, it } from "vitest";
import { searchRecentProjects } from "./project-switcher-search";

const projects = ["/work/smart-clock", "/work/pi-ui-extend", "/archive/game-tactical"];

describe("recent project search", () => {
  it("preserves recency for empty and whitespace queries", () => {
    expect(searchRecentProjects(projects, "")).toEqual(projects);
    expect(searchRecentProjects(projects, "  ")).toEqual(projects);
  });

  it("matches non-contiguous name characters without case sensitivity", () => {
    expect(searchRecentProjects(projects, "PIUE")).toEqual([projects[1]]);
  });

  it("searches parent directories as well as project names", () => {
    expect(searchRecentProjects(projects, "archive")).toEqual([projects[2]]);
  });

  it("ranks the strongest name match first", () => {
    expect(searchRecentProjects(["/work/something-clock", "/work/smart-clock"], "smart")[0]).toBe("/work/smart-clock");
  });

  it("returns no projects for an unmatched query", () => {
    expect(searchRecentProjects(projects, "zzzzzz")).toEqual([]);
  });
});
