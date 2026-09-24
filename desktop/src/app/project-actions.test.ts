import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createProjectActions } from "./project-actions.svelte";

describe("IDX update in new session", () => {
  it("submits task-scoped CLI v2 discovery and audit guidance in the new session", async () => {
    const client = {
      newSession: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
    } as unknown as AcpClient;
    const appendUserMessage = vi.fn().mockReturnValue("message-1");
    const runPrompt = vi.fn().mockResolvedValue(undefined);
    const options: Parameters<typeof createProjectActions>[0] = {
      client: () => client,
      workspace: () => "/project",
      canUseSession: () => true,
      tasksSaving: () => false,
      taskLoadFailed: () => false,
      taskDocument: () => ({ version: 1, tasks: [] }),
      saveProjectTasks: async () => true,
      newProjectTaskId: () => "task-1",
      attachmentDraftKey: () => "draft-1",
      attachmentGeneration: () => 0,
      waitForAttachmentDraftSettled: async () => {},
      promptText: () => "",
      promptAttachments: () => [],
      setPromptText: () => {},
      activeSessionId: () => null,
      invalidateAttachmentDraft: () => {},
      openTasksPanel: () => {},
      closeProjectSelector: () => {},
      closeSessionSelector: () => {},
      setOperationRunning: () => {},
      setErrorMessage: () => {},
      ensureRuntime: async () => {},
      runtimeReady: () => true,
      forgetRuntime: () => {},
      activateSession: () => {},
      prepareTranscriptAttachment: async () => {},
      imagePromptSupported: () => true,
      appendUserMessage,
      runPrompt,
      scrollToLatest: async () => {},
      refreshSessions: () => {},
      loadSession: async () => {},
      sessionMutationRunning: () => false,
      nextLocalMessageId: () => "message-1",
      reportError: vi.fn(),
    };

    await createProjectActions(options).refreshKnowledgeBase();

    const prompt = appendUserMessage.mock.calls[0]?.[1] as string;
    expect(prompt).toContain("idx search");
    expect(prompt).toContain("idx context");
    expect(prompt).toContain("idx ask");
    expect(prompt).toContain("idx audit <changed-paths...>");
    expect(prompt).toContain(".indexer-cli/spec-template.md");
    expect(prompt).toContain("Review each affected primary spec against code and tests");
    expect(prompt).not.toMatch(/wiki|knowledge status|unverified\s*=|needs review\s*=|whole worktree/i);
    expect(runPrompt).toHaveBeenCalledWith(client, "session-1", [{ type: "text", text: prompt }], [], "message-1");
  });
});
