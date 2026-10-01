import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cachePastedAttachment } from "../app/attachment-io";
import { copyContextImage, openContextImage } from "./image-context-actions";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeImage: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../app/attachment-io", () => ({ cachePastedAttachment: vi.fn().mockResolvedValue({ path: "/cache/image.png" }) }));

function image(overrides: Partial<HTMLImageElement> = {}) {
  return {
    complete: true, naturalWidth: 2, naturalHeight: 2, isConnected: true,
    dataset: {}, src: "data:image/png;base64,AA==", currentSrc: "",
    ownerDocument: { createElement: () => ({
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback: (blob: Blob) => void) => callback(new Blob([new Uint8Array([1, 2, 3])])),
    }) }, ...overrides,
  } as unknown as HTMLImageElement;
}

describe("image context actions", () => {
  beforeEach(() => vi.clearAllMocks());
  it("opens approved local images through the backend, not an editor or URL", async () => {
    await openContextImage(image({ dataset: { imagePath: "/project/chart.svg" } }), () => true);
    expect(invoke).toHaveBeenCalledWith("open_attachment", { path: "/project/chart.svg" });
    expect(openUrl).not.toHaveBeenCalled();
  });
  it("opens remote image URLs", async () => {
    await openContextImage(image({ src: "https://example.com/image.png" }), () => true);
    expect(openUrl).toHaveBeenCalledWith("https://example.com/image.png");
  });
  it("copies encoded image pixels, not text", async () => {
    await copyContextImage(image(), () => true);
    expect(writeImage).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });
  it("does not copy after conversion becomes stale", async () => {
    let active = true;
    const pending = copyContextImage(image(), () => active);
    active = false;
    await pending;
    expect(writeImage).not.toHaveBeenCalled();
  });
  it("does not launch after a data-image cache completion becomes stale", async () => {
    vi.stubGlobal("File", class { constructor(..._args: unknown[]) {} });
    let active = true;
    vi.mocked(cachePastedAttachment).mockImplementationOnce(async () => {
      active = false;
      return { path: "/cache/image.png" } as Awaited<ReturnType<typeof cachePastedAttachment>>;
    });
    try {
      await openContextImage(image(), () => active);
      expect(cachePastedAttachment).toHaveBeenCalledOnce();
      expect(invoke).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
  it("rejects unloaded/oversized images and unsupported external sources", async () => {
    await expect(copyContextImage(image({ complete: false }), () => true)).rejects.toThrow("not loaded");
    await expect(copyContextImage(image({ naturalWidth: 100000, naturalHeight: 100000 }), () => true)).rejects.toThrow("too large");
    await expect(openContextImage(image({ src: "javascript:alert(1)" }), () => true)).rejects.toThrow("supported external source");
  });
});
