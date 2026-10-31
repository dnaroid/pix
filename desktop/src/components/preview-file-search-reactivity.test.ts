import { compileModule } from "svelte/compiler";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Exercise production client effects rather than inert SSR effects.
import * as client from "svelte/internal/client";
import * as fileSearch from "../lib/file-search";
import source from "./preview-file-search-controller.svelte.ts?raw";
import type { createPreviewFileSearchController } from "./preview-file-search-controller.svelte";

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); client.flushSync?.(); };

function fixture(initialText: string) {
  const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const compiled = compileModule(javascript, { filename: "PreviewFileSearch.svelte.js", generate: "client", dev: false }).js.code;
  const commonjs = ts.transpileModule(compiled, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.CommonJS } }).outputText;
  const output = {} as { createPreviewFileSearchController: typeof createPreviewFileSearchController; PREVIEW_SEARCH_DEBOUNCE_MS: number };
  const find = vi.fn(fileSearch.findTextMatches);
  new Function("require", "exports", commonjs)((name: string) => {
    if (name === "svelte/internal/client") return client;
    if (name === "svelte") return { tick: () => Promise.resolve() };
    if (name === "../lib/file-search") return { ...fileSearch, findTextMatches: find };
    throw new Error(`Unexpected dependency: ${name}`);
  }, output);

  const editor = {
    selectionStart: 0, selectionEnd: 0, scrollTop: 0, clientHeight: 240,
    setSelectionRange: vi.fn((start: number, end: number) => { editor.selectionStart = start; editor.selectionEnd = end; }),
  };
  const input = { focus: vi.fn(), select: vi.fn() };
  const text = client.state(initialText);
  let controller!: ReturnType<typeof createPreviewFileSearchController>;
  const stop = client.effect_root(() => {
    controller = output.createPreviewFileSearchController({
      active: () => true,
      previewId: () => 1,
      enabled: () => true,
      editing: () => true,
      fileText: () => client.get(text),
      contentElement: () => undefined,
      editorElement: () => editor as unknown as HTMLTextAreaElement,
      inputElement: () => input as unknown as HTMLInputElement,
    });
  });
  return { controller, editor, find, stop, debounce: output.PREVIEW_SEARCH_DEBOUNCE_MS, type: (next: string) => client.set(text, next) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Preview find-in-file editor search", () => {
  it("debounces typing, reveals on query change and reuses matches for Enter", async () => {
    const { controller, editor, find, stop, debounce } = fixture("alpha\nbeta alpha\ngamma ALPHA");
    controller.open();
    await flush();
    controller.setQuery("a");
    controller.setQuery("al");
    controller.setQuery("alpha");
    await vi.advanceTimersByTimeAsync(debounce - 1);
    expect(find).not.toHaveBeenCalledWith(expect.anything(), "alpha");
    await vi.advanceTimersByTimeAsync(1);
    expect(find.mock.calls.filter(([, query]) => query !== "")).toEqual([[expect.any(String), "alpha"]]);
    expect(controller.state.matchCount).toBe(3);
    expect(editor.setSelectionRange).toHaveBeenLastCalledWith(0, 5);
    controller.next();
    await flush();
    controller.next();
    await flush();
    expect(editor.setSelectionRange).toHaveBeenLastCalledWith(23, 28);
    expect(editor.scrollTop).toBe(Math.max(0, 2 * 24 - 120));
    expect(find).toHaveBeenCalledOnce();
    stop();
  });

  it("recounts on draft edits without moving the caret or scroll", async () => {
    const { controller, editor, stop, debounce, type } = fixture("needle one");
    controller.open();
    await flush();
    controller.setQuery("needle");
    await vi.advanceTimersByTimeAsync(debounce);
    expect(controller.state.matchCount).toBe(1);
    // The user clicks into the editor and types elsewhere.
    editor.setSelectionRange(10, 10);
    editor.setSelectionRange.mockClear();
    editor.scrollTop = 77;
    type("needle one needle");
    await flush();
    expect(controller.state.matchCount).toBe(2);
    expect(editor.setSelectionRange).not.toHaveBeenCalled();
    expect(editor.scrollTop).toBe(77);
    // Explicit navigation still reveals.
    controller.next();
    await flush();
    expect(editor.setSelectionRange).toHaveBeenLastCalledWith(11, 17);
    stop();
  });

  it("searches immediately on Enter before the debounce and cancels the timer on close", async () => {
    const { controller, editor, stop, debounce } = fixture("x y x");
    controller.open();
    await flush();
    controller.setQuery("x");
    controller.next();
    expect(controller.state.matchCount).toBe(2);
    expect(editor.setSelectionRange).toHaveBeenLastCalledWith(0, 1);
    controller.setQuery("y");
    controller.close();
    editor.setSelectionRange.mockClear();
    await vi.advanceTimersByTimeAsync(debounce * 2);
    expect(editor.setSelectionRange).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });
});
