import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createProjectActions } from "./project-actions.svelte";
import type { ProjectTaskDocument } from "../lib/project-tasks";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function reviewHarness() {
    let activeSessionId: string | null = null;
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
      activeSessionId: () => activeSessionId,
      invalidateAttachmentDraft: () => {},
      openTasksPanel: () => {},
      closeProjectSelector: () => {},
      closeSessionSelector: () => {},
      setOperationRunning: () => {},
      setErrorMessage: () => {},
      ensureRuntime: async () => {},
      runtimeReady: () => true,
      forgetRuntime: () => {},
      activateSession: (id) => { activeSessionId = id; },
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

describe("concurrent task sessions", () => {
  function fixture() {
    const harness = reviewHarness();
    const tasks = ["task-1", "task-2"].map((id) => ({
      id, title: id, type: "feature" as const, status: "todo" as const, priority: "medium" as const,
      createdAt: "2026-10-10T00:00:00Z", updatedAt: "2026-10-10T00:00:00Z",
    }));
    let document: ProjectTaskDocument = { version: 1, tasks };
    harness.options.taskDocument = () => document;
    harness.options.saveProjectTasks = vi.fn(async (next) => { document = next; return true; });
    harness.options.taskAttachments = async () => [];
    harness.options.setOperationRunning = vi.fn();
    harness.options.loadSession = vi.fn().mockResolvedValue(undefined);
    let sessionNumber = 0;
    vi.mocked(harness.client.newSession).mockImplementation(async () => ({
      sessionId: `session-${++sessionNumber}`,
    }));
    return { ...harness, tasks, actions: createProjectActions(harness.options) };
  }

  it("starts another task in its own session before the first prompt finishes", async () => {
    const { tasks, actions, options, runPrompt, appendUserMessage, client } = fixture();
    const started = deferred<void>();
    const finished = deferred<void>();
    runPrompt.mockImplementationOnce(() => { started.resolve(); return finished.promise; });
    const first = actions.runTask(tasks[0]!);
    await started.promise;
    expect(actions.actionId).toBeNull();
    expect(options.setOperationRunning).toHaveBeenLastCalledWith(false);

    await actions.runTask(tasks[1]!);
    expect(client.newSession).toHaveBeenCalledTimes(2);
    expect(runPrompt.mock.calls.map((call) => call[1])).toEqual(["session-1", "session-2"]);
    expect(appendUserMessage).toHaveBeenCalledWith("session-1", expect.stringContaining("Task id: task-1"), []);
    expect(appendUserMessage).toHaveBeenCalledWith("session-2", expect.stringContaining("Task id: task-2"), []);
    expect(options.taskDocument().tasks).toEqual([
      expect.objectContaining({ id: "task-1", sessionId: "session-1", status: "in-progress" }),
      expect.objectContaining({ id: "task-2", sessionId: "session-2", status: "in-progress" }),
    ]);
    finished.resolve();
    await first;
  });

  it.each(["completed", "failed"])("does not unlock the next preparation when the old prompt %s", async (outcome) => {
    const { tasks, actions, options, runPrompt, client } = fixture();
    const started = deferred<void>();
    const finished = deferred<void>();
    const creating = deferred<void>();
    const created = deferred<{ sessionId: string }>();
    runPrompt.mockImplementationOnce(() => { started.resolve(); return finished.promise; });
    const first = actions.runTask(tasks[0]!);
    await started.promise;
    vi.mocked(client.newSession).mockImplementationOnce(() => { creating.resolve(); return created.promise; });
    const second = actions.runTask(tasks[1]!);
    await creating.promise;
    expect(actions.actionId).toBe("task-2");
    if (outcome === "failed") finished.reject(new Error("First prompt failed"));
    else finished.resolve();
    await first;
    expect(actions.actionId).toBe("task-2");
    expect(options.setOperationRunning).toHaveBeenLastCalledWith(true);
    expect(options.reportError).toHaveBeenCalledTimes(outcome === "failed" ? 1 : 0);
    await actions.runTask(tasks[1]!);
    expect(client.newSession).toHaveBeenCalledTimes(2);
    created.resolve({ sessionId: "session-2" });
    await second;
    expect(actions.actionId).toBeNull();
  });

  it("blocks repeated clicks during preparation and opens the saved session for a stale row afterward", async () => {
    const { tasks, actions, options, client } = fixture();
    const reading = deferred<void>();
    const attachments = deferred<[]>();
    options.taskAttachments = () => { reading.resolve(); return attachments.promise; };
    const first = actions.runTask(tasks[0]!);
    await reading.promise;
    await actions.runTask(tasks[0]!);
    expect(client.newSession).not.toHaveBeenCalled();
    attachments.resolve([]);
    await first;
    options.activeSessionId = () => "another-session";
    await actions.runTask(tasks[0]!);
    expect(client.newSession).toHaveBeenCalledOnce();
    expect(options.loadSession).toHaveBeenCalledWith("session-1");
  });

  it("discards a stale created session without unlocking a replacement after reset", async () => {
    const { tasks, actions, options, client, runPrompt } = fixture();
    const creating = deferred<void>();
    const created = deferred<{ sessionId: string }>();
    vi.mocked(client.newSession).mockImplementationOnce(() => { creating.resolve(); return created.promise; });
    const first = actions.runTask(tasks[0]!);
    await creating.promise;
    actions.reset();
    const reading = deferred<void>();
    const attachments = deferred<[]>();
    options.taskAttachments = () => { reading.resolve(); return attachments.promise; };
    const second = actions.runTask(tasks[1]!);
    await reading.promise;
    created.resolve({ sessionId: "stale" });
    await first;
    expect(client.closeSession).toHaveBeenCalledWith("stale");
    expect(actions.actionId).toBe("task-2");
    expect(options.setOperationRunning).toHaveBeenLastCalledWith(true);
    expect(runPrompt).not.toHaveBeenCalled();
    attachments.resolve([]);
    await second;
  });

  it.each(["runtime", "save", "scroll"])("does not send after reset during %s preparation", async (stage) => {
    const { tasks, actions, options, runPrompt } = fixture();
    if (stage === "runtime") options.ensureRuntime = async () => { actions.reset(); };
    if (stage === "save") options.saveProjectTasks = async () => { actions.reset(); return true; };
    if (stage === "scroll") options.scrollToLatest = async () => { actions.reset(); };
    await actions.runTask(tasks[0]!);
    expect(runPrompt).not.toHaveBeenCalled();
  });

  it.each(["runtime", "save", "scroll"])("does not send into another conversation after navigating during %s preparation", async (stage) => {
    const { tasks, actions, options, runPrompt } = fixture();
    const navigate = () => { options.activeSessionId = () => "another-session"; };
    if (stage === "runtime") options.ensureRuntime = async () => { navigate(); };
    if (stage === "save") options.saveProjectTasks = async () => { navigate(); return true; };
    if (stage === "scroll") options.scrollToLatest = async () => { navigate(); };
    await actions.runTask(tasks[0]!);
    expect(runPrompt).not.toHaveBeenCalled();
    expect(actions.actionId).toBeNull();
  });

  it("releases preparation after a failed save so another task can start", async () => {
    const { tasks, actions, options, runPrompt } = fixture();
    vi.mocked(options.saveProjectTasks).mockResolvedValueOnce(false);
    await actions.runTask(tasks[0]!);
    expect(runPrompt).not.toHaveBeenCalled();
    expect(actions.actionId).toBeNull();
    expect(options.setOperationRunning).toHaveBeenLastCalledWith(false);
    await actions.runTask(tasks[1]!);
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

  it.each(["cancelled", "failed"] as const)("settles a linked plan when preparation is %s before sending", async (outcome) => {
    const { options, runPrompt } = reviewHarness();
    const linked = { ...task, links: [".pi/plans/a.md"] };
    options.taskDocument = () => ({ version: 1, tasks: [linked] });
    options.taskAttachments = async () => [];
    options.planAvailable = () => true;
    options.recordPlanLaunch = vi.fn();
    options.settlePlanLaunch = vi.fn();
    const actions = createProjectActions(options);
    if (outcome === "cancelled") options.ensureRuntime = async () => { actions.reset(); };
    else options.runtimeReady = () => false;
    await actions.runTask(linked);
    expect(runPrompt).not.toHaveBeenCalled();
    expect(options.settlePlanLaunch).toHaveBeenCalledExactlyOnceWith("session-1", outcome, "/project");
  });
});
