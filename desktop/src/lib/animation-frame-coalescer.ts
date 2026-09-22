export type AnimationFrameRequest = (callback: FrameRequestCallback) => number;
export type AnimationFrameCancel = (handle: number) => void;

export function createAnimationFrameCoalescer(
  callback: FrameRequestCallback,
  requestFrame: AnimationFrameRequest = requestAnimationFrame,
  cancelFrame: AnimationFrameCancel = cancelAnimationFrame,
): { schedule: () => void; cancel: () => void } {
  let pendingFrame: number | undefined;

  return {
    schedule(): void {
      if (pendingFrame !== undefined) return;
      pendingFrame = requestFrame((timestamp) => {
        pendingFrame = undefined;
        callback(timestamp);
      });
    },
    cancel(): void {
      if (pendingFrame === undefined) return;
      cancelFrame(pendingFrame);
      pendingFrame = undefined;
    },
  };
}
