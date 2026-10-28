import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error Exercise production client effects rather than inert SSR effects.
import * as client from "svelte/internal/client";
import source from "./preview-scroll-controller.svelte.ts?raw";
import type { createPreviewScrollController } from "./preview-scroll-controller.svelte";

function fixture(savedTop = 0) {
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const compiled = compileModule(javascript, { filename: "ScrollController.svelte.js", generate: "client", dev: false }).js.code;
  const commonjs = ts.transpileModule(compiled, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;
  const output = {} as { createPreviewScrollController: typeof createPreviewScrollController };
  new Function("require", "exports", commonjs)((name: string) => {
    if (name === "svelte/internal/client") return client;
    if (name === "svelte") return { tick: () => Promise.resolve() };
    throw new Error(`Unexpected dependency: ${name}`);
  }, output);

  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => { frames.delete(handle); });
  const blocks = [[1, 1], [3, 7], [9, 15]].map(([start, end]) => {
    const classes = new Set<string>();
    return {
      dataset: { sourceStartLine: String(start), sourceEndLine: String(end) },
      classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name), contains: (name: string) => classes.has(name) },
      getBoundingClientRect: () => ({ top: 600, height: 24 }),
    };
  });
  const scroll = {
    scrollTop: savedTop, scrollLeft: 0, clientHeight: 300,
    getBoundingClientRect: () => ({ top: 20 }),
    querySelectorAll(selector: string) {
      if (selector === "[data-source-start-line]") return blocks;
      if (selector === ".preview-range-highlight") return blocks.filter(block => block.classList.contains("preview-range-highlight"));
      return [];
    },
    scrollTo: vi.fn(),
  };
  const state = client.state({ id: 1, top: savedTop });
  let controller!: ReturnType<typeof createPreviewScrollController>;
  const stop = client.effect_root(() => {
    controller = output.createPreviewScrollController({
      previewId: () => client.get(state).id,
      scrollPosition: () => ({ top: client.get(state).top, left: 0 }),
      lineRange: () => undefined,
      searchRange: () => ({ startLine: 7, endLine: 9 }),
      file: () => ({ path: "wiki/page.md", content: "# Wiki" }),
      highlighted: () => undefined,
      element: () => scroll as unknown as HTMLDivElement,
      editing: () => false,
      onBack: () => undefined, onForward: () => undefined, onScrollPositionChange: () => undefined,
    });
  });
  const runFrame = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); };
  return { scroll, blocks, stop, runFrame, controller, change: (id: number) => client.set(state, { id, top: 0 }) };
}

async function settle() { for (let i = 0; i < 4; i++) { client.flush(); await Promise.resolve(); } }
afterEach(() => vi.unstubAllGlobals());

it("reveals rendered Wiki ranges after restoration and highlights overlapping blocks", async () => {
  const f = fixture();
  const restore = f.controller.restoreScroll(f.scroll as unknown as HTMLElement, { key: 1, position: { top: 0, left: 0 } });
  try {
    await settle();
    f.runFrame();
    expect(f.scroll.scrollTo).not.toHaveBeenCalled();
    f.runFrame();
    expect(f.scroll.scrollTo).toHaveBeenCalledWith({ top: expect.any(Number), behavior: "auto" });
    expect(f.blocks.map(block => block.classList.contains("preview-range-highlight"))).toEqual([false, true, true]);
  } finally { restore.destroy(); f.stop(); }
});

it("restores history scroll without jumping back to the match", async () => {
  const f = fixture(420);
  try {
    await settle(); f.runFrame(); f.runFrame();
    expect(f.scroll.scrollTo).not.toHaveBeenCalled();
    expect(f.blocks[1]!.classList.contains("preview-range-highlight")).toBe(true);
  } finally { f.stop(); }
});

it("cancels stale reveals when switching results and on teardown", async () => {
  const f = fixture();
  try {
    await settle(); f.runFrame();
    f.change(2);
    await settle();
    f.runFrame();
    expect(f.scroll.scrollTo).not.toHaveBeenCalled();
    f.stop(); f.runFrame();
    expect(f.scroll.scrollTo).not.toHaveBeenCalled();
  } finally { f.stop(); }
});
