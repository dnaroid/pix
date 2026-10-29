import { describe, expect, it, vi } from "vitest";
import { createPromptComposerMentionsController } from "./prompt-composer-mentions-controller.svelte";
import type { FileMentionMatch } from "../../../src/file-mentions";

const harness = vi.hoisted(() => ({ publish: undefined as ((items: FileMentionMatch[], loading: boolean, failed: boolean) => void) | undefined }));
vi.mock("../../../src/file-mention-search", () => ({ FileMentionSearch: class {
  constructor(_request: unknown, changed: typeof harness.publish) { harness.publish = changed; }
  observe() {} dispose() {}
} }));

function setup(value = "check @src", enabled = true) {
  let text = value;
  const replace = vi.fn(async (next: string) => { text = next; });
  const controller = createPromptComposerMentionsController({
    text: () => text, selectionStart: () => text.length, selectionEnd: () => text.length,
    context: () => "session", enabled: () => enabled, request: async () => [], replace,
    dismissAutocomplete: vi.fn(), closeMenu: vi.fn(),
  });
  harness.publish?.([{ path: "src/", directory: true }, { path: "src/file.ts", directory: false }], false, false);
  return { controller, replace };
}
const key = (value: string) => ({ key: value, preventDefault: vi.fn() }) as unknown as KeyboardEvent;

describe("composer mention keyboard controller", () => {
  it.each(["Enter", "Tab"])("navigates and inserts on %s without submitting", async (acceptKey) => {
    const { controller, replace } = setup();
    expect(controller.open).toBe(true);
    controller.handleKeydown(key("ArrowDown")); expect(controller.selectedIndex).toBe(1);
    controller.handleKeydown(key("ArrowUp")); expect(controller.selectedIndex).toBe(0);
    controller.handleKeydown(key("ArrowUp")); expect(controller.selectedIndex).toBe(1);
    const event = key(acceptKey); expect(controller.handleKeydown(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith("check @src/file.ts ", 19);
  });
  it("dismisses on Escape and consumes Enter while loading or empty", () => {
    const { controller, replace } = setup();
    harness.publish?.([], true, false);
    expect(controller.handleKeydown(key("Enter"))).toBe(true); expect(replace).not.toHaveBeenCalled();
    controller.handleKeydown(key("Escape")); expect(controller.open).toBe(false);
    expect(controller.handleKeydown(key("Tab"))).toBe(false);
  });
  it("supports pointer acceptance and leaves slash, shell, IME and disabled contexts alone", async () => {
    const { controller, replace } = setup();
    await controller.accept(controller.matches[0]!); expect(replace).toHaveBeenCalledWith("check @src/ ", 12);
    for (const text of ["/model @src", "!cat @src", "email@src"]) expect(setup(text).controller.open).toBe(false);
    expect(setup("@src", false).controller.open).toBe(false);
    const event = { ...key("Enter"), isComposing: true } as KeyboardEvent;
    expect(setup().controller.handleKeydown(event)).toBe(false);
  });
});
