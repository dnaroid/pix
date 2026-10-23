import { describe, expect, it } from "vitest";
import nativeSource from "../../src-tauri/src/lib.rs?raw";
import { projectEntryEmphasis } from "./project-entry-emphasis";
import type { ProjectTreeEntryKind } from "./project-tree";

function emphasis(path: string, kind: ProjectTreeEntryKind = "file") {
  return projectEntryEmphasis({ path, name: path.split("/").at(-1) ?? "", kind });
}

function nativeAllowlist(name: string): string[] {
  const body = nativeSource.match(new RegExp(`const ${name}: &[\\s\\S]*?= &\\[([\\s\\S]*?)\\];`))?.[1];
  expect(body).toBeDefined();
  return [...body!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

describe("Project Explorer Pix emphasis", () => {
  it("marks only the workspace .pi directory and root instructions", () => {
    expect(emphasis(".pi", "directory")).toBe("Pix project configuration");
    expect(emphasis("AGENTS.md")).toBe("Project agent instructions");
    for (const path of ["", "app/AGENTS.md", "app/.pi", ".pi-backup", "agents.md"]) {
      expect(emphasis(path)).toBeUndefined();
      expect(emphasis(path, "directory")).toBeUndefined();
    }
    expect(emphasis(".pi")).toBeUndefined();
    expect(emphasis("AGENTS.md", "directory")).toBeUndefined();
  });

  it("matches native canonical files and durable directories", () => {
    for (const name of nativeAllowlist("PROJECT_PI_CANONICAL_FILES")) {
      expect(emphasis(`.pi/${name}`), name).toBe("Canonical Pix project state");
      expect(emphasis(`.pi/${name}`, "directory"), name).toBeUndefined();
    }
    const disposable = nativeAllowlist("PROJECT_PI_EPHEMERAL_DIRECTORIES");
    for (const name of nativeAllowlist("PROJECT_PI_CANONICAL_DIRECTORIES")) {
      expect(Boolean(emphasis(`.pi/${name}`, "directory")), name).toBe(!disposable.includes(name));
      expect(emphasis(`.pi/${name}`), name).toBeUndefined();
    }
  });

  it("does not accent scratch, unknown entries, or whole descendant trees", () => {
    expect(nativeAllowlist("PROJECT_PI_CANONICAL_FILES")).not.toContain("TODO.md");
    expect(emphasis(".pi/TODO.md")).toBeUndefined();
    for (const path of [".pi/artifacts", ".pi/subagents", ".pi/tasks.d", ".pi/unknown.json", ".pi/.scratch", ".pi/search-sources.json", ".pi/skills/demo/SKILL.md", ".pi/artifacts/AGENTS.md", "app/.pi/plans", ".pi/plans-old"]) {
      expect(emphasis(path), path).toBeUndefined();
      expect(emphasis(path, "directory"), path).toBeUndefined();
    }
  });
});
