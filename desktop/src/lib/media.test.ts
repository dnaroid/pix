import { describe, expect, it } from "vitest";
import { attachmentKind, mimeTypeForName } from "./attachments";
import { previewMediaKindForPath } from "./media";

const AUDIO_EXTENSIONS = ["aac", "aif", "aiff", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav"];

describe("Preview media classification", () => {
  it.each(AUDIO_EXTENSIONS)("supports %s without changing prompt attachment kinds", (extension) => {
    const path = `/Music/Track.${extension.toUpperCase()}`;
    expect(previewMediaKindForPath(path)).toBe("audio");
    expect(mimeTypeForName(path)).toMatch(/^audio\//);
    expect(attachmentKind(mimeTypeForName(path))).toBe("file");
  });
  it("preserves image, video, model and ordinary-file routing", () => {
    expect(previewMediaKindForPath("plot.png")).toBe("image");
    expect(previewMediaKindForPath("clip.mp4")).toBe("video");
    expect(previewMediaKindForPath("scene.glb")).toBe("model");
    expect(previewMediaKindForPath("readme.md")).toBeUndefined();
    expect(previewMediaKindForPath("track.mid")).toBeUndefined();
  });
});
