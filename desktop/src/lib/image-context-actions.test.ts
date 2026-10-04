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

function localImage() {
  const decoded = image({
    decode: vi.fn().mockResolvedValue(undefined),
    removeAttribute: vi.fn(),
  });
  const original = image({
    dataset: { imagePath: "/project/chart.svg" },
    src: "asset://localhost/project/chart.svg",
  });
  const drawImage = vi.fn((target: HTMLImageElement) => {
    if (target === original) throw new DOMException("The operation is insecure.", "SecurityError");
  });
  const createElement = vi.fn((tag: string) => tag === "img" ? decoded : {
    getContext: () => ({ drawImage }),
    toBlob: (callback: (blob: Blob) => void) => callback(new Blob([new Uint8Array([1, 2, 3])])),
  });
  Object.assign(original, { ownerDocument: { createElement } });
  Object.assign(decoded, { ownerDocument: { createElement } });
  vi.mocked(invoke).mockResolvedValueOnce("PHN2Zy8+");
  return { original, decoded, createElement, drawImage };
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
  it("keeps embedded image pixels usable even when their original path no longer exists", async () => {
    await copyContextImage(image({ dataset: { imagePath: "/removed/original.png" } }), () => true);
    expect(invoke).not.toHaveBeenCalled();
    expect(writeImage).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
  });
  it("copies approved local bytes without drawing the tainted asset image", async () => {
    const { original, decoded, drawImage } = localImage();
    await copyContextImage(original, () => true);
    expect(invoke).toHaveBeenCalledWith("read_attachment_base64", { path: "/project/chart.svg" });
    expect(decoded.src).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(decoded.decode).toHaveBeenCalledOnce();
    expect(drawImage).toHaveBeenCalledWith(decoded, 0, 0);
    expect(writeImage).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(decoded.removeAttribute).toHaveBeenCalledWith("src");
  });
  it("does not start reads for inactive menus", async () => {
    await copyContextImage(image({ dataset: { imagePath: "/project/image.png" } }), () => false);
    expect(invoke).not.toHaveBeenCalled();
    expect(writeImage).not.toHaveBeenCalled();
  });
  it.each(["inactive", "detached", "source", "path"])("drops a local read that becomes stale: %s", async (reason) => {
    const { original, createElement } = localImage();
    let active = true;
    const pending = copyContextImage(original, () => active);
    if (reason === "inactive") active = false;
    if (reason === "detached") Object.assign(original, { isConnected: false });
    if (reason === "source") original.src = "asset://localhost/other.png";
    if (reason === "path") original.dataset.imagePath = "/project/other.png";
    await pending;
    expect(createElement).not.toHaveBeenCalled();
    expect(writeImage).not.toHaveBeenCalled();
  });
  it("releases the decode image when decoding completes after disposal", async () => {
    const { original, decoded, drawImage } = localImage();
    let active = true;
    vi.mocked(decoded.decode).mockImplementationOnce(async () => { active = false; });
    await copyContextImage(original, () => active);
    expect(drawImage).not.toHaveBeenCalled();
    expect(writeImage).not.toHaveBeenCalled();
    expect(decoded.removeAttribute).toHaveBeenCalledWith("src");
  });
  it("releases the decode image on failure without changing the clipboard", async () => {
    const { original, decoded } = localImage();
    vi.mocked(decoded.decode).mockRejectedValueOnce(new Error("Invalid image"));
    await expect(copyContextImage(original, () => true)).rejects.toThrow("Invalid image");
    expect(writeImage).not.toHaveBeenCalled();
    expect(decoded.removeAttribute).toHaveBeenCalledWith("src");
  });
  it("rechecks pixel bounds on the newly read file", async () => {
    const { original, decoded, drawImage } = localImage();
    Object.assign(decoded, { naturalWidth: 100000, naturalHeight: 100000 });
    await expect(copyContextImage(original, () => true)).rejects.toThrow("too large");
    expect(drawImage).not.toHaveBeenCalled();
    expect(writeImage).not.toHaveBeenCalled();
    expect(decoded.removeAttribute).toHaveBeenCalledWith("src");
  });
  it("propagates backend approval/size errors without a canvas fallback", async () => {
    const { original, createElement } = localImage();
    vi.mocked(invoke).mockReset().mockRejectedValueOnce(new Error("not approved"));
    await expect(copyContextImage(original, () => true)).rejects.toThrow("not approved");
    expect(createElement).not.toHaveBeenCalled();
    expect(writeImage).not.toHaveBeenCalled();
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
