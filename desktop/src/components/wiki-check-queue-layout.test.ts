import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import ProjectWikiCheckQueue from "./ProjectWikiCheckQueue.svelte";
import sidebar from "./WorkspaceSidebar.svelte?raw";

describe("Wiki checks footer layout", () => {
  it("reserves the grid notice row even when the notice renders nothing", () => {
    expect(sidebar).toContain("grid-rows-[36px_auto_minmax(0,1fr)]");
    expect(sidebar).toMatch(/<div\b[^>]*data-wiki-auto-check-notice-slot>\s*<WikiAutoCheckControl part="notice" state=\{wikiAutoCheck\} \/>\s*<\/div>/u);
  });

  it("anchors the collapsed checks disclosure to the bottom without shrinking it", () => {
    const body = render(ProjectWikiCheckQueue, { props: {
      workspace: "/project", onOpenFile: () => {},
    } }).body;
    const section = body.match(/<section\b[^>]*data-wiki-check-queue[^>]*>/u)?.[0] ?? "";
    expect(section).toContain("mt-auto");
    expect(section).toContain("shrink-0");
    expect(body).toContain('aria-expanded="false"');
  });
});
