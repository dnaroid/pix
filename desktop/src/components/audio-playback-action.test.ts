import { describe, expect, it, vi } from "vitest";
import { audioPlayback, previewMediaPlayback } from "./audio-playback-action";

describe("audio playback ownership", () => {
  it.each(["audio", "video"])("starts %s once and guards late playback after hide/return or destroy", async () => {
    let finish!: () => void;
    const node = { play: vi.fn(() => new Promise<void>((resolve) => { finish = resolve; })), pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() };
    const options = { active: true, autoplay: true, onAutoplayConsumed: vi.fn() };
    const action = previewMediaPlayback(node as unknown as HTMLMediaElement, options);
    expect(node.play).toHaveBeenCalledOnce();
    expect(options.onAutoplayConsumed).toHaveBeenCalledOnce();
    action.update({ ...options, active: false });
    action.update(options);
    finish();
    await Promise.resolve();
    expect(node.pause).toHaveBeenCalledTimes(2);
    expect(node.play).toHaveBeenCalledOnce();
    action.destroy();
    expect(node.removeAttribute).toHaveBeenCalledWith("src");
    expect(node.load).toHaveBeenCalledOnce();
  });

  it("handles denied playback without an unhandled rejection", async () => {
    const node = { play: vi.fn().mockRejectedValue(new Error("denied")), pause: vi.fn() };
    previewMediaPlayback(node as unknown as HTMLMediaElement, { active: true, autoplay: true, onAutoplayConsumed: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();
    expect(node.play).toHaveBeenCalledOnce();
  });

  it.each([false, true])("never plays a hidden preview (request=%s)", (autoplay) => {
    const node = { play: vi.fn(), pause: vi.fn() };
    const options = { active: false, autoplay, onAutoplayConsumed: vi.fn() };
    const action = previewMediaPlayback(node as unknown as HTMLMediaElement, options);
    action.update({ ...options, active: true });
    expect(node.play).not.toHaveBeenCalled();
  });
  it("pauses inactive Preview without auto-playing on return, and releases its source on close", () => {
    const audio = { pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn() };
    const action = audioPlayback(audio as unknown as HTMLAudioElement, false);
    expect(audio.pause).toHaveBeenCalledOnce();
    action.update(true);
    expect(audio.pause).toHaveBeenCalledOnce();
    action.update(false);
    expect(audio.pause).toHaveBeenCalledTimes(2);
    expect(audio.removeAttribute).not.toHaveBeenCalled();
    action.destroy();
    expect(audio.pause).toHaveBeenCalledTimes(3);
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(audio.load).toHaveBeenCalledOnce();
  });
});
