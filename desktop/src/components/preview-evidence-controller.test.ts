import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error Exercise production client effects rather than inert SSR effects.
import * as client from "svelte/internal/client";
import { matchKnowledgeCitation } from "../lib/knowledge-citation";
import { renderedRangeElements, scheduleAfterScrollRestore } from "./preview-scroll-controller.svelte";
import type { KnowledgeCitation } from "../../../acp/src/knowledge/contract";
import type { createPreviewEvidenceController } from "./preview-evidence-controller.svelte";
import source from "./preview-evidence-controller.svelte.ts?raw";

function fixture(content = "# Rules\n\nNew context.\n\nFive retries.", savedTop = 0) {
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const compiled = compileModule(javascript, { filename: "EvidenceController.svelte.js", generate: "client", dev: false }).js.code;
  const commonjs = ts.transpileModule(compiled, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;
  const cleanup = vi.fn();
  const decorate = vi.fn((_document: Document, blocks: HTMLElement[]) => ({ status: "exact", target: blocks[0], cleanup }));
  const output = {} as { createPreviewEvidenceController: typeof createPreviewEvidenceController };
  new Function("require", "exports", commonjs)((name: string) => {
    if (name === "svelte/internal/client") return client;
    if (name === "svelte") return { tick: () => Promise.resolve(), untrack: (callback: () => unknown) => callback() };
    if (name === "../lib/knowledge-citation") return { matchKnowledgeCitation };
    if (name === "./preview-evidence-highlight") return { decorateEvidence: decorate };
    if (name === "./preview-scroll-controller.svelte") return { renderedRangeElements, scheduleAfterScrollRestore };
    throw new Error(`Unexpected dependency: ${name}`);
  }, output);

  let sequence = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  const blocks = [1, 3, 5].map(line => ({
    dataset: { sourceStartLine: String(line), sourceEndLine: String(line) },
    getBoundingClientRect: () => ({ top: 600, height: 24 }),
  } as unknown as HTMLElement));
  const scroll = {
    ownerDocument: {}, scrollTop: savedTop, scrollLeft: 0, clientHeight: 300,
    querySelectorAll: () => blocks,
    getBoundingClientRect: () => ({ top: 20 }),
    scrollTo: vi.fn(), focus: vi.fn(),
  };
  const initial = {
    id: 1, active: true, editing: false, workspace: "/one", top: savedTop,
    file: { path: "wiki/rules.md", content },
    citation: { path: "wiki/rules.md", quote: "Five retries.", startLine: 2, endLine: 2 } as KnowledgeCitation | undefined,
  };
  const state = client.state(initial);
  let controller!: ReturnType<typeof createPreviewEvidenceController>;
  const stop = client.effect_root(() => {
    controller = output.createPreviewEvidenceController({
      previewId: () => client.get(state).id,
      workspace: () => client.get(state).workspace,
      active: () => client.get(state).active,
      editing: () => client.get(state).editing,
      citation: () => client.get(state).citation,
      file: () => client.get(state).file,
      content: () => client.get(state).file.content,
      scrollPosition: () => ({ top: client.get(state).top, left: 0 }),
      element: () => scroll as unknown as HTMLDivElement,
    });
  });
  const runFrame = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); };
  return { scroll, blocks, controller, stop, runFrame, decorate, cleanup, change: (patch: Partial<typeof initial>) => client.set(state, { ...client.get(state), ...patch }) };
}

async function settle() { for (let i = 0; i < 4; i++) { client.flush(); await Promise.resolve(); } }
afterEach(() => vi.unstubAllGlobals());

it("uses the current unique quotation's moved range after scroll restoration without stealing focus", async () => {
  const f = fixture();
  try {
    await settle(); f.runFrame();
    expect(f.decorate).not.toHaveBeenCalled();
    f.runFrame();
    expect(f.decorate).toHaveBeenCalledExactlyOnceWith(f.scroll.ownerDocument, [f.blocks[2]], "Five retries.");
    expect(f.controller.status).toBe("exact");
    expect(f.scroll.scrollTo).toHaveBeenCalledWith({ top: expect.any(Number), behavior: "auto" });
    expect(f.scroll.focus).not.toHaveBeenCalled();
  } finally { f.stop(); }
});

it.each([["New rule.", "missing"], ["Five retries.\nFive retries.", "ambiguous"]])("shows stale evidence for %s without highlighting saved lines", async (content, status) => {
  const f = fixture(content);
  try {
    await settle(); f.runFrame(); f.runFrame();
    expect(f.controller.status).toBe(status);
    expect(f.decorate).not.toHaveBeenCalled();
    expect(f.scroll.scrollTo).not.toHaveBeenCalled();
  } finally { f.stop(); }
});

it("keeps restored history scroll and a user's intervening scroll", async () => {
  const restored = fixture(undefined, 420);
  try {
    await settle(); restored.runFrame(); restored.runFrame();
    expect(restored.decorate).toHaveBeenCalledOnce();
    expect(restored.scroll.scrollTo).not.toHaveBeenCalled();
  } finally { restored.stop(); }
  const moved = fixture();
  try {
    await settle(); moved.runFrame(); moved.scroll.scrollTop = 150; moved.runFrame();
    expect(moved.decorate).toHaveBeenCalledOnce();
    expect(moved.scroll.scrollTo).not.toHaveBeenCalled();
  } finally { moved.stop(); }
});

it.each(["navigation", "editing", "inactive", "dispose"])("cleans its decoration on %s", async action => {
  const f = fixture();
  try {
    await settle(); f.runFrame(); f.runFrame();
    expect(f.decorate).toHaveBeenCalledOnce();
    if (action === "navigation") f.change({ id: 2, citation: undefined });
    if (action === "editing") f.change({ editing: true });
    if (action === "inactive") f.change({ active: false });
    if (action === "dispose") f.controller.dispose();
    await settle();
    expect(f.cleanup).toHaveBeenCalled();
  } finally { f.stop(); }
});

it("cancels delayed decoration when a different workspace/document becomes active", async () => {
  const f = fixture();
  try {
    await settle(); f.runFrame();
    f.change({ id: 2, workspace: "/two", citation: undefined });
    await settle(); f.runFrame(); f.runFrame();
    expect(f.decorate).not.toHaveBeenCalled();
    expect(f.scroll.scrollTo).not.toHaveBeenCalled();
  } finally { f.stop(); }
});

it("revalidates changed file content and removes a formerly matching highlight", async () => {
  const f = fixture();
  try {
    await settle(); f.runFrame(); f.runFrame();
    f.change({ file: { path: "wiki/rules.md", content: "Seven retries." } });
    await settle(); f.runFrame(); f.runFrame();
    expect(f.cleanup).toHaveBeenCalled();
    expect(f.controller.status).toBe("missing");
    expect(f.decorate).toHaveBeenCalledOnce();
  } finally { f.stop(); }
});
