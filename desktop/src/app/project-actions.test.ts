import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createProjectActions } from "./project-actions.svelte";

function reviewHarness() {
    const client = {
      newSession: vi.fn().mockResolvedValue({ sessionId: "session-1" }),
      closeSession: vi.fn().mockResolvedValue(undefined),
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
    return { client, options, appendUserMessage, runPrompt };
}

describe("SQLite project task launch", () => {
  it.each([
    [undefined, null],
    ["provider/smart-model", { modelRef: "provider/smart-model" }],
    ["provider/smart-model:high", { modelRef: "provider/smart-model", thinkingLevel: "high" }],
  ] as const)("respects optional assigned model %s only for newly launched task sessions", async (ref, config) => {
    const { client, options } = reviewHarness();
    const task = {
      id: "task-1", title: "Run assigned task", type: "feature" as const,
      status: "todo" as const, priority: "medium" as const,
      ...(ref ? { modelRef: ref } : {}),
      createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
    };
    options.taskDocument = () => ({ version: 1, tasks: [task] });
    options.taskAttachments = async () => [];
    await createProjectActions(options).runTask(task);
    if (config) expect(client.newSession).toHaveBeenCalledExactlyOnceWith("/project", config);
    else expect(client.newSession).toHaveBeenCalledExactlyOnceWith("/project");
  });

  it("resolves only task-linked content-addressed attachments via the native query", async () => {
    const { options, appendUserMessage, runPrompt } = reviewHarness();
    const task = {
      id: "task-1", title: "Inspect artifact", type: "feature" as const,
      status: "todo" as const, priority: "medium" as const,
      createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
    };
    const files = [{ path: "/project/.pi/task-attachments/abcdef", name: "results.txt", size: 12 }];
    const taskAttachments = vi.fn().mockResolvedValue(files);
    const prepareTranscriptAttachment = vi.fn().mockResolvedValue(undefined);
    const saveProjectTasks = vi.fn().mockResolvedValue(true);
    options.taskDocument = () => ({ version: 1, tasks: [task] });
    options.taskAttachments = taskAttachments;
    options.prepareTranscriptAttachment = prepareTranscriptAttachment;
    options.saveProjectTasks = saveProjectTasks;
    await createProjectActions(options).runTask(task);
    expect(taskAttachments).toHaveBeenCalledWith("/project", "task-1");
    expect(prepareTranscriptAttachment).toHaveBeenCalledWith(expect.objectContaining({
      name: "results.txt", path: files[0]!.path,
    }));
    expect(appendUserMessage).toHaveBeenCalledWith("session-1", expect.stringContaining("Task id: task-1"), [
      expect.objectContaining({ name: "results.txt", path: files[0]!.path }),
    ]);
    expect(saveProjectTasks).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({ id: "task-1", sessionId: "session-1", status: "in-progress" })],
    }));
    expect(runPrompt).toHaveBeenCalledOnce();
  });
});
