import { expect, it, vi } from "vitest";
import { createPromptSubmit } from "./prompt-submit";
import { parseDesktopSlashCommand, DESKTOP_SLASH_COMMANDS } from "../lib/slash-commands";

it.each([false, true])("BTW slash dispatch stays out of parent transcript and queue, running=%s", async (running) => {
  let text = "/btw Why this design?";
  const untouched = vi.fn(() => { throw new Error("Must not enter the parent pipeline"); });
  const openBtw = vi.fn(async () => {});
  const submit = createPromptSubmit({
    client: () => ({ prompt: untouched }), sessionMutationRunning: () => false, sessionHistoryLoading: () => false,
    waitForAttachmentDraftSettled: async () => {}, attachmentDraftKey: () => "a", attachmentGeneration: () => 1,
    promptText: () => text, promptAttachments: () => [], setPromptText: (next: string) => text = next,
    activeSessionId: () => "a", sessionRuntimeReady: () => true, promptRunning: () => running,
    openBtw, invalidateAttachmentDraft: () => {}, appendUserMessage: untouched, queueDraftForCurrentRun: untouched,
    materializeDraftSession: untouched, prompts: { runPromptRequest: untouched }, reportError: untouched,
  } as unknown as Parameters<typeof createPromptSubmit>[0]);
  await submit.submit(); expect(openBtw).toHaveBeenCalledWith("a", "Why this design?");
  expect(untouched).not.toHaveBeenCalled(); expect(text).toBe("");
});

it("BTW never routes attached or malformed commands to the parent", async () => {
  const report = vi.fn(); const open = vi.fn(); let text = "/btw question";
  const submit = createPromptSubmit({ sessionMutationRunning: () => false, waitForAttachmentDraftSettled: async () => {},
    attachmentDraftKey: () => "a", promptText: () => text, promptAttachments: () => [{}], reportError: report, openBtw: open,
    setPromptText: (value: string) => text = value } as unknown as Parameters<typeof createPromptSubmit>[0]);
  await submit.submit(); expect(report).toHaveBeenCalledOnce(); expect(open).not.toHaveBeenCalled(); expect(text).toBe("/btw question");
  expect(parseDesktopSlashCommand("/btw", false)).toEqual({ kind: "btw", question: "" });
  expect(parseDesktopSlashCommand("/BTW Why?", false)).toEqual({ kind: "btw", question: "Why?" });
  expect(parseDesktopSlashCommand("/btwice", false)).toBeUndefined();
  expect(DESKTOP_SLASH_COMMANDS.some((entry) => entry.name === "btw")).toBe(true);
});
