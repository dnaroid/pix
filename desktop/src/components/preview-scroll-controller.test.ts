import { describe, expect, it } from "vitest";
import { renderedRangeElements, scheduleAfterScrollRestore } from "./preview-scroll-controller.svelte";

function animationFrames() {
  let nextHandle = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  return {
    request(callback: FrameRequestCallback): number {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
    cancel(handle: number): void {
      callbacks.delete(handle);
    },
    runFrame(): void {
      const frame = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of frame) callback(0);
    },
  };
}

describe("preview line-range reveal scheduling", () => {
  it("selects only rendered blocks intersecting the returned source fragment", () => {
    const blocks = [[1, 1], [3, 7], [9, 15], [17, 18]].map(([start, end]) => ({
      dataset: { sourceStartLine: String(start), sourceEndLine: String(end) },
    } as unknown as HTMLElement));
    const root = { querySelectorAll: () => blocks } as unknown as HTMLElement;
    expect(renderedRangeElements(root, { startLine: 7, endLine: 9 })).toEqual(blocks.slice(1, 3));
    expect(renderedRangeElements(root, { startLine: 8, endLine: 8 })).toEqual([]);
    expect(renderedRangeElements(root, { startLine: 30, endLine: 31 })).toEqual([]);
  });
  it("waits for the pending saved-position restore before revealing a requested line", () => {
    const frames = animationFrames();
    let scrollTop = 480;
    let revealedAt: number | undefined;

    // This mirrors restoreScroll's pending initial-position write.
    frames.request(() => { scrollTop = 0; });
    scheduleAfterScrollRestore(
      () => { revealedAt = scrollTop; },
      frames.request,
      frames.cancel,
    );

    frames.runFrame();
    expect(revealedAt).toBeUndefined();
    frames.runFrame();
    expect(revealedAt).toBe(0);
  });

  it("cancels a pending reveal after its second frame has been scheduled", () => {
    const frames = animationFrames();
    let revealed = false;
    const cancelReveal = scheduleAfterScrollRestore(
      () => { revealed = true; },
      frames.request,
      frames.cancel,
    );

    frames.runFrame();
    cancelReveal();
    frames.runFrame();
    expect(revealed).toBe(false);
  });
});
