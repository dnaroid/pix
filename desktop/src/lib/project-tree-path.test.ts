import { describe, expect, it } from "vitest";
import { projectTreeAbsolutePath } from "./project-tree";

describe("projectTreeAbsolutePath", () => {
  it.each([
    ["/Users/dev/project", "src/main.ts", "/Users/dev/project/src/main.ts"],
    ["/Users/dev/project/", "src", "/Users/dev/project/src"],
    ["/", "tmp/file.txt", "/tmp/file.txt"],
    ["/Users/dev/My Project", "папка/a #%.txt", "/Users/dev/My Project/папка/a #%.txt"],
  ])("joins %s and %s as plain filesystem text", (workspace, path, expected) => {
    expect(projectTreeAbsolutePath(workspace, path)).toBe(expected);
  });
});
