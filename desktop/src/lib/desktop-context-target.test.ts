import { afterEach, describe, expect, it, vi } from "vitest";
import { contextFilePath, desktopContextTarget, linkedFilePath, previewSourceReference, projectRevealPath, relativeImagePath } from "./desktop-context-target";
import previewSource from "../components/PreviewPane.svelte?raw";
import tabsSource from "../components/WorkbenchTabs.svelte?raw";
import { workbenchTabMove } from "./workbench-tab-move";

describe("session tab context targets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("exposes raw session metadata only on session tab buttons", () => {
    expect(tabsSource).toContain('data-context-session-id={tab.kind === "session" ? tab.sessionId : undefined}');
    expect(tabsSource).toContain('data-context-session-file={tab.kind === "session" ? tab.sessionFile : undefined}');
  });

  it("routes both the tab button and nested labels/icons to the clicked session", () => {
    class ElementStub {
      dataset = { contextSessionId: "clicked-session", contextSessionFile: "/sessions/мой session.jsonl" };
      closest(selector: string): ElementStub | null {
        return selector === "[data-workbench-tab][data-context-session-id]" ? tab : null;
      }
    }
    const tab = new ElementStub();
    vi.stubGlobal("Element", ElementStub);
    vi.stubGlobal("HTMLElement", ElementStub);
    vi.stubGlobal("HTMLInputElement", class {});
    vi.stubGlobal("HTMLTextAreaElement", class {});
    for (const target of [tab, new ElementStub()]) {
      expect(desktopContextTarget(target as unknown as EventTarget)).toEqual({
        kind: "session", element: tab, sessionId: "clicked-session", sessionFile: "/sessions/мой session.jsonl",
        editor: null, hasSelection: false, readOnly: true,
      });
    }
  });

  it("exposes the registered move command on utility tabs and removes it when disabled/unmounted", () => {
    class ElementStub {
      ownerDocument = { getSelection: () => null };
      closest(selector: string): ElementStub | null {
        return selector === "[data-workbench-tab]" ? tab : null;
      }
    }
    const tab = new ElementStub();
    vi.stubGlobal("Element", ElementStub);
    vi.stubGlobal("HTMLElement", ElementStub);
    vi.stubGlobal("HTMLInputElement", class {});
    vi.stubGlobal("HTMLTextAreaElement", class {});
    vi.stubGlobal("HTMLImageElement", class {});
    const move = vi.fn();
    const action = workbenchTabMove(tab as unknown as HTMLElement, move);
    const target = desktopContextTarget(new ElementStub() as unknown as EventTarget);
    expect(target?.kind).toBe("workbench");
    target?.moveTab?.();
    expect(move).toHaveBeenCalledOnce();
    action.update(undefined);
    target?.moveTab?.();
    expect(desktopContextTarget(tab as unknown as EventTarget)).toBeNull();
    expect(move).toHaveBeenCalledOnce();
    action.destroy();
  });
});

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

describe("Markdown file link paths", () => {
  const link = (data: Partial<Record<"projectFile" | "localFile", string>>) => ({ dataset: data }) as unknown as HTMLElement;
  it("resolves project links in the workspace and keeps absolute or home local links", () => {
    expect(linkedFilePath(link({ projectFile: "src/my file.ts" }), "/project")).toBe("/project/src/my file.ts");
    expect(linkedFilePath(link({ localFile: "/tmp/ролик.mov" }), "/project")).toBe("/tmp/ролик.mov");
    expect(linkedFilePath(link({ localFile: "~/.config/pi/pix.jsonc" }), "/project")).toBe("~/.config/pi/pix.jsonc");
    expect(projectRevealPath(linkedFilePath(link({ localFile: "/project/a/b.md" }), "/project"), "/project")).toBe("a/b.md");
  });
  it("rejects escaping, relative or unavailable link paths", () => {
    for (const data of [{}, { projectFile: "../x" }, { projectFile: "/abs" }, { localFile: "rel.txt" },
      { localFile: "~/../etc/passwd" }, { localFile: "/tmp/a\0b" }]) {
      expect(linkedFilePath(link(data), "/project")).toBeUndefined();
    }
    expect(linkedFilePath(link({ projectFile: "src/a.ts" }), "")).toBeUndefined();
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
