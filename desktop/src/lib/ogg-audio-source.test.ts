import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeOggSource } from "./ogg-audio-source";

const workers = vi.hoisted(() => [] as Array<{
  onmessage?: (event: { data: { wav?: ArrayBuffer; error?: string } }) => void;
  onerror?: (event: { preventDefault(): void }) => void;
  onmessageerror?: () => void;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}>);
vi.mock("./ogg-audio.worker?worker", () => ({ default: class {
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { workers.push(this); }
} }));

beforeEach(() => {
  workers.length = 0;
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:decoded");
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Ogg decoding worker ownership", () => {
  it("serializes workers, removes cancelled queued work, and ignores duplicate completions", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const a = decodeOggSource("asset:first", first.signal);
    const b = decodeOggSource("asset:second", second.signal);
    const rejected = expect(b).rejects.toMatchObject({ name: "AbortError" });
    expect(workers).toHaveLength(1);
    second.abort();
    await rejected;
    workers[0]!.onmessage?.({ data: { wav: new ArrayBuffer(44) } });
    workers[0]!.onmessage?.({ data: { wav: new ArrayBuffer(44) } });
    await expect(a).resolves.toBe("blob:decoded");
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(workers).toHaveLength(1);
  });

  it("terminates an active job on abort and starts the next queued job", async () => {
    const abort = new AbortController();
    const a = decodeOggSource("asset:first", abort.signal);
    const rejected = expect(a).rejects.toMatchObject({ name: "AbortError" });
    const b = decodeOggSource("asset:second", new AbortController().signal);
    abort.abort();
    await rejected;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(workers).toHaveLength(2);
    workers[1]!.onmessage?.({ data: { wav: new ArrayBuffer(44) } });
    await b;
  });

  it("bounds worker time and reports startup/decode failures", async () => {
    vi.useFakeTimers();
    const timeout = decodeOggSource("asset:timeout", new AbortController().signal);
    const rejected = expect(timeout).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30000);
    await rejected;
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    const bad = decodeOggSource("asset:bad", new AbortController().signal);
    workers[1]!.onmessage?.({ data: { error: "Invalid Ogg" } });
    await expect(bad).rejects.toThrow("Invalid Ogg");
    const startup = decodeOggSource("asset:startup", new AbortController().signal);
    workers[2]!.onerror?.({ preventDefault() {} });
    await expect(startup).rejects.toThrow("could not start");
    const unreadable = decodeOggSource("asset:unreadable", new AbortController().signal);
    workers[3]!.onmessageerror?.();
    await expect(unreadable).rejects.toThrow("unreadable message");
  });
});
