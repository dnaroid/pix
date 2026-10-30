import { describe, expect, it, vi } from "vitest";
import { createPreviewCopyController } from "./preview-copy-controller";
import previewSource from "./PreviewPane.svelte?raw";

describe("Preview content copy", () => {
  it("uses the current draft while editing and the displayed source text otherwise", () => {
    // Markdown copies omit the hidden Wiki report block, like the rendered preview.
    expect(previewSource).toContain('<PreviewCopyButton text={editing ? editorState.draft : previewContent} {previewId} />');
    expect(previewSource).toContain("stripKnowledgeCheckStamp(file.content) : file.content");
  });

  it("copies exact text including empty content", async () => {
    const state = { status: "", pending: false };
    const write = vi.fn().mockResolvedValue(undefined);
    const controller = createPreviewCopyController(state, write, vi.fn());
    await controller.copy("# Markdown\n\n```ts\nconst x = 1;\n```\n");
    expect(write).toHaveBeenLastCalledWith("# Markdown\n\n```ts\nconst x = 1;\n```\n", expect.any(Function));
    expect(state).toEqual({ status: "Copied", pending: false });
    await controller.copy("");
    expect(write).toHaveBeenLastCalledWith("", expect.any(Function));
  });

  it("reports failure and permits retry", async () => {
    const state = { status: "", pending: false };
    const error = new Error("clipboard unavailable");
    const write = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const report = vi.fn();
    const controller = createPreviewCopyController(state, write, report);
    await controller.copy("text");
    expect(report).toHaveBeenCalledWith(error);
    expect(state).toEqual({ status: "Copy failed", pending: false });
    await controller.copy("text");
    expect(state.status).toBe("Copied");
  });

  it.each(["reset", "dispose"] as const)("ignores completion after %s", async (action) => {
    const state = { status: "", pending: false };
    let resolve!: () => void;
    const write = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const controller = createPreviewCopyController(state, write, vi.fn());
    const copying = controller.copy("old");
    await controller.copy("duplicate");
    expect(write).toHaveBeenCalledTimes(1);
    controller[action]();
    const snapshot = { ...state };
    resolve();
    await copying;
    expect(state).toEqual(snapshot);
  });

  it("does not unlock a newer copy when an old request completes", async () => {
    const state = { status: "", pending: false };
    const completions: (() => void)[] = [];
    const write = vi.fn(() => new Promise<void>((done) => { completions.push(done); }));
    const controller = createPreviewCopyController(state, write, vi.fn());
    const old = controller.copy("old file");
    controller.reset();
    const current = controller.copy("new draft");
    completions[0]!();
    await old;
    expect(state).toEqual({ status: "", pending: true });
    completions[1]!();
    await current;
    expect(state).toEqual({ status: "Copied", pending: false });
  });
});
