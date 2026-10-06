import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_GLB_BYTES } from "./glb";
import { readGlbSource } from "./glb-source";

const RANGE = 1000 * 1024;
function fixture(size = 100): ArrayBuffer {
  const bytes = new ArrayBuffer(size);
  const view = new DataView(bytes);
  const json = new TextEncoder().encode('{"asset":{"version":"2.0"}}');
  const jsonSize = Math.ceil(json.length / 4) * 4;
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, size, true);
  view.setUint32(12, jsonSize, true);
  view.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(bytes, 20, jsonSize).fill(32);
  new Uint8Array(bytes, 20, json.length).set(json);
  return bytes;
}
function response(bytes: ArrayBuffer, start: number, end: number, total = bytes.byteLength): Response {
  return new Response(bytes.slice(start, end + 1), {
    status: 206, headers: { "content-range": `bytes ${start}-${end}/${total}` },
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("bounded GLB asset reads", () => {
  it("assembles native ranges and never issues an unrestricted asset request", async () => {
    const bytes = fixture(RANGE * 2 + 100);
    const fetch = vi.fn(async (_source: string, init: RequestInit) => {
      const [start, end] = (init.headers as Record<string, string>).Range!.slice(6).split("-").map(Number);
      return response(bytes, start!, Math.min(end!, bytes.byteLength - 1));
    });
    vi.stubGlobal("fetch", fetch);
    expect(await readGlbSource("asset://model.glb", new AbortController().signal)).toEqual(bytes);
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, init] of fetch.mock.calls) expect(init.headers).toHaveProperty("Range");
  });
  it("rejects oversized native files before consuming the first bounded response", async () => {
    const first = response(fixture(), 0, 99, MAX_GLB_BYTES + 1);
    const cancel = vi.spyOn(first.body!, "cancel");
    vi.stubGlobal("fetch", vi.fn(async () => first));
    await expect(readGlbSource("asset://large.glb", new AbortController().signal)).rejects.toThrow("64 MiB");
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects an unrestricted response rather than retrying without Range", async () => {
    const fetch = vi.fn(async () => new Response(fixture()));
    vi.stubGlobal("fetch", fetch);
    await expect(readGlbSource("asset://model.glb", new AbortController().signal)).rejects.toThrow("bounded");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("rejects inconsistent ranges and truncated bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(fixture(), 1, 99)));
    await expect(readGlbSource("asset://model.glb", new AbortController().signal)).rejects.toThrow("Invalid");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(2), {
      status: 206, headers: { "content-range": "bytes 0-99/100" },
    })));
    await expect(readGlbSource("asset://model.glb", new AbortController().signal)).rejects.toThrow("Incomplete");
  });
  it("does not issue a read for a canceled owner", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const abort = new AbortController(); abort.abort();
    await expect(readGlbSource("asset://model.glb", abort.signal)).rejects.toThrow("Aborted");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("supports an already in-memory attachment without native asset allocation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(fixture())));
    expect(await readGlbSource("blob:attachment", new AbortController().signal)).toEqual(fixture());
  });
});
