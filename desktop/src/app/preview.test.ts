import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "../lib/attachments";
import type { KnowledgeCitation } from "../../../acp/src/knowledge/contract";
import { createPreviewStore } from "./preview.svelte";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const image: Attachment = {
  id: "image", kind: "image", name: "image.png", mimeType: "image/png", path: "/image.png",
};

function fixture(revealProjectEntry?: (path: string) => Promise<void>) {
  let workspace = "/one";
  const options = {
    workspace: () => workspace,
    revealProjectEntry,
    loadExternalEditor: vi.fn(async (): Promise<string | undefined> => "zed"),
    activeWorkbenchTabId: () => null,
    activeConversationWorkbenchTabId: () => null,
    setActiveWorkbenchTabId: vi.fn(),
    nextWorkbenchAuxOrder: () => 1,
    prepareAttachment: vi.fn(async (_attachment: Attachment) => {}),
    preparedAttachment: (attachment: Attachment) => attachment,
    reportError: vi.fn(),
    setErrorMessage: vi.fn(),
  };
  return { preview: createPreviewStore(options), options, setWorkspace: (value: string) => { workspace = value; } };
}

describe("Wiki evidence navigation", () => {
  const citation: KnowledgeCitation = { path: "wiki/rules.md", quote: "Five retries.", startLine: 2, endLine: 2 };
  beforeEach(() => { tauri.invoke.mockReset(); });

  it("opens a citation in rendered Markdown and preserves evidence, language and scroll in history", async () => {
    const { preview } = fixture();
    tauri.invoke.mockImplementation(async (_command: string, { path }: { path: string }) => ({ kind: "text", file: { path, content: "# Rules\n\nFive retries." } }));
    await preview.openKnowledgeCitation(citation, "push", "ru");
    expect(preview.active).toMatchObject({ kind: "file", markdownLinkBase: "document", evidenceCitation: citation, evidenceLanguage: "ru" });
    expect(preview.active).not.toHaveProperty("lineRange");
    expect(preview.active).not.toHaveProperty("searchRange");
    preview.rememberScroll(preview.active!.id, { top: 320, left: 0 });
    await preview.openProjectFile("next.md", "push");
    expect(preview.active).not.toHaveProperty("evidenceCitation");
    preview.move(-1);
    expect(preview.active).toMatchObject({ evidenceCitation: citation, evidenceLanguage: "ru", scrollPosition: { top: 320, left: 0 } });
    preview.move(1);
    expect(preview.active).toMatchObject({ file: { path: "next.md" } });
    expect(tauri.invoke).toHaveBeenCalledWith("read_preview_file", { workspace: "/one", path: citation.path });
  });

  it("rejects unsafe paths before native IO and keeps the previous Preview", async () => {
    const { preview, options } = fixture();
    preview.show({ kind: "file", file: { path: "one.md", content: "one" } }, "push");
    const previous = preview.active;
    await preview.openKnowledgeCitation({ ...citation, path: "../outside.md" }, "push", "ru");
    expect(tauri.invoke).not.toHaveBeenCalled();
    expect(preview.active).toBe(previous);
    expect(options.setErrorMessage).toHaveBeenCalledWith("Ссылка на доказательство некорректна.");
  });

  it("snapshots evidence and opens changed source text without using stale line ranges", async () => {
    const { preview } = fixture();
    const pending = deferred<{ kind: "text"; file: { path: string; content: string } }>();
    tauri.invoke.mockReturnValue(pending.promise);
    const reference = { ...citation };
    const opening = preview.openKnowledgeCitation(reference);
    reference.quote = "mutated";
    pending.resolve({ kind: "text", file: { path: citation.path, content: "The rule changed." } });
    await opening;
    expect(preview.active).toMatchObject({ evidenceCitation: citation, file: { content: "The rule changed." } });
    expect(preview.active).not.toHaveProperty("lineRange");
    expect(preview.active).not.toHaveProperty("searchRange");
  });

  it.each(["close", "workspace", "new-file", "history"])("discards late citation reads after %s", async (action) => {
    const { preview, setWorkspace } = fixture();
    preview.show({ kind: "file", file: { path: "one.md", content: "one" } }, "push");
    preview.show({ kind: "file", file: { path: "two.md", content: "two" } }, "push");
    const pending = deferred<{ kind: "text"; file: { path: string; content: string } }>();
    tauri.invoke.mockImplementation((_command: string, { path }: { path: string }) => path === citation.path
      ? pending.promise : { kind: "text", file: { path, content: "Next" } });
    const opening = preview.openKnowledgeCitation(citation);
    if (action === "close") preview.close();
    if (action === "workspace") { setWorkspace("/two"); preview.resetForWorkspaceChange(); }
    if (action === "new-file") await preview.openProjectFile("new.md", "push");
    if (action === "history") preview.move(-1);
    const previous = preview.active;
    pending.resolve({ kind: "text", file: { path: citation.path, content: citation.quote } });
    await opening;
    expect(preview.active).toBe(previous);
  });

  it("keeps a dirty draft when its citation read finishes", async () => {
    const { preview, options } = fixture();
    preview.show({ kind: "file", file: { path: "one.md", content: "one" } }, "push");
    tauri.invoke.mockResolvedValue({ kind: "text", file: { path: citation.path, content: citation.quote } });
    preview.setDirty(true);
    await preview.openKnowledgeCitation(citation);
    expect(preview.active).toMatchObject({ file: { path: "one.md" } });
    expect(preview.dirty).toBe(true);
    expect(options.setErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Save or discard"));
  });
});

describe("Preview async ownership", () => {
  it("preserves a Wiki draft when another file or late read tries to replace it", async () => {
    const { preview, options } = fixture();
    preview.show({ kind: "file", file: { path: "wiki/index.md", content: "# Home" }, markdownLinkBase: "document" }, "replace");
    const next = deferred<{ kind: "file"; file: { path: string; content: string } }>();
    tauri.invoke.mockImplementation((command: string) => command === "project_directory_exists" ? false : next.promise);
    const opening = preview.openProjectFile("wiki/rules.md", "push", undefined, false, "document");
    preview.setDirty(true);
    next.resolve({ kind: "file", file: { path: "wiki/rules.md", content: "# Rules" } });
    await opening;
    expect(preview.active).toMatchObject({ file: { path: "wiki/index.md" }, markdownLinkBase: "document" });
    expect(preview.dirty).toBe(true);
    expect(options.setErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Save or discard"));
    preview.show({ kind: "attachment", attachment: image }, "replace");
    expect(preview.active?.kind).toBe("file");
  });

  it("retains document-relative Wiki navigation in Preview history", async () => {
    const { preview } = fixture();
    tauri.invoke.mockImplementation(async (command: string, { path }: { path: string }) => command === "project_directory_exists"
      ? false : { kind: "text", file: { path, content: `# ${path}` } });
    await preview.openProjectFile("wiki/index.md", "push", undefined, false, "document");
    await preview.openProjectFile("wiki/rules.md", "push", undefined, false, "document");
    preview.move(-1);
    expect(preview.active).toMatchObject({ file: { path: "wiki/index.md" }, markdownLinkBase: "document" });
  });

  it("opens virtual Wiki contents and child pages with normal back/forward history", async () => {
    const reveal = vi.fn(async () => {});
    const { preview } = fixture(reveal);
    tauri.invoke.mockImplementation(async (command: string, { path }: { path: string }) => {
      if (command === "project_directory_exists") return path === "wiki";
      if (command === "project_file_exists") return path === "wiki/combat.md";
      if (command === "list_project_directory") return [{ kind: "file", name: "combat.md", path: "wiki/combat.md" }];
      if (command === "read_preview_file") return { kind: "text", file: { path, content: "# Combat" } };
      throw new Error(`Unexpected command: ${command}`);
    });
    await preview.openProjectFile("wiki", "push", undefined, false, "document");
    expect(preview.active).toMatchObject({ kind: "file", markdownLinkBase: "document", file: {
      virtualWikiDirectory: "wiki", content: expect.stringContaining("[combat](./combat.md)"),
    } });
    await preview.openProjectFile("wiki/combat.md", "push", undefined, false, "document");
    expect(preview.active).toMatchObject({ file: { path: "wiki/combat.md" } });
    preview.move(-1);
    expect(preview.active).toMatchObject({ file: { virtualWikiDirectory: "wiki" } });
    preview.move(1);
    expect(preview.active).toMatchObject({ file: { path: "wiki/combat.md" } });
    expect(reveal).not.toHaveBeenCalled();
    expect(tauri.invoke.mock.calls.every(([command]) => !/write|create/u.test(command))).toBe(true);
  });

  it("opens an image-only Wiki listing and follows its image through media Preview", async () => {
    const { preview } = fixture();
    tauri.invoke.mockImplementation(async (command: string, { path }: { path: string }) => {
      if (command === "project_directory_exists") return path === "wiki/screenshots";
      if (command === "project_file_exists") return false;
      if (command === "list_project_directory") return [{ kind: "file", name: "overview.png", path: "wiki/screenshots/overview.png" }];
      if (command === "resolve_project_media") return { name: "overview.png", path: "/one/wiki/screenshots/overview.png" };
      throw new Error(`Unexpected command: ${command}`);
    });
    await preview.openProjectFile("wiki/screenshots", "push", undefined, false, "document");
    expect(preview.active).toMatchObject({ file: {
      content: expect.stringContaining("[overview.png](./overview.png)"),
      virtualWikiDirectory: "wiki/screenshots",
    } });
    await preview.openProjectFile("wiki/screenshots/overview.png", "push", undefined, false, "document");
    expect(preview.active).toMatchObject({ kind: "attachment", attachment: { kind: "image", name: "overview.png" } });
    preview.move(-1);
    expect(preview.active).toMatchObject({ file: { virtualWikiDirectory: "wiki/screenshots" } });
  });

  it("opens a real index from a Wiki directory link instead of revealing Files", async () => {
    const reveal = vi.fn(async () => {});
    const { preview } = fixture(reveal);
    tauri.invoke.mockImplementation(async (command: string, { path }: { path: string }) => {
      if (command === "project_directory_exists") return true;
      if (command === "project_file_exists") return path === "wiki/rules/index.md";
      return { kind: "text", file: { path, content: "# Rules" } };
    });
    await preview.openProjectFile("wiki/rules", "push", undefined, false, "document");
    expect(preview.active).toMatchObject({ file: { path: "wiki/rules/index.md" }, markdownLinkBase: "document" });
    expect(reveal).not.toHaveBeenCalled();
  });

  it.each(["close", "workspace", "new-file", "history"])("discards late Wiki listings after %s", async (action) => {
    const { preview, setWorkspace } = fixture();
    preview.show({ kind: "file", file: { path: "one.md", content: "one" } }, "push");
    preview.show({ kind: "file", file: { path: "two.md", content: "two" } }, "push");
    const listing = deferred<unknown[]>();
    const enteredListing = deferred<void>();
    tauri.invoke.mockImplementation(async (command: string, { path }: { path: string }) => {
      if (command === "project_directory_exists") return path === "wiki";
      if (command === "project_file_exists") return false;
      if (command === "list_project_directory") { enteredListing.resolve(); return listing.promise; }
      return { kind: "text", file: { path, content: "# New" } };
    });
    const opening = preview.openProjectFile("wiki", "push", undefined, false, "document");
    await enteredListing.promise;
    if (action === "close") preview.close();
    if (action === "workspace") { setWorkspace("/two"); preview.resetForWorkspaceChange(); }
    if (action === "new-file") await preview.openProjectFile("new.md", "push");
    if (action === "history") preview.move(-1);
    const expected = preview.active;
    listing.resolve([]);
    await opening;
    expect(preview.active).toBe(expected);
    expect(preview.active?.kind === "file" && preview.active.file.virtualWikiDirectory).toBeFalsy();
  });

  it("reports a current failed Wiki listing and preserves the previous Preview", async () => {
    const { preview, options } = fixture();
    preview.show({ kind: "attachment", attachment: image }, "replace");
    const previous = preview.active;
    const error = new Error("Wiki listing failed");
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "project_directory_exists") return true;
      if (command === "project_file_exists") return false;
      throw error;
    });
    await preview.openProjectFile("wiki", "push", undefined, false, "document");
    expect(options.reportError).toHaveBeenCalledExactlyOnceWith(error);
    expect(preview.active).toBe(previous);
  });
  it.each(["file", "directory", null] as const)("preserves local target kind %s for Markdown icons", async (kind) => {
    const { preview } = fixture();
    tauri.invoke.mockResolvedValue(kind);
    expect(await preview.validateLocalFile("/tmp/folder.ts")).toBe(kind === "directory" ? "directory" : kind === "file");
    expect(tauri.invoke).toHaveBeenCalledWith("local_path_kind", { path: "/tmp/folder.ts" });
  });

  it("rejects stale directory validation after switching workspace", async () => {
    const { preview, setWorkspace } = fixture();
    const directory = deferred<boolean>();
    tauri.invoke.mockImplementation((command: string) => command === "project_file_exists" ? false : directory.promise);
    const pending = preview.validateProjectFile("folder");
    setWorkspace("/two");
    directory.resolve(true);
    expect(await pending).toBe(false);
  });
  it.each(["track.mp3", "track.ogg", "clip.mp4"])("requests one Files playback for %s, not history or ordinary opens", async (name) => {
    const { preview } = fixture();
    tauri.invoke.mockResolvedValue({ name, path: `/one/${name}` });
    await preview.openProjectFile(name, "replace", undefined, true);
    expect(preview.active).toMatchObject({ autoplay: true });
    const id = preview.active!.id;
    preview.consumeAutoplay(id + 1);
    expect(preview.active).toMatchObject({ autoplay: true });
    preview.consumeAutoplay(id);
    expect(preview.active).toMatchObject({ autoplay: false });
    await preview.openProjectFile(name, "push");
    expect(preview.active).toMatchObject({ autoplay: false });
    preview.move(-1);
    expect(preview.active).toMatchObject({ autoplay: false });
    await preview.openProjectFile(name, "replace", undefined, true);
    preview.move(1);
    expect(preview.active).toMatchObject({ autoplay: false });
  });
  it("routes project GLB through approved media resolution, never through text reading", async () => {
    const { preview } = fixture();
    tauri.invoke.mockImplementation(async (command: string) => command === "project_directory_exists"
      ? false : { path: "/one/chair.glb", name: "chair.glb", size: 100 });
    await preview.openProjectFile("chair.glb");
    expect(preview.active).toMatchObject({ kind: "attachment", attachment: {
      kind: "file", mimeType: "model/gltf-binary", path: "/one/chair.glb",
    } });
    expect(tauri.invoke).toHaveBeenCalledWith("resolve_project_media", { workspace: "/one", path: "chair.glb" });
    expect(tauri.invoke).not.toHaveBeenCalledWith("read_preview_file", expect.anything());
  });

  it.each([
    ["mp3", "audio/mpeg"], ["ogg", "audio/ogg"], ["m4b", "audio/mp4"],
    ["mpga", "audio/mpeg"], ["wave", "audio/wav"], ["weba", "audio/webm"],
  ])("routes project %s audio through approved media resolution rather than UTF-8 reading", async (extension, mimeType) => {
    const name = `track.${extension.toUpperCase()}`;
    tauri.invoke.mockResolvedValue({ name, path: `/one/${name}` });
    const { preview } = fixture();
    await preview.openProjectFile(name);
    expect(preview.active).toMatchObject({ kind: "attachment", attachment: { kind: "file", mimeType } });
    expect(tauri.invoke).toHaveBeenCalledWith("resolve_project_media", { workspace: "/one", path: name });
    expect(tauri.invoke).not.toHaveBeenCalledWith("read_preview_file", expect.anything());
  });

  it.each([
    ["wav", "audio/wav"], ["ogg", "audio/ogg"], ["m4b", "audio/mp4"],
    ["mpga", "audio/mpeg"], ["wave", "audio/wav"], ["weba", "audio/webm"],
  ])("opens home, absolute and prompt-file %s audio in Preview", async (extension, mimeType) => {
    const name = `track.${extension}`;
    const path = `/home/Music/${name}`;
    tauri.invoke.mockResolvedValue({ name, path });
    const { preview } = fixture();
    await preview.openLocalFile(`~/Music/${name}`);
    expect(tauri.invoke).toHaveBeenCalledWith("resolve_home_media", { path: `~/Music/${name}` });
    expect(preview.active).toMatchObject({ kind: "attachment", attachment: { mimeType } });
    await preview.openLocalFile(path);
    expect(tauri.invoke).toHaveBeenCalledWith("resolve_local_media", { path });
    expect(preview.active).toMatchObject({ kind: "attachment", attachment: { mimeType } });
    await preview.activateAttachment({ id: "audio", name, kind: "file", mimeType, path });
    expect(preview.active).toMatchObject({ kind: "attachment", attachment: { id: "audio" } });
    expect(tauri.invoke).not.toHaveBeenCalledWith("open_attachment", expect.anything());
  });

  it("does not reopen closed Preview when audio resolution completes late", async () => {
    const pending = deferred<{ name: string; path: string; mimeType: string }>();
    tauri.invoke.mockImplementation(() => pending.promise);
    const { preview } = fixture();
    const opening = preview.openProjectFile("track.mp3");
    preview.close();
    pending.resolve({ name: "track.mp3", path: "/one/track.mp3", mimeType: "audio/mpeg" });
    await opening;
    expect(preview.active).toBeUndefined();
  });

  it("routes absolute and home GLB to media Preview and resolves inline models", async () => {
    const { preview } = fixture();
    tauri.invoke.mockResolvedValue({ path: "/home/models/chair.glb", name: "chair.glb", size: 100 });
    await preview.openLocalFile("~/models/chair.glb");
    expect(tauri.invoke).toHaveBeenCalledWith("resolve_home_media", { path: "~/models/chair.glb" });
    expect(preview.active).toMatchObject({ kind: "attachment" });
    expect(await preview.resolveLocalMedia("/home/models/chair.glb")).toMatchObject({ mimeType: "model/gltf-binary" });
    expect(await preview.resolveProjectMedia("models/chair.glb")).toMatchObject({ mimeType: "model/gltf-binary" });
  });
  beforeEach(() => { tauri.invoke.mockReset(); });

  it("does not reopen a closed preview after attachment preparation", async () => {
    const { preview, options } = fixture();
    const preparation = deferred<void>();
    options.prepareAttachment.mockReturnValue(preparation.promise);
    const pending = preview.activateAttachment(image);
    preview.close();
    preparation.resolve();
    await pending;
    expect(preview.active).toBeUndefined();
    expect(options.setActiveWorkbenchTabId).not.toHaveBeenCalled();
  });

  it.each(["nested/folder", ".pi/artifacts/usage-popup-mockups"])("validates directory %s and reveals it without changing Preview", async (path) => {
    const reveal = vi.fn(async () => {});
    const { preview, options } = fixture(reveal);
    preview.show({ kind: "attachment", attachment: image }, "replace");
    const before = preview.active;
    options.setActiveWorkbenchTabId.mockClear();
    tauri.invoke.mockImplementation(async (command: string) => command === "project_directory_exists");
    expect(await preview.validateProjectFile(path)).toBe("directory");
    await preview.openProjectFile(path);
    expect(reveal).toHaveBeenCalledExactlyOnceWith(path);
    expect(preview.active).toBe(before);
    expect(options.setActiveWorkbenchTabId).not.toHaveBeenCalled();
    expect(tauri.invoke).not.toHaveBeenCalledWith("read_preview_file", expect.anything());
  });

  it.each(["workspace", "close", "newer"])("ignores delayed directory routing after %s", async (change) => {
    const reveal = vi.fn(async () => {});
    const { preview, setWorkspace } = fixture(reveal);
    const classification = deferred<boolean>();
    tauri.invoke.mockReturnValue(classification.promise);
    const pending = preview.openProjectFile("folder");
    if (change === "workspace") setWorkspace("/two");
    else if (change === "close") preview.close();
    else preview.show({ kind: "attachment", attachment: image }, "replace");
    classification.resolve(true);
    await pending;
    expect(reveal).not.toHaveBeenCalled();
  });

  it("keeps ordinary file preview routing with the reveal callback installed", async () => {
    const reveal = vi.fn(async () => {});
    const { preview } = fixture(reveal);
    const file = { path: "small.ts", content: "text" };
    tauri.invoke.mockImplementation(async (command: string) => command === "project_directory_exists"
      ? false : { kind: "text", file });
    await preview.openProjectFile(file.path, "push", { startLine: 1, endLine: 1 });
    expect(reveal).not.toHaveBeenCalled();
    expect(preview.active).toMatchObject({ kind: "file", file, lineRange: { startLine: 1, endLine: 1 } });
  });

  it("retains Wiki search locations in rendered-document history separately from source links", async () => {
    const { preview } = fixture();
    const range = { startLine: 24, endLine: 29 };
    tauri.invoke.mockImplementation(async (command: string, args: any) => command === "project_directory_exists"
      ? false : { kind: "text", file: { path: args.path, content: "# Wiki" } });
    await preview.openProjectFile("wiki/first.md", "push", undefined, true, "document", range);
    expect(preview.active).toMatchObject({ kind: "file", searchRange: range, markdownLinkBase: "document" });
    expect(preview.active).not.toHaveProperty("lineRange");
    await preview.openProjectFile("wiki/second.md", "push", undefined, true, "document", { startLine: 2, endLine: 3 });
    preview.move(-1);
    expect(preview.active).toMatchObject({ file: { path: "wiki/first.md" }, searchRange: range });
    await preview.openProjectFile("wiki/source.md", "push", range, false, "document");
    expect(preview.active).toMatchObject({ lineRange: range });
    expect(preview.active).not.toHaveProperty("searchRange");
  });

  it("does not let an older attachment replace a newer project file", async () => {
    const { preview, options } = fixture();
    const preparation = deferred<void>();
    options.prepareAttachment.mockReturnValue(preparation.promise);
    const pending = preview.activateAttachment(image);
    const file = { path: "new.ts", content: "new" };
    tauri.invoke.mockResolvedValue({ kind: "text", file });
    await preview.openProjectFile(file.path);
    preparation.resolve();
    await pending;
    expect(preview.active).toMatchObject({ kind: "file", file });
  });

  it("an immediate preview invalidates an older file load", async () => {
    const { preview } = fixture();
    const read = deferred<{ kind: "text"; file: { path: string; content: string } }>();
    tauri.invoke.mockReturnValue(read.promise);
    const pending = preview.openProjectFile("old.ts");
    preview.show({ kind: "attachment", attachment: image }, "replace");
    read.resolve({ kind: "text", file: { path: "old.ts", content: "old" } });
    await pending;
    expect(preview.active).toMatchObject({ kind: "attachment", attachment: image });
  });

  it("ignores old-workspace attachments and their late errors", async () => {
    const { preview, options, setWorkspace } = fixture();
    const preparation = deferred<void>();
    options.prepareAttachment.mockReturnValue(preparation.promise);
    const pending = preview.activateAttachment(image);
    setWorkspace("/two");
    preparation.reject(new Error("old workspace failed"));
    await pending;
    expect(preview.active).toBeUndefined();
    expect(options.reportError).not.toHaveBeenCalled();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it("does not report an obsolete project read error", async () => {
    const { preview, options, setWorkspace } = fixture();
    const read = deferred<never>();
    tauri.invoke.mockReturnValue(read.promise);
    const pending = preview.openProjectFile("old.ts");
    setWorkspace("/two");
    read.reject(new Error("missing old file"));
    await pending;
    expect(options.reportError).not.toHaveBeenCalled();
  });

  it("previews absolute UTF-8 local files instead of sending them to the system opener", async () => {
    const { preview } = fixture();
    const file = { path: "/private/tmp/idx-compact-gate-qa/stdout.txt", content: "qa output\n" };
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "read_preview_file") return Promise.resolve({ kind: "text", file });
      return Promise.resolve(undefined);
    });

    await preview.openLocalFile(file.path);

    expect(tauri.invoke).toHaveBeenCalledWith("read_preview_file", { workspace: null, path: file.path });
    expect(tauri.invoke).not.toHaveBeenCalledWith("open_local_file", expect.anything());
    expect(preview.active).toMatchObject({ kind: "file", file });
  });

  it("keeps the system-opener fallback for local files that cannot be text-previewed", async () => {
    const { preview } = fixture();
    const path = "/private/tmp/idx-compact-gate-qa/archive.bin";
    tauri.invoke.mockImplementation((command: string) => {
      if (command === "read_preview_file") return Promise.reject(new Error("not UTF-8"));
      if (command === "open_local_file") return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    await preview.openLocalFile(path);

    expect(tauri.invoke).toHaveBeenCalledWith("read_preview_file", { workspace: null, path });
    expect(tauri.invoke).toHaveBeenCalledWith("open_local_file", { path });
    expect(preview.active).toBeUndefined();
  });

  it("does not open an obsolete absolute local file externally after Preview navigation changes", async () => {
    const { preview } = fixture();
    const read = deferred<never>();
    tauri.invoke.mockImplementation((command: string) => command === "read_preview_file" ? read.promise : Promise.resolve(undefined));
    const pending = preview.openLocalFile("/private/tmp/old.txt");
    preview.show({ kind: "attachment", attachment: image }, "replace");
    read.reject(new Error("not previewable"));
    await pending;
    expect(tauri.invoke).not.toHaveBeenCalledWith("open_local_file", expect.anything());
    expect(preview.active).toMatchObject({ kind: "attachment", attachment: image });
  });

  it.each([
    ["project", "inputs.json", "/one"],
    ["home", "~/inputs.json", null],
    ["absolute", "/tmp/inputs.json", null],
  ] as const)("opens a large %s file in the configured editor without touching Preview history", async (kind, path, workspace) => {
    const { preview, options } = fixture();
    preview.show({ kind: "attachment", attachment: image }, "replace");
    const previous = preview.active;
    options.setActiveWorkbenchTabId.mockClear();
    tauri.invoke.mockImplementation(async (command: string) => command === "read_preview_file" ? { kind: "external" } : undefined);

    await (kind === "project" ? preview.openProjectFile(path, "push") : preview.openLocalFile(path, "push"));

    expect(tauri.invoke).toHaveBeenCalledWith("read_preview_file", { workspace, path });
    expect(tauri.invoke).toHaveBeenCalledWith("open_preview_file_in_editor", { workspace, path, editor: "zed" });
    expect(tauri.invoke).not.toHaveBeenCalledWith("open_local_file", expect.anything());
    expect(preview.active).toBe(previous);
    expect(options.setActiveWorkbenchTabId).not.toHaveBeenCalled();
  });

  it("keeps small project files and their line range in Preview", async () => {
    const { preview } = fixture();
    const file = { path: "small.json", content: "{}" };
    tauri.invoke.mockResolvedValue({ kind: "text", file });
    await preview.openProjectFile(file.path, "replace", { startLine: 1, endLine: 1 });
    expect(preview.active).toMatchObject({ kind: "file", file, lineRange: { startLine: 1, endLine: 1 } });
    expect(tauri.invoke).not.toHaveBeenCalledWith("open_preview_file_in_editor", expect.anything());
  });

  it("asks for editor configuration rather than rendering a large file", async () => {
    const { preview, options } = fixture();
    options.loadExternalEditor.mockResolvedValue(undefined);
    tauri.invoke.mockResolvedValue({ kind: "external" });
    await preview.openProjectFile("inputs.json");
    expect(options.setErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Settings → Desktop → Editor"));
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    expect(preview.active).toBeUndefined();
  });

  it("reports editor launch failure without using the OS opener", async () => {
    const { preview, options } = fixture();
    const error = new Error("editor unavailable");
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === "read_preview_file") return { kind: "external" };
      throw error;
    });
    await preview.openLocalFile("/tmp/inputs.json");
    expect(options.reportError).toHaveBeenCalledWith(error);
    expect(tauri.invoke).not.toHaveBeenCalledWith("open_local_file", expect.anything());
    expect(preview.active).toBeUndefined();
  });

  it.each(["close", "workspace", "navigate"])("does not launch an external editor after %s during classification", async (change) => {
    const { preview, options, setWorkspace } = fixture();
    const read = deferred<{ kind: "external" }>();
    tauri.invoke.mockReturnValue(read.promise);
    const pending = preview.openProjectFile("inputs.json");
    if (change === "close") preview.close();
    else if (change === "workspace") setWorkspace("/two");
    else preview.show({ kind: "attachment", attachment: image }, "replace");
    read.resolve({ kind: "external" });
    await pending;
    expect(options.loadExternalEditor).not.toHaveBeenCalled();
    expect(tauri.invoke).not.toHaveBeenCalledWith("open_preview_file_in_editor", expect.anything());
  });

  it.each(["project", "local"])("ignores stale %s editor preferences and their errors", async (kind) => {
    const { preview, options, setWorkspace } = fixture();
    const editor = deferred<string | undefined>();
    options.loadExternalEditor.mockReturnValue(editor.promise);
    tauri.invoke.mockResolvedValue({ kind: "external" });
    const pending = kind === "project" ? preview.openProjectFile("inputs.json") : preview.openLocalFile("~/inputs.json");
    // Let the bounded read resolve and start preference loading.
    await Promise.resolve();
    expect(options.loadExternalEditor).toHaveBeenCalled();
    setWorkspace("/two");
    editor.reject(new Error("old settings read failed"));
    await pending;
    expect(options.reportError).not.toHaveBeenCalled();
    expect(tauri.invoke).not.toHaveBeenCalledWith("open_preview_file_in_editor", expect.anything());
  });
});
