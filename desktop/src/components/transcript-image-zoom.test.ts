import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Node fs import in Vitest runner (frontend tsconfig omits Node globals)
import { readFileSync } from "node:fs";
import viewer from "./ImageViewerWindow.svelte?raw";
import { createTranscriptImageZoom } from "./transcript-image-zoom";

const styles = readFileSync(new URL("../styles/transcript-image-zoom.css", import.meta.url), "utf8");

class Element {
  children: Element[] = [];
  parentElement?: Element;
  className = "";
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  currentSrc = "";
  naturalWidth = 900;
  naturalHeight = 700;
  alt = "";
  type = "";
  title = "";
  onclick?: (event: { preventDefault: () => void; stopPropagation: () => void }) => void;
  constructor(readonly tagName = "span") {}
  get classList() { return { contains: (name: string) => this.className.split(" ").includes(name) }; }
  get firstElementChild() { return this.children[0]; }
  append(child: Element) {
    child.remove();
    this.children.push(child);
    child.parentElement = this;
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((item) => item !== this);
    this.parentElement = undefined;
  }
  before(child: Element) {
    child.remove();
    const parent = this.parentElement!;
    parent.children.splice(parent.children.indexOf(this), 0, child);
    child.parentElement = parent;
  }
  replaceWith(child: Element) { this.before(child); this.remove(); }
  contains(child: Element): boolean { return child === this || this.children.some((item) => item.contains(child)); }
  matches(_selector: string) {
    return this.tagName === "img" && (this.className === "markdown-media-content" || "transcriptImage" in this.dataset);
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(_selector: string) { return this.children.find((child) => child.tagName === "img"); }
  closest(_selector: string): Element | undefined {
    if (this.tagName === "button" || (this.tagName === "a" && this.className === "markdown-media-frame")) return this;
    return this.parentElement?.closest(_selector);
  }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
}

let observer: { callback: (records: { addedNodes: Element[] }[]) => void; disconnect: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.stubGlobal("Element", Element);
  vi.stubGlobal("document", { createElement: (tag: string) => new Element(tag) });
  vi.stubGlobal("MutationObserver", class {
    disconnect = vi.fn();
    observe = vi.fn();
    constructor(public callback: typeof observer.callback) { observer = this; }
  });
});
afterEach(() => vi.unstubAllGlobals());

function setup(attachment = false) {
  const root = new Element("div");
  const frame = new Element(attachment ? "button" : "a");
  if (!attachment) frame.className = "markdown-media-frame";
  const image = new Element("img");
  if (attachment) image.dataset.transcriptImage = "";
  else image.className = "markdown-media-content";
  image.attributes.src = "asset:original.png";
  image.alt = "Diagram";
  frame.append(image);
  root.append(frame);
  const open = vi.fn();
  const action = createTranscriptImageZoom(() => undefined, open)(root as unknown as HTMLElement);
  return { root, frame, image, open, action, wrapper: root.children[0]! };
}

describe("transcript image zoom", () => {
  it.each([false, true])("adds a sibling button without replacing the original image/open target (attachment=%s)", (attachment) => {
    const { wrapper, frame, image, open, action } = setup(attachment);
    expect(wrapper.children[0]).toBe(frame);
    expect(frame.children[0]).toBe(image);
    const button = wrapper.children[1]!;
    expect(button.attributes["aria-label"]).toBe("View full-size image");
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };
    button.onclick!(event);
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith({ src: "asset:original.png", alt: "Diagram", path: undefined, width: 900, height: 700 });
    action.destroy();
  });

  it("uses the current lazy-loaded source and path, and ignores empty sources", () => {
    const { wrapper, image, open, action } = setup();
    const event = { preventDefault() {}, stopPropagation() {} };
    image.currentSrc = "asset:resolved.png";
    image.dataset.imagePath = "/tmp/resolved.png";
    wrapper.children[1]!.onclick!(event);
    expect(open.mock.calls[0]![0]).toMatchObject({ src: "asset:resolved.png", path: "/tmp/resolved.png" });
    image.currentSrc = "";
    delete image.attributes.src;
    wrapper.children[1]!.onclick!(event);
    expect(open).toHaveBeenCalledOnce();
    action.destroy();
  });

  it("does not duplicate controls during streaming/retention and decorates late images", () => {
    const { root, wrapper, image, action } = setup();
    observer.callback([{ addedNodes: [wrapper, image] }]);
    expect(wrapper.children).toHaveLength(2);
    const late = new Element("img");
    late.className = "markdown-media-content";
    root.append(late);
    observer.callback([{ addedNodes: [late] }]);
    expect(root.children[1]!.children[0]).toBe(late);
    expect(root.children[1]!.children).toHaveLength(2);
    action.destroy();
  });

  it("does not use a stale image after attachment fallback/replacement", () => {
    const { frame, image, wrapper, open, action } = setup(true);
    const event = { preventDefault() {}, stopPropagation() {} };
    image.remove();
    wrapper.children[1]!.onclick!(event);
    expect(open).not.toHaveBeenCalled();
    const replacement = new Element("img");
    replacement.dataset.transcriptImage = "";
    replacement.attributes.src = "asset:replacement.png";
    frame.append(replacement);
    observer.callback([{ addedNodes: [replacement] }]);
    expect(wrapper.children).toHaveLength(2);
    wrapper.children[1]!.onclick!(event);
    expect(open.mock.calls[0]![0].src).toBe("asset:replacement.png");
    action.destroy();
  });

  it("skips removed streaming nodes and unrelated images; disconnects and unwraps on teardown", () => {
    const { root, frame, action } = setup();
    const removed = new Element("img");
    removed.className = "markdown-media-content";
    const unrelated = new Element("img");
    root.append(unrelated);
    observer.callback([{ addedNodes: [removed, unrelated] }]);
    expect(root.children).toHaveLength(2);
    action.destroy();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(root.children).toEqual([frame, unrelated]);
  });

  it("does not request an incorrectly sized window before the image has loaded", () => {
    const { wrapper, image, open, action } = setup();
    image.naturalWidth = 0;
    wrapper.children[1]!.onclick!({ preventDefault() {}, stopPropagation() {} });
    expect(open).not.toHaveBeenCalled();
    action.destroy();
  });

  it("keeps zoom keyboard-reachable and uses an independent viewer without a dialog", () => {
    expect(styles).toContain(":focus-within");
    expect(styles).toContain("@media (hover: none)");
    expect(viewer).not.toContain("<dialog");
    expect(viewer).toContain("imageWindowPayload()");
    expect(viewer).toContain('event.key === "Escape"');
    expect(viewer).toContain("getCurrentWindow().close()");
    expect(viewer).toContain("data-tauri-drag-region");
    expect(viewer).toContain("h-auto w-auto max-h-full max-w-full");
  });
});
