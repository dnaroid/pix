import { describe, expect, it } from "vitest";
import { MarkdownImageRetention } from "./markdown-image-retention";

type FakeMedia = HTMLElement & { replacedBy?: FakeMedia };

function media(kind: string, path: string): FakeMedia {
  const element = {
    dataset: { projectMedia: kind, projectFile: path } as DOMStringMap,
    outerHTML: `<figure data-project-media="${kind}" data-project-file="${path}"></figure>`,
    replaceWith(next: FakeMedia) { element.replacedBy = next; },
  } as unknown as FakeMedia;
  return element;
}

function root(children: FakeMedia[]): HTMLElement {
  return { querySelectorAll: () => children } as unknown as HTMLElement;
}

describe("Markdown media retention", () => {
  it("keeps a hydrated video across streamed {@html} replacements", () => {
    const retention = new MarkdownImageRetention("video");
    const playing = media("video", "clip.mp4");
    retention.restore(root([playing]));

    const regenerated = media("video", "clip.mp4");
    retention.restore(root([regenerated]));
    expect(regenerated.replacedBy).toBe(playing);

    const other = media("video", "other.mp4");
    retention.restore(root([other]));
    expect(other.replacedBy).toBeUndefined();
  });

  it("ignores other media kinds", () => {
    const retention = new MarkdownImageRetention("video");
    const image = media("image", "shot.png");
    retention.restore(root([image]));
    const regenerated = media("image", "shot.png");
    retention.restore(root([regenerated]));
    expect(regenerated.replacedBy).toBeUndefined();
  });
});
