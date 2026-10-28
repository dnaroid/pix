import { describe, expect, it } from "vitest";
import type { ProjectTreeEntry } from "./project-tree";
import { createWikiContents } from "./project-wiki-contents";
import { resolveWikiLink } from "./project-wiki";
import { renderMarkdown } from "./markdown";

function entry(name: string, kind: "file" | "directory" = "file", directory = "wiki"): ProjectTreeEntry {
  return { name, kind, path: `${directory}/${name}` };
}

describe("virtual Wiki contents", () => {
  it("lists immediate sections before Markdown pages, naturally sorted, without mutating the listing", () => {
    const entries = [entry("page10.md"), entry("zebra", "directory"), entry("image.png"), entry("page2.MARKDOWN"), entry("alpha", "directory")];
    const original = [...entries];
    const file = createWikiContents("wiki", entries);
    expect(file).toMatchObject({ path: "wiki/index.md", virtualWikiDirectory: "wiki" });
    expect(file.content).toContain("## Sections\n\n- [alpha](./alpha)\n- [zebra](./zebra)");
    expect(file.content).toContain("## Pages\n\n- [page2](./page2.MARKDOWN)\n- [page10](./page10.md)");
    expect(file.content).toContain("## Media\n\n![image.png](./image.png)");
    expect(entries).toEqual(original);
  });

  it("uses nested link bases and an explicit empty state", () => {
    const file = createWikiContents("docs/game/rules", []);
    expect(file.content).toContain("This folder is empty.");
    expect(file.virtualWikiDirectory).toBe("docs/game/rules");
    expect(resolveWikiLink(file.path, "./combat.md")).toBe("docs/game/rules/combat.md");
  });

  it("escapes labels and round-trips spaces, Unicode, Markdown syntax and URL punctuation", () => {
    const name = "[<бой>]* (100%) #1?.md";
    const file = createWikiContents("wiki", [entry(name)]);
    expect(file.content).toContain("\\[&lt;бой&gt;\\]\\* \\(100%\\) \\#1?");
    const target = file.content.match(/\]\(([^)]+)\)/u)?.[1];
    expect(target).toBeDefined();
    expect(resolveWikiLink(file.path, target!)).toBe(`wiki/${name}`);
    expect(file.content).not.toContain("<бой>");
  });

  it("does not turn nested or outside listing entries into links", () => {
    const file = createWikiContents("wiki", [
      entry("../escape.md"), entry("nested/page.md"), entry("back\\slash.md"),
      { name: "secret.md", kind: "file", path: "other/secret.md" },
    ]);
    expect(file.content).toContain("This folder is empty.");
    expect(file.content).not.toContain("](./");
  });

  it("lists an image-only folder rather than claiming it is empty", () => {
    const directory = "wiki/assets/screenshots";
    const file = createWikiContents(directory, [
      entry("pix-overview.svg", "file", directory),
      entry("pix-overview.png", "file", directory),
      entry("map #1.png", "file", directory),
    ]);
    expect(file.content).toContain("## Media");
    expect(file.content).toContain("![pix-overview.png](./pix-overview.png)");
    expect(file.content).toContain("![pix-overview.svg](./pix-overview.svg)");
    expect(file.content).toContain("(./map%20%231.png)");
    expect(file.content).not.toContain("empty");
    expect(file.content).not.toContain("## Pages");
    expect(resolveWikiLink(file.path, "./map%20%231.png")).toBe(`${directory}/map #1.png`);
  });

  it("renders inline images and video through the ordinary Markdown media pipeline", () => {
    const directory = "wiki/assets";
    const file = createWikiContents(directory, [
      entry("map #1.PNG", "file", directory), entry("diagram.svg", "file", directory),
      entry("demo (1).MP4", "file", directory), entry("recording.webm", "file", directory),
      entry("data.json", "file", directory),
    ]);
    const html = renderMarkdown(file.content, { documentPath: file.path });
    expect(html.match(/data-project-media="image"/gu)).toHaveLength(2);
    expect(html.match(/data-project-media="video"/gu)).toHaveLength(2);
    expect(html).toContain('data-project-file="wiki/assets/map #1.PNG"');
    expect(html).toContain('data-project-file="wiki/assets/demo (1).MP4"');
    expect(file.content).toContain("## Files\n\n- [data.json](./data.json)");
    expect(file.content).not.toContain("![data.json]");
  });
});
