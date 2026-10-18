import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { copyContextImage } from "./image-context-actions";
import { copyPreviewFile, copyPreviewMedia, previewCopyFilePath } from "./preview-media-copy";
import type { Attachment } from "./attachments";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./image-context-actions", () => ({ copyContextImage: vi.fn().mockResolvedValue(undefined) }));

const video: Attachment = { id: "video", kind: "video", name: "clip.mp4", mimeType: "video/mp4", path: "/project/clip.mp4" };
const image: Attachment = { id: "image", kind: "image", name: "chart.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AA==" };

describe("Preview media copy", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["notes.md", "chart.png", "audio.wav", "model.glb", "clip.mp4"])("resolves project file copy paths: %s", (path) => {
    expect(previewCopyFilePath(path, "/project/")).toBe(`/project/${path}`);
  });

  it("preserves absolute/home paths and rejects invalid or unavailable targets", () => {
    expect(previewCopyFilePath("/tmp/chart.png", "/project")).toBe("/tmp/chart.png");
    expect(previewCopyFilePath("~/notes.md", "/project")).toBe("~/notes.md");
    for (const path of [undefined, "", "../escape.txt", "https://example.com/file", "bad\0path"]) {
      expect(previewCopyFilePath(path, "/project")).toBeUndefined();
    }
    expect(previewCopyFilePath("notes.md", "")).toBeUndefined();
  });

  it("copies any local file using the existing native pasteboard action", async () => {
    await copyPreviewFile("/project/notes.md", () => true);
    expect(invoke).toHaveBeenCalledWith("preview_file_action", { path: "/project/notes.md", action: "copy" });
  });

  it("does not copy a file from an obsolete preview", async () => {
    await copyPreviewFile("/project/notes.md", () => false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("copies image pixels using the existing guarded image pipeline", async () => {
    const element = {} as HTMLImageElement;
    const isCurrent = () => true;
    await copyPreviewMedia(image, element, isCurrent);
    expect(copyContextImage).toHaveBeenCalledWith(element, isCurrent);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("copies videos as native files, not paths or image bytes", async () => {
    await copyPreviewMedia(video, undefined, () => true);
    expect(invoke).toHaveBeenCalledWith("preview_file_action", { path: video.path, action: "copy" });
    expect(copyContextImage).not.toHaveBeenCalled();
  });

  it("ignores stale requests", async () => {
    await copyPreviewMedia(video, undefined, () => false);
    await copyPreviewMedia(image, {} as HTMLImageElement, () => false);
    expect(invoke).not.toHaveBeenCalled();
    expect(copyContextImage).not.toHaveBeenCalled();
  });

  it("rejects unavailable images and videos without a local file", async () => {
    await expect(copyPreviewMedia(image, undefined, () => true)).rejects.toThrow("not loaded");
    await expect(copyPreviewMedia({ ...video, path: undefined }, undefined, () => true)).rejects.toThrow("no local file");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("propagates native failures for the button's status and diagnostic logger", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("clipboard unavailable"));
    await expect(copyPreviewMedia(video, undefined, () => true)).rejects.toThrow("clipboard unavailable");
  });
});
