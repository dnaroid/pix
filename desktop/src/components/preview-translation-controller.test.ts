import { describe, expect, it, vi } from "vitest";
import type { DocumentTranslation } from "../lib/acp-pix-extensions";
import { createPreviewTranslationController, type PreviewDocumentTranslator, type PreviewTranslationDelta } from "./preview-translation-controller.svelte";

function deferred() {
  let resolve!: (value: DocumentTranslation) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<DocumentTranslation>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const result = (text: string, cachedChunks = 0): DocumentTranslation => ({ text, language: "ru", chunks: 1, cachedChunks });

function fixture() {
  const calls: { request: Parameters<PreviewDocumentTranslator>[0]; signal: AbortSignal; onDelta: (delta: PreviewTranslationDelta) => void; done: ReturnType<typeof deferred> }[] = [];
  const translate: PreviewDocumentTranslator = (request, signal, onDelta) => {
    const done = deferred();
    calls.push({ request, signal, onDelta, done });
    return done.promise;
  };
  const onError = vi.fn();
  const controller = createPreviewTranslationController({ translate: () => translate, onError });
  controller.setSource("1\0a.md\0Hello");
  return { controller, calls, onError };
}

describe("Preview document translation", () => {
  it("streams progress, finishes and toggles between original and translation without re-requesting", async () => {
    const { controller, calls } = fixture();
    controller.toggle("a.md", "Hello");
    expect(controller.state).toMatchObject({ showing: true, status: "loading" });
    calls[0]!.onDelta({ text: "При" });
    calls[0]!.onDelta({ text: "вет" });
    expect(controller.state).toMatchObject({ status: "streaming", text: "Привет" });
    calls[0]!.onDelta({ reset: true });
    expect(controller.state).toMatchObject({ status: "loading", text: "" });
    calls[0]!.done.resolve(result("Привет", 1));
    await vi.waitFor(() => expect(controller.state.status).toBe("done"));
    expect(controller.state.cachedChunks).toBe(1);
    controller.toggle("a.md", "Hello");
    expect(controller.state.showing).toBe(false);
    controller.toggle("a.md", "Hello");
    expect(controller.state.showing).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("a refresh bypasses the cache and supersedes the running request", async () => {
    const { controller, calls } = fixture();
    void controller.translate("a.md", "Hello");
    void controller.translate("a.md", "Hello", true);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls[1]!.request).toEqual({ path: "a.md", text: "Hello", refresh: true });
    calls[0]!.onDelta({ text: "stale" });
    calls[0]!.done.resolve(result("stale"));
    calls[1]!.done.resolve(result("fresh"));
    await vi.waitFor(() => expect(controller.state.text).toBe("fresh"));
  });

  it("a changed document aborts and ignores late output", async () => {
    const { controller, calls } = fixture();
    controller.toggle("a.md", "Hello");
    controller.setSource("1\0a.md\0Hello, edited");
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.onDelta({ text: "late" });
    calls[0]!.done.resolve(result("late"));
    await Promise.resolve();
    expect(controller.state).toMatchObject({ showing: false, status: "idle", text: "" });
  });

  it("reports failures, while cancellation and disposal stay silent", async () => {
    const { controller, calls, onError } = fixture();
    void controller.translate("a.md", "Hello");
    calls[0]!.done.reject(new Error("No translation model is configured"));
    await vi.waitFor(() => expect(controller.state.status).toBe("error"));
    expect(controller.state.error).toBe("No translation model is configured");
    expect(onError).toHaveBeenCalledOnce();

    void controller.translate("a.md", "Hello");
    controller.cancel();
    expect(calls[1]!.signal.aborted).toBe(true);
    expect(controller.state.status).toBe("idle");

    void controller.translate("a.md", "Hello");
    controller.dispose();
    expect(calls[2]!.signal.aborted).toBe(true);
    calls[2]!.done.reject(new Error("aborted"));
    await Promise.resolve();
    expect(onError).toHaveBeenCalledOnce();
    void controller.translate("a.md", "Hello");
    expect(calls).toHaveLength(3);
  });
});
