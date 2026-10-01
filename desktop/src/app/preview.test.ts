import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "../lib/attachments";
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

function fixture() {
  let workspace = "/one";
  const options = {
    workspace: () => workspace,
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

describe("Preview async ownership", () => {
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
