import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createProjectActions } from "./project-actions.svelte";

describe("IDX AI knowledge review in new session", () => {
  it("submits global cleanup with bounded escalation and task-scoped CLI v2 audit guidance", async () => {
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
    expect(prompt).not.toContain("idx ask");
    expect(prompt).toContain("idx audit <changed-paths...>");
    expect(prompt).toContain(".indexer-cli/spec-template.md");
    expect(prompt).toContain("Review each affected primary spec against code and tests");
    expect(prompt).toContain("Check idx knowledge dirty before reviewing");
    expect(prompt).toContain("idx knowledge acknowledge <spec-paths...>");
    expect(prompt).toContain("Acknowledge unchanged specs too");
    expect(prompt).toContain("Never acknowledge unreviewed specs, specs with unresolved drift");
    expect(prompt).toContain("Finally, run idx knowledge dirty again");
    expect(prompt).toContain("unless the command succeeds and returns no");
    expect(prompt).toContain("if review is incomplete or the command is unsupported, report that limitation");
    expect(prompt).toContain("Restore the entire project knowledge base to a verified clean state");
    expect(prompt).toContain("scope is not limited to paths entered in the panel");
    expect(prompt).toContain("Completing one task's audit does not establish that this global cleanup succeeded");
    expect(prompt).toContain("Concurrent changes to a reviewed spec or any declared implementation/test dependency invalidate that review");
    expect(prompt).toContain("do not acknowledge work that is still being edited by another agent");
    expect(prompt).toContain("at most two review passes total");
    expect(prompt).toContain("one corrective pass");
    expect(prompt).toContain("Do not poll for cleanliness");
    expect(prompt).toContain("delegate repeated cleanup loops to bypass this limit");
    expect(prompt).toContain("Escalate to the user and stop autonomous cleanup immediately");
    expect(prompt).toContain("still yes or unknown after the pass limit");
    expect(prompt).toContain("explicitly unclassified remaining dirtiness");
    expect(prompt).toContain("command errors/exit codes");
    expect(prompt).toContain("Leave the global cleanup todo blocked/deferred rather than completed");
    expect(prompt).toContain("resume only on explicit user instruction");
    expect(prompt).toContain("complete the global cleanup todo only when the final complete exit-0 dirty check returns no");
    expect(prompt).toContain("task-scoped audit success must be reported independently");
    expect(prompt).not.toMatch(/wiki|knowledge status|unverified\s*=|needs review\s*=|whole worktree/i);
    expect(runPrompt).toHaveBeenCalledWith(client, "session-1", [{ type: "text", text: prompt }], [], "message-1");
  });
});
