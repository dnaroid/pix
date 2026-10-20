import { beforeEach, describe, expect, it, vi } from "vitest";
import { audioSource } from "./audio-source-action";

const decoding = vi.hoisted(() => ({ decode: vi.fn(), report: vi.fn(), record: vi.fn() }));
vi.mock("../lib/ogg-audio-source", () => ({
  decodeOggSource: decoding.decode,
  isOggAudioPath: (path: string) => /\.(ogg|oga|opus)$/i.test(path),
}));
vi.mock("../lib/diagnostic-logging", () => ({ createDiagnosticLogger: () => decoding }));

class AudioNode extends EventTarget {
  src = "";
  readyState = 3;
  error = { code: 4 };
  pause = vi.fn();
  play = vi.fn(async () => {});
  removeAttribute = vi.fn(() => { this.src = ""; });
  load = vi.fn();
}

function deferred() {
  let resolve!: (url: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); }

beforeEach(() => { vi.clearAllMocks(); vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {}); });

describe("shared inline/Preview audio source", () => {
  it("starts Files autoplay at metadata readiness, without waiting for metadata-only preload to reach canplay", () => {
    const node = new AudioNode();
    node.readyState = 1;
    const action = audioSource(node as unknown as HTMLAudioElement, {
      source: "asset:mp3", path: "track.mp3", autoplay: true, onUnavailable: vi.fn(),
    });
    node.dispatchEvent(new Event("loadedmetadata"));
    expect(node.play).toHaveBeenCalledOnce();
    action.destroy();
  });

  it.each([false, true])("retries metadata -> native play -> unsupported source only while still active (hide=%s)", async (hide) => {
    const node = new AudioNode();
    node.readyState = 1;
    const pending = deferred();
    decoding.decode.mockReturnValue(pending.promise);
    const options = { source: "asset:ogg", path: "track.ogg", active: true, autoplay: true,
      onAutoplayConsumed: vi.fn(), onUnavailable: vi.fn() };
    const action = audioSource(node as unknown as HTMLAudioElement, options);
    node.dispatchEvent(new Event("loadedmetadata"));
    expect(node.play).toHaveBeenCalledOnce();
    node.dispatchEvent(new Event("error"));
    if (hide) action.update({ ...options, active: false, autoplay: false });
    pending.resolve("blob:wav");
    await flush();
    expect(node.removeAttribute).toHaveBeenCalledWith("src");
    expect(node.load).toHaveBeenCalledOnce();
    expect(node.src).toBe("blob:wav");
    node.dispatchEvent(new Event("loadedmetadata"));
    expect(node.play).toHaveBeenCalledTimes(hide ? 1 : 2);
    expect(options.onAutoplayConsumed).toHaveBeenCalledOnce();
    action.destroy();
  });

  it("does not reconsume autoplay on a same-key source change", () => {
    const node = new AudioNode();
    const options = { source: "asset:first", path: "first.mp3", autoplay: true,
      onAutoplayConsumed: vi.fn(), onUnavailable: vi.fn() };
    const action = audioSource(node as unknown as HTMLAudioElement, options);
    action.update({ ...options, source: "asset:second", path: "second.mp3" });
    node.dispatchEvent(new Event("loadedmetadata"));
    expect(options.onAutoplayConsumed).toHaveBeenCalledOnce();
    expect(node.play).not.toHaveBeenCalled();
    action.destroy();
  });

  it("preserves a native user Play request across the codec fallback", async () => {
    const node = new AudioNode();
    decoding.decode.mockResolvedValue("blob:wav");
    const action = audioSource(node as unknown as HTMLAudioElement, {
      source: "asset:ogg", path: "track.ogg", onUnavailable: vi.fn(),
    });
    node.dispatchEvent(new Event("play"));
    node.dispatchEvent(new Event("error"));
    await flush();
    node.dispatchEvent(new Event("loadedmetadata"));
    expect(node.play).toHaveBeenCalledOnce();
    action.destroy();
  });

  it("also handles a native decode error before metadata, but not a mid-stream decode error", async () => {
    const node = new AudioNode();
    node.readyState = 0;
    node.error.code = 3;
    decoding.decode.mockResolvedValue("blob:wav");
    const onUnavailable = vi.fn();
    const action = audioSource(node as unknown as HTMLAudioElement, {
      source: "asset:ogg", path: "track.ogg", onUnavailable,
    });
    node.dispatchEvent(new Event("error"));
    await flush();
    expect(node.src).toBe("blob:wav");
    expect(onUnavailable).not.toHaveBeenCalled();
    action.destroy();
  });

  it("falls back once, defers error UI, and preserves a pending Files autoplay", async () => {
    const node = new AudioNode();
    const pending = deferred();
    decoding.decode.mockReturnValue(pending.promise);
    const options = { source: "asset:track", path: "track.OGG", autoplay: true,
      onAutoplayConsumed: vi.fn(), onUnavailable: vi.fn() };
    const action = audioSource(node as unknown as HTMLAudioElement, options);
    expect(options.onAutoplayConsumed).toHaveBeenCalledOnce();
    node.dispatchEvent(new Event("error"));
    node.dispatchEvent(new Event("error"));
    expect(decoding.decode).toHaveBeenCalledOnce();
    expect(options.onUnavailable).not.toHaveBeenCalled();
    pending.resolve("blob:wav");
    await flush();
    expect(node.src).toBe("blob:wav");
    node.dispatchEvent(new Event("canplay"));
    node.dispatchEvent(new Event("canplay"));
    expect(node.play).toHaveBeenCalledOnce();
    expect(options.onAutoplayConsumed).toHaveBeenCalledOnce();
    action.destroy();
    action.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:wav");
  });

  it("does not autoplay after hiding and returning during decoding", async () => {
    const node = new AudioNode();
    const pending = deferred();
    decoding.decode.mockReturnValue(pending.promise);
    const options = { source: "asset:track", path: "track.opus", active: true, autoplay: true, onUnavailable: vi.fn() };
    const action = audioSource(node as unknown as HTMLAudioElement, options);
    node.dispatchEvent(new Event("error"));
    action.update({ ...options, active: false, autoplay: false });
    action.update({ ...options, active: true, autoplay: false });
    pending.resolve("blob:wav");
    await flush();
    node.dispatchEvent(new Event("canplay"));
    expect(node.play).not.toHaveBeenCalled();
    action.destroy();
  });

  it.each(["replace", "destroy"])("aborts and releases a stale completion after %s", async (operation) => {
    const node = new AudioNode();
    const pending = deferred();
    decoding.decode.mockReturnValue(pending.promise);
    const options = { source: "asset:old", path: "old.ogg", onUnavailable: vi.fn() };
    const action = audioSource(node as unknown as HTMLAudioElement, options);
    node.dispatchEvent(new Event("error"));
    const signal = decoding.decode.mock.calls[0]![1] as AbortSignal;
    if (operation === "replace") action.update({ ...options, source: "asset:new", path: "new.mp3" });
    else action.destroy();
    expect(signal.aborted).toBe(true);
    pending.resolve("blob:stale");
    await flush();
    expect(node.src).not.toBe("blob:stale");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:stale");
    expect(options.onUnavailable).not.toHaveBeenCalled();
    action.destroy();
  });

  it("shows a final decoder/blob failure once instead of looping", async () => {
    const node = new AudioNode();
    decoding.decode.mockResolvedValue("blob:wav");
    const onUnavailable = vi.fn();
    const action = audioSource(node as unknown as HTMLAudioElement, { source: "asset:track", path: "track.ogg", onUnavailable });
    node.dispatchEvent(new Event("error"));
    await flush();
    node.dispatchEvent(new Event("error"));
    node.dispatchEvent(new Event("error"));
    expect(decoding.decode).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(decoding.report).toHaveBeenCalledOnce();
    action.destroy();
  });

  it.each([["track.mp3", 4], ["track.ogg", 3]])("does not decode non-Ogg or non-codec errors (%s/%s)", (path, code) => {
    const node = new AudioNode();
    node.error.code = Number(code);
    const onUnavailable = vi.fn();
    const action = audioSource(node as unknown as HTMLAudioElement, { source: "asset:track", path: String(path), onUnavailable });
    node.dispatchEvent(new Event("error"));
    expect(decoding.decode).not.toHaveBeenCalled();
    expect(onUnavailable).toHaveBeenCalledOnce();
    action.destroy();
  });
});
