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

describe("task plans", () => {
  const task = {
    id: "task-1", title: "Plan it", type: "feature" as const,
    status: "todo" as const, priority: "medium" as const,
    createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
  };

  it("links the plan path before starting an authoring-only session", async () => {
    const { client, options, appendUserMessage, runPrompt } = reviewHarness();
    let document = { version: 1 as const, tasks: [task] as typeof task[] };
    options.taskDocument = () => document;
    options.saveProjectTasks = vi.fn(async (next) => { document = next as typeof document; return true; });
    let active: string | null = null;
    options.activateSession = (id) => { active = id; };
    options.activeSessionId = () => active;
    await createProjectActions(options).createTaskPlan(task);
    expect(document.tasks[0]).toMatchObject({ links: [".pi/plans/tasks/task-1-plan-it.md"] });
    expect(client.newSession).toHaveBeenCalledExactlyOnceWith("/project");
    expect(appendUserMessage.mock.calls[0]![1]).toContain("do not implement the plan");
    expect(runPrompt).toHaveBeenCalledOnce();
  });

  it("does not create a session when saving the link fails or a plan already exists", async () => {
    const { client, options } = reviewHarness();
    options.taskDocument = () => ({ version: 1, tasks: [task] });
    options.saveProjectTasks = async () => false;
    await createProjectActions(options).createTaskPlan(task);
    await createProjectActions(options).createTaskPlan({ ...task, links: [".pi/plans/a.md"] });
    expect(client.newSession).not.toHaveBeenCalled();
  });

  it("runs an existing linked plan and records the launch", async () => {
    const { options, appendUserMessage } = reviewHarness();
    const linked = { ...task, links: [".pi/plans/a.md"] };
    options.taskDocument = () => ({ version: 1, tasks: [linked] });
    options.taskAttachments = async () => [];
    options.planAvailable = (path) => path === ".pi/plans/a.md";
    options.recordPlanLaunch = vi.fn();
    await createProjectActions(options).runTask(linked);
    expect(appendUserMessage.mock.calls[0]![1]).toContain('Execute the project plan stored at ".pi/plans/a.md"');
    expect(appendUserMessage.mock.calls[0]![1]).toContain("project task task-1");
    expect(options.recordPlanLaunch).toHaveBeenCalledExactlyOnceWith("/project", "session-1", ".pi/plans/a.md");
  });

  it("links an unowned plan to a task without a plan", async () => {
    const { options } = reviewHarness();
    const owner = { ...task, id: "task-2", links: [".pi/plans/owned.md"] };
    let document = { version: 1 as const, tasks: [task, owner] as typeof task[] };
    options.taskDocument = () => document;
    options.saveProjectTasks = vi.fn(async (next) => { document = next as typeof document; return true; });
    const actions = createProjectActions(options);
    expect(await actions.linkTaskPlan("task-1", ".pi/plans/owned.md")).toBe(false);
    expect(await actions.linkTaskPlan("task-1", "docs/x.md")).toBe(false);
    expect(await actions.linkTaskPlan("task-2", ".pi/plans/free.md")).toBe(false);
    expect(options.saveProjectTasks).not.toHaveBeenCalled();
    expect(await actions.linkTaskPlan("task-1", ".pi/plans/free.md")).toBe(true);
    expect(document.tasks[0]).toMatchObject({ links: [".pi/plans/free.md"] });
  });

  it("falls back to the task prompt when the linked plan file is missing", async () => {
    const { options, appendUserMessage } = reviewHarness();
    const linked = { ...task, links: [".pi/plans/gone.md"] };
    options.taskDocument = () => ({ version: 1, tasks: [linked] });
    options.taskAttachments = async () => [];
    options.planAvailable = () => false;
    options.recordPlanLaunch = vi.fn();
    await createProjectActions(options).runTask(linked);
    expect(appendUserMessage.mock.calls[0]![1]).toContain("Work on this project task.");
    expect(options.recordPlanLaunch).not.toHaveBeenCalled();
  });
});
