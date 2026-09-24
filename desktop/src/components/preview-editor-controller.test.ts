import { describe, expect, it, vi } from "vitest";
import { createPreviewEditorController } from "./preview-editor-controller.svelte";

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function fixture() {
  let id = 1;
  let file = { path: "TODO.md", content: "original" };
  const saveFile = vi.fn(async (_path: string, _content: string) => true);
  const controller = createPreviewEditorController({
    previewId: () => id,
    file: () => file,
    editable: () => true,
    onSaveProjectFile: () => saveFile,
    onDirtyChange: () => undefined,
  });
  return {
    controller, saveFile,
    navigate: () => { id += 1; file = { path: "plan.md", content: "next file" }; },
  };
}

describe("Preview save ownership", () => {
  it("allows editing non-Markdown text files when Preview marks them editable", () => {
    const { controller } = fixture();
    controller.begin();
    expect(controller.state.editing).toBe(true);
  });

  it("retains changes typed while an earlier draft is being saved", async () => {
    const { controller, saveFile } = fixture();
    const pending = deferred();
    saveFile.mockReturnValue(pending.promise);
    controller.begin();
    controller.state.draft = "submitted";
    const saving = controller.save();
    controller.state.draft = "typed during save";
    pending.resolve(true);
    await saving;
    expect(saveFile).toHaveBeenCalledWith("TODO.md", "submitted");
    expect(controller.state).toMatchObject({ editing: true, saving: false, draft: "typed during save" });
    expect(controller.dirty).toBe(true);
  });

  it("does not let the previous file's save unlock or close a new edit", async () => {
    const { controller, saveFile, navigate } = fixture();
    const first = deferred();
    const second = deferred();
    saveFile.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    controller.begin();
    controller.state.draft = "old file draft";
    const oldSave = controller.save();
    navigate();
    controller.begin();
    controller.state.draft = "new file draft";
    const newSave = controller.save();
    first.resolve(true);
    await oldSave;
    expect(controller.state).toMatchObject({ editing: true, saving: true, draft: "new file draft" });
    second.resolve(true);
    await newSave;
    expect(controller.state).toMatchObject({ editing: false, saving: false });
  });

  it("ignores a late save after cancelling and beginning a new edit", async () => {
    const { controller, saveFile } = fixture();
    const pending = deferred();
    saveFile.mockReturnValue(pending.promise);
    controller.begin();
    controller.state.draft = "submitted";
    const saving = controller.save();
    controller.cancel();
    controller.begin();
    controller.state.draft = "replacement draft";
    pending.resolve(true);
    await saving;
    expect(controller.state).toMatchObject({ editing: true, saving: false, draft: "replacement draft" });
  });
});
