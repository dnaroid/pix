import { describe, expect, it, vi } from "vitest";
import { previewTextSelection, selectPreviewText } from "./preview-text-selection";

function fixture() {
  const range = { selectNodeContents: vi.fn() };
  const selection = { removeAllRanges: vi.fn(), addRange: vi.fn() };
  const surface = {
    isConnected: true,
    ownerDocument: { createRange: () => range, getSelection: () => selection },
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  } as unknown as HTMLElement;
  return { surface, range, selection };
}

describe("Preview document selection", () => {
  it("replaces the window selection with only the document range", () => {
    const { surface, range, selection } = fixture();
    selectPreviewText(surface);
    expect(range.selectNodeContents).toHaveBeenCalledExactlyOnceWith(surface);
    expect(selection.removeAllRanges).toHaveBeenCalledOnce();
    expect(selection.addRange).toHaveBeenCalledExactlyOnceWith(range);
  });

  it("ignores a detached document captured by a dismissed menu", () => {
    const { surface, selection } = fixture();
    Object.assign(surface, { isConnected: false });
    selectPreviewText(surface);
    expect(selection.removeAllRanges).not.toHaveBeenCalled();
  });

  it("owns and releases its keyboard listener", () => {
    const { surface } = fixture();
    const action = previewTextSelection(surface);
    expect(surface.addEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
    action.destroy();
    expect(surface.removeEventListener).toHaveBeenCalledWith("keydown", vi.mocked(surface.addEventListener).mock.calls[0]![1]);
  });

  it("handles Cmd/Ctrl+A locally but preserves editable and modified shortcuts", () => {
    class Target {
      constructor(private editable = false) {}
      closest() { return this.editable ? this : null; }
    }
    vi.stubGlobal("Element", Target);
    try {
      const { surface, selection } = fixture();
      previewTextSelection(surface);
      const listener = vi.mocked(surface.addEventListener).mock.calls[0]![1] as (event: KeyboardEvent) => void;
      const event = (overrides = {}) => ({
        key: "a", metaKey: true, ctrlKey: false, target: new Target(),
        preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides,
      });
      for (const overrides of [{}, { metaKey: false, ctrlKey: true }]) {
        const input = event(overrides);
        listener(input as unknown as KeyboardEvent);
        expect(input.preventDefault).toHaveBeenCalledOnce();
        expect(input.stopPropagation).toHaveBeenCalledOnce();
      }
      for (const overrides of [
        { target: new Target(true) }, { altKey: true }, { shiftKey: true },
        { isComposing: true }, { defaultPrevented: true }, { metaKey: false }, { key: "c" },
      ]) {
        const input = event(overrides);
        listener(input as unknown as KeyboardEvent);
        expect(input.preventDefault).not.toHaveBeenCalled();
      }
      expect(selection.addRange).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
