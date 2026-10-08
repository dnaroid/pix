import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMarkdownContentAction } from "./markdown-content-action";
import type { Attachment } from "../lib/attachments";

vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (path: string) => `asset:${path}` }));
vi.mock("../lib/mermaid", () => ({ renderMermaidDiagram: vi.fn() }));
const glb = vi.hoisted(() => ({ mount: vi.fn(() => vi.fn()) }));
vi.mock("./glb-viewer-action", () => ({ mountGlbViewer: glb.mount }));

// Minimal DOM surface: deterministic hydration, dimensions and lifecycle tests.
class Element {
  children: Element[] = [];
  parent?: Element;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners = new Map<string, () => void>();
  className = "";
  naturalWidth = 0;
  naturalHeight = 0;
  src = "";
  controls = false;
  preload = "";
  pause = vi.fn();
  load = vi.fn();
  textContent = "";
  get outerHTML() { return JSON.stringify(this.dataset); }
  append(child: Element) { this.children.push(child); child.parent = this; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
  contains(child: Element): boolean { return this.children.some((item) => item === child || item.contains(child)); }
  replaceWith(next: Element) {
    if (!this.parent) return;
    this.parent.children = this.parent.children.map((child) => child === this ? next : child);
    next.parent = this.parent;
    this.parent = undefined;
  }
  replaceChildren(child: Element) { this.children = []; this.append(child); }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => {
      const match = selector.includes(".markdown-media[") ? child.className === "markdown-media"
        : selector === ".markdown-media-frame" ? child.className === "markdown-media-frame" : false;
      return [...(match ? [child] : []), ...child.querySelectorAll(selector)];
    });
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

class Observer {
  static instances: Observer[] = [];
  targets = new Set<Element>();
  constructor(private callback: (entries: { target: Element; isIntersecting: boolean }[], observer: Observer) => void) {
    Observer.instances.push(this);
  }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  intersect(target: Element) { this.callback([{ target, isIntersecting: true }], this); }
}

function preview(scope = "project", path = "preview.png", kind = "image") {
  const node = new Element();
  node.className = "markdown-media";
  node.dataset[`${scope}File`] = path;
  node.dataset[`${scope}Media`] = kind;
  const frame = new Element();
  frame.className = "markdown-media-frame";
  node.append(frame);
  return node;
}

const attachment: Attachment = { id: "image", name: "preview.png", kind: "image", mimeType: "image/png", path: "/preview.png" };
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function intersect(node: Element) {
  [...Observer.instances].reverse().find((observer) => observer.targets.has(node))!.intersect(node);
}
function setup(resolver = vi.fn(async () => attachment)) {
  const root = new Element();
  const first = preview();
  root.append(first);
  const action = createMarkdownContentAction({
    externalLinkIconTemplate: () => undefined,
    onValidateProjectFile: () => undefined,
    onValidateLocalFile: () => undefined,
    onResolveProjectMedia: () => resolver,
    onResolveLocalMedia: () => resolver,
  })(root as unknown as HTMLElement, "initial");
  return { root, first, action, resolver };
}

beforeEach(() => {
  glb.mount.mockClear();
  Observer.instances = [];
  vi.stubGlobal("HTMLElement", Element);
  vi.stubGlobal("document", { createElement: () => new Element() });
  vi.stubGlobal("window", { matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }) });
  vi.stubGlobal("IntersectionObserver", Observer);
});
afterEach(() => vi.unstubAllGlobals());

describe("Markdown natural image reservation", () => {
  it("retains distinct audio players through streaming and stops removed or destroyed players", async () => {
    const audioFile: Attachment = { id: "audio", name: "track.mp3", kind: "file", mimeType: "audio/mpeg", path: "/track.mp3" };
    const { root, first, action, resolver } = setup(vi.fn(async () => audioFile));
    first.dataset.projectMedia = "audio";
    first.dataset.projectFile = "track.mp3";
    const second = preview("project", "track.mp3", "audio");
    root.append(second);
    await flush();
    intersect(first);
    intersect(second);
    await flush();
    const players = [first.children[0]!.children[0]!, second.children[0]!.children[0]!];
    expect(players[0]).not.toBe(players[1]);
    expect(players[0]).toMatchObject({ src: "asset:/track.mp3", controls: true, preload: "metadata" });
    root.children = [];
    root.append(preview("project", "track.mp3", "audio"));
    root.append(preview("project", "track.mp3", "audio"));
    action.update("streaming audio");
    await flush();
    expect(root.children).toEqual([first, second]);
    expect(first.children[0]!.children[0]).toBe(players[0]);
    expect(players[0]!.pause).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledOnce();
    root.children = [first];
    action.update("removed duplicate");
    await flush();
    expect(players[1]!.pause).toHaveBeenCalledOnce();
    expect(players[1]!.load).toHaveBeenCalledOnce();
    expect(players[0]!.pause).not.toHaveBeenCalled();
    action.destroy();
    expect(players[0]!.pause).toHaveBeenCalledOnce();
    expect(players[0]!.load).toHaveBeenCalledOnce();
  });

  it.each(["remove", "destroy"])("ignores pending audio resolution after %s", async (operation) => {
    let complete!: (value: Attachment) => void;
    const { root, first, action } = setup(vi.fn(() => new Promise<Attachment>((resolve) => { complete = resolve; })));
    first.dataset.projectMedia = "audio";
    first.dataset.projectFile = "track.mp3";
    await flush();
    intersect(first);
    if (operation === "remove") { root.children = []; action.update("removed audio"); await flush(); }
    else action.destroy();
    complete({ id: "audio", name: "track.mp3", kind: "file", mimeType: "audio/mpeg", path: "/track.mp3" });
    await flush();
    expect(first.children[0]!.children).toHaveLength(0);
    action.destroy();
  });

  it("keeps a readable audio error through streaming without reloading", async () => {
    const audioFile: Attachment = { id: "audio", name: "track.mp3", kind: "file", mimeType: "audio/mpeg", path: "/track.mp3" };
    const { root, first, action } = setup(vi.fn(async () => audioFile));
    first.dataset.projectMedia = "audio";
    first.dataset.projectFile = "track.mp3";
    await flush();
    intersect(first);
    await flush();
    const player = first.children[0]!.children[0]!;
    player.listeners.get("error")!();
    expect(first.dataset.mediaState).toBe("error");
    expect(player.pause).toHaveBeenCalledOnce();
    root.replaceChildren(preview("project", "track.mp3", "audio"));
    action.update("more streaming");
    await flush();
    intersect(first);
    await flush();
    expect(first.children[0]!.children[0]!.textContent).toBe("Preview unavailable");
    action.destroy();
    expect(player.pause).toHaveBeenCalledOnce();
  });

  it("retains GLB viewers and camera ownership across streaming, releasing removed occurrences", async () => {
    const model: Attachment = { id: "model", name: "chair.glb", kind: "file", mimeType: "model/gltf-binary", path: "/chair.glb" };
    const { root, first, action, resolver } = setup(vi.fn(async () => model));
    first.dataset.projectMedia = "model";
    first.dataset.projectFile = "chair.glb";
    const second = preview("project", "chair.glb", "model");
    root.append(second);
    await flush();
    intersect(first);
    intersect(second);
    await flush();
    expect(glb.mount).toHaveBeenCalledTimes(2);
    const disposers = glb.mount.mock.results.map((result) => result.value);
    root.children = [];
    root.append(preview("project", "chair.glb", "model"));
    root.append(preview("project", "chair.glb", "model"));
    action.update("streamed model links");
    await flush();
    expect(root.children).toEqual([first, second]);
    expect(glb.mount).toHaveBeenCalledTimes(2);
    expect(resolver).toHaveBeenCalledOnce();
    root.children = [first];
    action.update("removed second model");
    await flush();
    expect(disposers[0]).not.toHaveBeenCalled();
    expect(disposers[1]).toHaveBeenCalledOnce();
    action.destroy();
    expect(disposers[0]).toHaveBeenCalledOnce();
    expect(disposers[1]).toHaveBeenCalledOnce();
  });

  it("does not mount a GLB viewer after a delayed resolver's owner is destroyed", async () => {
    let complete!: (value: Attachment) => void;
    const { first, action } = setup(vi.fn(() => new Promise<Attachment>((resolve) => { complete = resolve; })));
    first.dataset.projectMedia = "model";
    first.dataset.projectFile = "chair.glb";
    await flush();
    intersect(first);
    action.destroy();
    complete({ id: "model", name: "chair.glb", kind: "file", mimeType: "model/gltf-binary", path: "/chair.glb" });
    await flush();
    expect(glb.mount).not.toHaveBeenCalled();
  });
  it("retains the loaded image and its proportions before lazy observers on streaming replacements", async () => {
    const { root, first, action, resolver } = setup();
    await flush();
    expect(first.children[0]!.getAttribute("style")).toBeNull();
    intersect(first);
    await flush();
    const image = first.children[0]!.children[0]!;
    image.naturalWidth = 1600;
    image.naturalHeight = 400;
    image.listeners.get("load")!();
    const style = "width: min(100%, 1600px, 112rem); aspect-ratio: 1600 / 400;";
    expect(first.children[0]!.getAttribute("style")).toBe(style);

    for (let i = 0; i < 4; i++) {
      const next = preview();
      root.replaceChildren(next);
      action.update(`stream ${i}`);
      await flush();
      expect(root.children[0]).toBe(first);
      expect(first.children[0]!.getAttribute("style")).toBe(style);
      if (i < 3) expect(first.children[0]!.children[0]).toBe(image);
      if (i === 2) {
        image.listeners.get("error")!();
        expect(first.children[0]!.getAttribute("style")).toBe(style);
        expect(first.dataset.mediaState).toBe("error");
      }
      if (i === 3) {
        intersect(first);
        await flush();
        expect(first.dataset.mediaState).toBe("error");
        expect(first.children[0]!.children[0]!.textContent).toBe("Preview unavailable");
      }
    }
    expect(resolver).toHaveBeenCalledTimes(1);
    action.destroy();
    expect(Observer.instances.every((observer) => observer.targets.size === 0)).toBe(true);
  });

  it("does not share dimensions across scope, path or media kind", async () => {
    const { root, first, action } = setup();
    await flush();
    intersect(first);
    await flush();
    const image = first.children[0]!.children[0]!;
    image.naturalWidth = 400;
    image.naturalHeight = 1600;
    image.listeners.get("load")!();
    const others = [preview("local"), preview("project", "other.png"), preview("project", "preview.png", "video")];
    root.children = [];
    others.forEach((node) => root.append(node));
    action.update("different media");
    await flush();
    for (const node of others) expect(node.children[0]!.getAttribute("style")).toBeNull();
    action.destroy();
  });

  it.each(["update", "destroy"] as const)("ignores obsolete image DOM completion after %s", async (operation) => {
    const { root, first, action } = setup();
    await flush();
    intersect(first);
    await flush();
    const oldFrame = first.children[0]!;
    const image = oldFrame.children[0]!;
    const next = preview();
    next.dataset.projectMediaLabel = "changed caption";
    root.replaceChildren(next);
    if (operation === "update") action.update("new markup");
    else action.destroy();
    image.naturalWidth = 100;
    image.naturalHeight = 50;
    image.listeners.get("load")!();
    image.listeners.get("error")!();
    expect(oldFrame.getAttribute("style")).toBeNull();
    expect(first.dataset.mediaState).toBe("ready");
    await flush();
    // A late intrinsic measurement may be reused by a newer generation, but
    // never touches obsolete nodes or a destroyed action.
    expect(next.children[0]!.getAttribute("style")).toBe(operation === "destroy" ? null
      : "width: min(100%, 100px, 56rem); aspect-ratio: 100 / 50;");
    action.destroy();
  });

  it("does not attach media when its resolver completes after teardown", async () => {
    let resolve!: (value: Attachment) => void;
    const { first, action } = setup(vi.fn(() => new Promise<Attachment>((done) => { resolve = done; })));
    await flush();
    intersect(first);
    action.destroy();
    resolve(attachment);
    await flush();
    expect(first.children[0]!.children).toHaveLength(0);
  });

  it("keeps duplicate occurrences distinct and releases removed previews", async () => {
    const { root, first, action } = setup();
    const second = preview();
    root.append(second);
    await flush();
    intersect(first);
    intersect(second);
    await flush();
    const images = [first.children[0]!.children[0], second.children[0]!.children[0]];
    const replacements = [preview(), preview()];
    root.children = [];
    replacements.forEach((item) => root.append(item));
    action.update("duplicates");
    await flush();
    expect(root.children).toEqual([first, second]);
    expect(first.children[0]!.children[0]).toBe(images[0]);
    expect(second.children[0]!.children[0]).toBe(images[1]);
    expect(images[0]).not.toBe(images[1]);
    root.children = [];
    action.update("removed");
    await flush();
    const fresh = preview();
    root.append(fresh);
    action.update("reintroduced");
    await flush();
    expect(root.children[0]).toBe(fresh);
    action.destroy();
  });

  it("does not hydrate a removed preview after a pending resolver completes", async () => {
    let resolve!: (value: Attachment) => void;
    const { root, first, action } = setup(vi.fn(() => new Promise<Attachment>((done) => { resolve = done; })));
    await flush();
    intersect(first);
    root.children = [];
    action.update("image removed");
    await flush();
    resolve(attachment);
    await flush();
    expect(first.children[0]!.children).toHaveLength(0);
    expect(root.children).toHaveLength(0);
    action.destroy();
  });

  it("retains a pending preview and hydrates it across streaming generations", async () => {
    let resolve!: (value: Attachment) => void;
    const { root, first, action, resolver } = setup(vi.fn(() => new Promise<Attachment>((done) => { resolve = done; })));
    await flush();
    intersect(first);
    const next = preview();
    root.replaceChildren(next);
    action.update("next chunk");
    await flush();
    resolve(attachment);
    await flush();
    expect(root.children[0]).toBe(first);
    expect(first.children[0]!.children).toHaveLength(1);
    expect(resolver).toHaveBeenCalledTimes(1);
    action.destroy();
  });
});
