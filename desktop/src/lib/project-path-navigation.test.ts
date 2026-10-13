import { describe, expect, it, vi } from "vitest";
import { scopedProjectPathNavigation, workspaceRelativePath } from "./project-path-navigation";

describe("subagent project links", () => {
  it("normalizes current-project absolute paths and rejects escapes and other projects", () => {
    expect(workspaceRelativePath("/project/.pi/subagents/run", "/project/")).toBe(".pi/subagents/run");
    expect(workspaceRelativePath("src/a.ts", "/project")).toBe("src/a.ts");
    for (const path of ["/project-other/file", "/other/file", "../file", "src/../../file", "https://example.com", "~/file", "file\0name"]) {
      expect(workspaceRelativePath(path, "/project")).toBeUndefined();
    }
  });
  it("passes relative paths and kinds to validation and navigation", async () => {
    const validate = vi.fn(async () => true);
    const open = vi.fn(async () => {});
    const nav = scopedProjectPathNavigation("/project", () => true, { validate, open });
    expect(await nav.validate("/project/.pi/run", "directory")).toBe(true);
    expect(validate).toHaveBeenCalledWith(".pi/run", "directory");
    await nav.open("/project/src/a.ts");
    expect(open).toHaveBeenCalledWith("src/a.ts");
    expect(await nav.validate("/other/file", "file")).toBe(false);
    await nav.open("/other/file");
    expect(open).toHaveBeenCalledTimes(1);
  });
  it("discards validation after a session/workspace switch and cannot open stale links", async () => {
    let current = true;
    let complete!: (value: boolean) => void;
    const validate = vi.fn(() => new Promise<boolean>((resolve) => { complete = resolve; }));
    const open = vi.fn(async () => {});
    const nav = scopedProjectPathNavigation("/project", () => current, { validate, open });
    const pending = nav.validate("file", "file");
    current = false;
    complete(true);
    expect(await pending).toBe(false);
    expect(await nav.validate("file", "file")).toBe(false);
    await nav.open("file");
    expect(open).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledTimes(1);
  });
});
