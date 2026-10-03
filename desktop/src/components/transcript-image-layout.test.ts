import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { Attachment } from "../lib/attachments";
import { renderMarkdown } from "../lib/markdown";
import AttachmentGrid from "./AttachmentGrid.svelte";
import markdownSource from "./MarkdownText.svelte?raw";
import { imageDimensions, imagePreviewStyle } from "../lib/image-preview-layout";

const image: Attachment = {
  id: "image-1",
  name: "preview.png",
  kind: "image",
  mimeType: "image/png",
  deferredImageId: "deferred-1",
};

function renderAttachment(attachment: Attachment, variant: "chat" | "tool" | "composer" = "chat") {
  return render(AttachmentGrid, {
    props: { attachments: [attachment], variant, onOpen: () => {}, onPrepare: async () => {} },
  }).body;
}

describe("transcript image layout reservation", () => {
  it("uses natural chat image sizing, not fixed squares", () => {
    const loading = renderAttachment(image);
    const ready = renderAttachment({ ...image, dataUrl: "data:image/png;base64,AA==" });
    for (const html of [loading, ready]) {
      expect(html).toContain("w-fit max-w-full place-items-center");
      expect(html).not.toContain("h-80 w-80");
      expect(html).toContain('aria-label="Preview preview.png"');
    }
    expect(loading).not.toContain("<img");
    expect(ready).toContain("max-h-80 w-auto max-w-full object-contain");
  });

  it("leaves composer and tool thumbnails and file tiles compact", () => {
    expect(renderAttachment(image, "composer")).toContain("h-16 w-20");
    expect(renderAttachment(image, "tool")).toContain("h-28 w-40");
    expect(renderAttachment({ ...image, kind: "file" })).toContain("h-28 w-40");
    expect(renderAttachment(image, "tool")).not.toContain("h-80 w-80");
  });

  it.each([
    ["![preview](./preview.png)", "data-project-media"],
    ["![preview](file:///tmp/preview.png)", "data-local-media"],
  ])("keeps the reserved image selector in loading markup as Markdown streams: %s", (source, attribute) => {
    for (const tail of ["", "\n\nMore", "\n\nMore streamed text"]) {
      const html = renderMarkdown(source + tail);
      expect(html).toContain(`${attribute}="image"`);
      expect(html).toContain('class="markdown-media-frame"');
      expect(html).toContain("Loading preview…");
    }
    // Image-only CSS leaves the action's natural dimension reservation intact.
    expect(markdownSource).toContain(`.markdown-media[${attribute}="image"] .markdown-media-frame`);
    expect(markdownSource).not.toContain("width: 20rem;\n    height: 20rem;");
    expect(markdownSource).toContain(`.markdown-media[${attribute}="image"] .markdown-media-content`);
    expect(markdownSource).toContain("object-fit: contain;");
  });

  it.each([[1600, 400, 112], [400, 1600, 7], [100, 100, 28]])(
    "reserves %sx%s natural proportions within width and height caps", (width, height, cap) => {
      expect(imagePreviewStyle(imageDimensions(width, height), 28)).toBe(
        `width: min(100%, ${width}px, ${cap}rem); aspect-ratio: ${width} / ${height};`,
      );
    },
  );

  it("does not invent dimensions before load or accept invalid dimensions", () => {
    expect(imagePreviewStyle(undefined, 20)).toBeUndefined();
    for (const value of [0, -1, NaN, Infinity]) {
      expect(imageDimensions(value, 200)).toBeUndefined();
      expect(imageDimensions(200, value)).toBeUndefined();
    }
  });
});
