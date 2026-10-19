import { describe, expect, it, vi } from "vitest";
import { DESKTOP_SLASH_COMMANDS } from "../lib/slash-commands";
import { createPromptComposerSlashController } from "./prompt-composer-slash-controller.svelte";

type Options = Parameters<typeof createPromptComposerSlashController>[0];

function setup(overrides: Partial<Options> = {}) {
  let text = "/";
  const replacePromptText = vi.fn(async (value: string) => { text = value; });
  const submit = vi.fn(async () => {});
  const controller = createPromptComposerSlashController({
    promptText: () => text,
    selectionStart: () => text.length,
    selectionEnd: () => text.length,
    availableCommands: () => DESKTOP_SLASH_COMMANDS,
    editorMode: () => false,
    ready: () => true,
    activeSessionId: () => null,
    draftSession: () => true,
    promptRunning: () => false,
    questionMode: () => false,
    composing: () => false,
    attachmentsCount: () => 0,
    listbox: () => undefined,
    dismissAutocomplete: vi.fn(),
    closeComposerMenu: vi.fn(),
    replacePromptText,
    submit,
    ...overrides,
  });
  return { controller, replacePromptText, submit, get text() { return text; } };
}

function keyEvent(key: string): KeyboardEvent {
  return { key, preventDefault: vi.fn() } as unknown as KeyboardEvent;
}

describe("composer slash menu conversation targets", () => {
  it("opens the Desktop command catalogue in a sessionless draft", () => {
    const { controller } = setup();
    expect(controller.open).toBe(true);
    expect(controller.matches.map(({ command }) => command.name)).toEqual(
      DESKTOP_SLASH_COMMANDS.map(({ name }) => name),
    );
  });

  it("still opens for a real session", () => {
    const { controller } = setup({ activeSessionId: () => "session", draftSession: () => false });
    expect(controller.open).toBe(true);
  });

  it.each<[string, Partial<Options>]>([
    ["no conversation target", { draftSession: () => false }],
    ["not ready", { ready: () => false }],
    ["running prompt", { promptRunning: () => true }],
    ["embedded editor", { editorMode: () => true }],
    ["questionnaire", { questionMode: () => true }],
    ["IME composition", { composing: () => true }],
    ["attachments", { attachmentsCount: () => 1 }],
    ["selection", { selectionStart: () => 0 }],
    ["command arguments", { promptText: () => "/model value" }],
  ])("keeps the menu closed for %s", (_label, overrides) => {
    const { controller } = setup(overrides);
    expect(controller.open).toBe(false);
    expect(controller.matches).toEqual([]);
  });

  it("fuzzy-matches and Tab-completes draft commands without submitting", async () => {
    const { controller, replacePromptText, submit } = setup({
      promptText: () => "/mdl", selectionStart: () => 4, selectionEnd: () => 4,
    });
    expect(controller.activeMatch?.command.name).toBe("model");
    const event = keyEvent("Tab");
    expect(controller.handleKeydown(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(replacePromptText).toHaveBeenCalledWith("/model ", 7));
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(["model", "thinking", "hotkeys"])("Enter accepts /%s in a draft", async (name) => {
    const context = setup({
      availableCommands: () => DESKTOP_SLASH_COMMANDS.filter((command) => command.name === name),
    });
    expect(context.controller.handleKeydown(keyEvent("Enter"))).toBe(true);
    await vi.waitFor(() => expect(context.submit).toHaveBeenCalledOnce());
    expect(context.text.trim()).toBe(`/${name}`);
  });

  it("supports keyboard navigation and Escape in a draft", () => {
    const { controller, submit } = setup();
    controller.handleKeydown(keyEvent("ArrowDown"));
    expect(controller.selectedIndex).toBe(1);
    controller.handleKeydown(keyEvent("ArrowUp"));
    expect(controller.selectedIndex).toBe(0);
    const escape = keyEvent("Escape");
    expect(controller.handleKeydown(escape)).toBe(true);
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(controller.open).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });
});
