import { describe, expect, it } from "vitest";
import { contextFilePath, previewSourceReference, projectRevealPath, relativeImagePath } from "./desktop-context-target";
import previewSource from "../components/PreviewPane.svelte?raw";

describe("trusted preview file paths", () => {
  it("resolves project previews and preserves absolute paths, spaces and unicode", () => {
    expect(contextFilePath("src/my file.ts", "/project/")).toBe("/project/src/my file.ts");
    expect(contextFilePath("/tmp/ролик.mov", "")).toBe("/tmp/ролик.mov");
  });
  it("never guesses local paths from remote or escaping references", () => {
    for (const path of [undefined, "", "../outside", "https://example.com/a", "file:///tmp/a", "a\0b", "~/file"]) {
      expect(contextFilePath(path, "/project")).toBeUndefined();
    }
    expect(contextFilePath("src/a.ts", "")).toBeUndefined();
  });
});

describe("workspace-relative image paths", () => {
  it("preserves spaces and handles outside-workspace paths without prefix confusion", () => {
    expect(relativeImagePath("/project/assets/my chart.png", "/project/")).toBe("assets/my chart.png");
    expect(relativeImagePath("/projects/chart.png", "/project")).toBe("../projects/chart.png");
    expect(relativeImagePath("/tmp/chart.png", "/project/nested")).toBe("../../tmp/chart.png");
    expect(relativeImagePath("/tmp/chart.png", "")).toBeUndefined();
    expect(relativeImagePath("https://example.com/chart.png", "/project")).toBeUndefined();
  });
});

describe("Preview tab paths owned by Files", () => {
  it("accepts relative and absolute files within the project", () => {
    expect(projectRevealPath("nested/my file.ts", "/project/")).toBe("nested/my file.ts");
    expect(projectRevealPath("/project/nested/файл.md", "/project")).toBe("nested/файл.md");
  });
  it("omits reveal for outside-project tabs and unavailable paths", () => {
    for (const path of [undefined, "", "../outside", "/tmp/file.ts", "/project-other/file.ts", "/project", "/project/../outside", "https://example.com/file.ts"]) {
      expect(projectRevealPath(path, "/project")).toBeUndefined();
    }
    expect(projectRevealPath("/project/file.ts", "")).toBeUndefined();
  });
});

describe("Preview source references", () => {
  function source(path = "src/my file.ts", line = 2) {
    const rows = [{}, {}, {}];
    const code = { children: rows, matches: (selector: string): boolean => selector === ".preview-code" };
    const row = rows[line - 1];
    Object.assign(row!, { parentElement: code });
    const surface = { dataset: { previewSourcePath: path }, contains: (node: unknown) => node === code };
    const element = { closest: (selector: string) => selector === ".sh__line" ? row : surface } as unknown as HTMLElement;
    return { element, surface, code };
  }

  it("uses the clicked row index, including nested tokens and gutter targets", () => {
    for (const line of [1, 2, 3]) {
      expect(previewSourceReference(source(undefined, line).element, "/project")).toBe(`src/my file.ts:${line}`);
    }
  });
  it("resolves absolute local previews relative to the workspace without URI escaping", () => {
    expect(previewSourceReference(source("/project/src/a.ts").element, "/project")).toBe("src/a.ts:2");
    expect(previewSourceReference(source("/tmp/my file.ts").element, "/project")).toBe("../tmp/my file.ts:2");
    expect(previewSourceReference(source("/tmp/a.ts").element, "")).toBeUndefined();
  });
  it("does not guess a line outside numbered source rows", () => {
    const { element, code, surface } = source();
    code.matches = () => false;
    expect(previewSourceReference(element, "/project")).toBeUndefined();
    code.matches = () => true;
    surface.contains = () => false;
    expect(previewSourceReference(element, "/project")).toBeUndefined();
    expect(previewSourceReference({ closest: () => null } as unknown as HTMLElement, "/project")).toBeUndefined();
  });
  it("marks only the read-only source region with its file path", () => {
    expect(previewSource.match(/data-preview-source-path/g)).toHaveLength(1);
    expect(previewSource).toContain('aria-label={`Source for ${file.path}`}\n          data-preview-source-path={file.path}');
  });
});
