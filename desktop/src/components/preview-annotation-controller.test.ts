import { describe, expect, it, vi } from "vitest";
import type { FileAnnotations } from "../lib/acp-pix-extensions";
import { createPreviewAnnotationController, type PreviewFileAnnotator } from "./preview-annotation-controller.svelte";

const result = (text: string): FileAnnotations => ({ annotations: [{ line: 1, text }], language: "ru", annotatedLines: 3, totalLines: 3 });

function fixture() {
  const calls: { signal: AbortSignal; resolve: (value: FileAnnotations) => void; reject: (error: unknown) => void }[] = [];
  const annotate: PreviewFileAnnotator = (_request, signal) => new Promise((resolve, reject) => { calls.push({ signal, resolve, reject }); });
  const onError = vi.fn();
  const controller = createPreviewAnnotationController({ annotate: () => annotate, onError });
  controller.setSource("a.ts\0v1");
  return { controller, calls, onError };
}

describe("Preview inline annotations controller", () => {
  it("annotates, toggles without re-requesting and reuses the session result for the same content", async () => {
    const { controller, calls } = fixture();
    controller.toggle("a.ts", "v1");
    expect(controller.state).toMatchObject({ showing: true, status: "loading" });
    calls[0]!.resolve(result("Note"));
    await vi.waitFor(() => expect(controller.state.status).toBe("done"));
    controller.toggle("a.ts", "v1");
    expect(controller.state.showing).toBe(false);
    controller.setSource("b.ts\0x");
    controller.setSource("a.ts\0v1");
    expect(controller.state.status).toBe("idle");
    controller.toggle("a.ts", "v1");
    expect(controller.state).toMatchObject({ showing: true, status: "done" });
    expect(controller.state.annotations[0]!.text).toBe("Note");
    expect(calls).toHaveLength(1);
    void controller.annotate("a.ts", "v1", true);
    expect(calls).toHaveLength(2);
  });

  it("aborts on a content change and ignores the late result", async () => {
    const { controller, calls } = fixture();
    controller.toggle("a.ts", "v1");
    controller.setSource("a.ts\0v2");
    expect(calls[0]!.signal.aborted).toBe(true);
    calls[0]!.resolve(result("stale"));
    await Promise.resolve();
    expect(controller.state).toMatchObject({ showing: false, status: "idle", annotations: [] });
  });

  it("reports failures; cancel and dispose abort silently", async () => {
    const { controller, calls, onError } = fixture();
    void controller.annotate("a.ts", "v1");
    calls[0]!.reject(new Error("No annotation model is configured"));
    await vi.waitFor(() => expect(controller.state.status).toBe("error"));
    expect(onError).toHaveBeenCalledOnce();
    void controller.annotate("a.ts", "v1");
    controller.cancel();
    expect(calls[1]!.signal.aborted).toBe(true);
    expect(controller.state).toMatchObject({ showing: false, status: "idle" });
    void controller.annotate("a.ts", "v1");
    controller.dispose();
    expect(calls[2]!.signal.aborted).toBe(true);
    calls[2]!.reject(new Error("aborted"));
    await Promise.resolve();
    expect(onError).toHaveBeenCalledOnce();
  });
});
