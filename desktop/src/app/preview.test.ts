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
    tauri.invoke.mockResolvedValue(file);
    await preview.openProjectFile(file.path);
    preparation.resolve();
    await pending;
    expect(preview.active).toMatchObject({ kind: "file", file });
  });

  it("an immediate preview invalidates an older file load", async () => {
    const { preview } = fixture();
    const read = deferred<{ path: string; content: string }>();
    tauri.invoke.mockReturnValue(read.promise);
    const pending = preview.openProjectFile("old.ts");
    preview.show({ kind: "attachment", attachment: image }, "replace");
    read.resolve({ path: "old.ts", content: "old" });
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
});
