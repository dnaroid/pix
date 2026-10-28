import { describe, expect, it } from "vitest";
import { getProjectWikiConfig, resolveWikiLink } from "./project-wiki";

describe("project Wiki configuration", () => {
  it("uses wiki/index.md when the workspace file or Wiki settings are absent", () => {
    const expected = { path: "wiki", index: "index.md", indexPath: "wiki/index.md" };
    expect(getProjectWikiConfig()).toEqual(expected);
    expect(getProjectWikiConfig("{}")).toEqual(expected);
    expect(getProjectWikiConfig('{"wiki":{}}')).toEqual(expected);
  });

  it("accepts JSONC, unrelated settings and a nested Markdown index", () => {
    const source = `{
      // Existing project preferences remain independent of Wiki.
      "color": "#123456",
      "wiki": { "path": "./docs/game/", "index": "overview/home.md", "future": true, },
    }`;
    expect(getProjectWikiConfig(source)).toEqual({
      path: "docs/game", index: "overview/home.md", indexPath: "docs/game/overview/home.md",
    });
    expect(source).toContain("// Existing project preferences");
  });

  it("normalizes harmless separators and accepts Markdown extension case", () => {
    expect(getProjectWikiConfig(JSON.stringify({ wiki: { path: "docs\\wiki\\", index: "./Home.MARKDOWN" } })))
      .toEqual({ path: "docs/wiki", index: "Home.MARKDOWN", indexPath: "docs/wiki/Home.MARKDOWN" });
  });

  it.each(["", "{", "[]", "null", "true", '{"wiki":[]}', '{"wiki":null}', '{"wiki":"wiki"}'])
    ("reports malformed configuration instead of choosing another folder: %s", (source) => {
      expect(() => getProjectWikiConfig(source)).toThrow();
    });

  it.each(["", ".", "./", "/tmp/wiki", "\\wiki", "C:\\wiki", "C:wiki", "~/wiki", "https://example.test/wiki", "../wiki", "docs/../wiki", "docs\\..\\wiki", "wiki\u0000", 5, null])
    ("rejects unsafe or invalid Wiki folder %s", (path) => {
      expect(() => getProjectWikiConfig(JSON.stringify({ wiki: { path } }))).toThrow(/wiki.path/u);
    });

  it.each(["../home.md", "..\\home.md", "/home.md", "C:/home.md", "https://example.test/home.md", "home.html", "", 5, null])
    ("keeps index paths inside the Wiki and Markdown-only: %s", (index) => {
      expect(() => getProjectWikiConfig(JSON.stringify({ wiki: { index } }))).toThrow(/wiki.index/u);
    });

  it.each([".pi/artifacts", ".pi/artifacts/game", ".pi/subagents/wiki", ".PI/ARTIFACTS/wiki", ".git/wiki", "docs/.git/wiki"])
    ("does not store Wiki documents in temporary or repository metadata storage: %s", (path) => {
      expect(() => getProjectWikiConfig(JSON.stringify({ wiki: { path } }))).toThrow(/storage/u);
    });

  it("also checks the combined index path for disposable storage", () => {
    expect(() => getProjectWikiConfig('{"wiki":{"path":".pi","index":"artifacts/index.md"}}'))
      .toThrow(/disposable/u);
    expect(getProjectWikiConfig('{"wiki":{"path":"docs/.pi-notes"}}').path).toBe("docs/.pi-notes");
  });
});

describe("Wiki document-relative links", () => {
  it.each([
    ["../images/hero.png", "wiki/images/hero.png"],
    ["../../README.md", "README.md"],
    ["./combat.md#damage", "wiki/rules/combat.md"],
    ["../images/hero%20portrait.png?size=2#caption", "wiki/images/hero portrait.png"],
    ["../images/hero%23one%3F.png", "wiki/images/hero#one?.png"],
    ["..\\images\\hero.png", "wiki/images/hero.png"],
    ["%2e%2e/images/hero.png", "wiki/images/hero.png"],
    ["#damage", "wiki/rules/combat.md"],
  ])("resolves %s without dropping escaped filename characters", (href, expected) => {
    expect(resolveWikiLink("wiki/rules/combat.md", href)).toBe(expected);
  });

  it.each([
    "../../../secret.md", "%2e%2e/%2e%2e/%2e%2e/secret.md", "..\\..\\..\\secret.md",
    "/etc/passwd", "%2Fetc/passwd", "//example.test/a.md", "https://example.test/a.md",
    "mailto:someone@example.test", "file:///tmp/a.md", "javascript:alert(1)", "data:image/png;base64,a",
    "C:\\wiki\\a.md", "~/.config/a.md", "bad%ZZ.md", "image%00.png", "",
  ])("leaves unsupported or escaped targets unresolved: %s", (href) => {
    expect(resolveWikiLink("wiki/rules/combat.md", href)).toBeUndefined();
  });

  it("requires a workspace-relative source document", () => {
    expect(resolveWikiLink("/tmp/index.md", "image.png")).toBeUndefined();
    expect(resolveWikiLink("../index.md", "image.png")).toBeUndefined();
  });
});

