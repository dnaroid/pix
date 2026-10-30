import { beforeEach, describe, expect, it, vi } from "vitest";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async (_source: string) => true),
  render: vi.fn(async (id: string, source: string) => ({ svg: `<svg id="${id}">${source}</svg>` })),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

import { cachedMermaidDiagram, mermaidThemeKey, renderMermaidDiagram } from "./mermaid";

let foreground = "#111";
const themeRoot = {} as HTMLElement;

beforeEach(() => {
  vi.stubGlobal("getComputedStyle", () => ({
    getPropertyValue: (name: string) => name === "--foreground" ? foreground : "#fff",
  }));
});

describe("Mermaid diagram cache", () => {
  it("renders a source once per theme and serves the settled SVG synchronously", async () => {
    const source = "graph TD; Cached-->Once";
    const key = mermaidThemeKey(themeRoot);
    expect(cachedMermaidDiagram(source, key)).toBeNull();
    const first = renderMermaidDiagram(source, themeRoot);
    const concurrent = renderMermaidDiagram(source, themeRoot);
    expect(concurrent).toBe(first);
    const svg = await first;
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(cachedMermaidDiagram(source, key)).toBe(svg);
    await renderMermaidDiagram(source, themeRoot);
    expect(mermaid.render).toHaveBeenCalledTimes(1);

    foreground = "#eee";
    const darkKey = mermaidThemeKey(themeRoot);
    expect(darkKey).not.toBe(key);
    expect(cachedMermaidDiagram(source, darkKey)).toBeNull();
    await renderMermaidDiagram(source, themeRoot);
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    foreground = "#111";
  });

  it("caches invalid sources as settled failures but retries rejected renders", async () => {
    const key = mermaidThemeKey(themeRoot);
    mermaid.parse.mockResolvedValueOnce(false);
    await expect(renderMermaidDiagram("not a diagram", themeRoot)).resolves.toBeUndefined();
    expect(cachedMermaidDiagram("not a diagram", key)).toBeUndefined();

    mermaid.render.mockRejectedValueOnce(new Error("render failed"));
    await expect(renderMermaidDiagram("graph TD; Flaky", themeRoot)).rejects.toThrow("render failed");
    expect(cachedMermaidDiagram("graph TD; Flaky", key)).toBeNull();
    await expect(renderMermaidDiagram("graph TD; Flaky", themeRoot)).resolves.toContain("Flaky");
  });
});
