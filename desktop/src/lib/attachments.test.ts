import { describe, expect, it } from "vitest";
import {
  attachmentKind,
  attachmentMarker,
  extractAttachmentMarkers,
  filePathFromUri,
  fileUriFromPath,
  mimeTypeForName,
} from "./attachments";

describe("attachments", () => {
  it("classifies previewable image and video extensions", () => {
    expect(attachmentKind(mimeTypeForName("screen.WEBP"))).toBe("image");
    expect(attachmentKind(mimeTypeForName("demo.mp4"))).toBe("video");
    expect(attachmentKind(mimeTypeForName("archive.zip"))).toBe("file");
  });

  it("round-trips Unix and Windows file paths through file URIs", () => {
    expect(filePathFromUri(fileUriFromPath("/tmp/My image.png"))).toBe("/tmp/My image.png");
    expect(filePathFromUri(fileUriFromPath("C:\\Users\\Pix\\clip.mov"))).toBe("C:/Users/Pix/clip.mov");
    expect(fileUriFromPath("C:\\Users\\Pix\\clip.mov")).toBe("file:///C:/Users/Pix/clip.mov");
    expect(filePathFromUri(fileUriFromPath("/tmp/пример #1?.png"))).toBe("/tmp/пример #1?.png");
    expect(filePathFromUri(fileUriFromPath("\\\\server\\share\\my clip.mov"))).toBe("//server/share/my clip.mov");
  });

  it("percent-encodes reserved filename characters instead of treating them as URL syntax", () => {
    expect(fileUriFromPath("/tmp/a#b?.png")).toBe("file:///tmp/a%23b%3F.png");
  });

  it("extracts persisted attachment markers without exposing them as message text", () => {
    const marker = attachmentMarker("/tmp/demo.webm");
    const result = extractAttachmentMarkers(`Watch this\n\n${marker}`, "user:1");

    expect(result.text).toBe("Watch this");
    expect(result.attachments).toEqual([
      expect.objectContaining({
        id: "user:1:attachment:0",
        name: "demo.webm",
        kind: "video",
        path: "/tmp/demo.webm",
      }),
    ]);
  });
});
