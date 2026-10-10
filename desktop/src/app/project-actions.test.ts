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
      knowledgeReviewModelRef: async (): Promise<string | undefined> => undefined,
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

describe("IDX AI knowledge review in new session", () => {
  it("submits self-contained sequential cleanup without subagents, with bounded escalation", async () => {
    const { client, options, appendUserMessage, runPrompt } = reviewHarness();
    await createProjectActions(options).refreshKnowledgeBase();
    expect(client.newSession).toHaveBeenCalledWith("/project");

    const prompt = appendUserMessage.mock.calls[0]?.[1] as string;
    expect(prompt.split("\n\n")).toHaveLength(8);
    expect(prompt.length).toBeLessThan(3300);
    for (const requirement of [
      "entire project knowledge base", "Check idx knowledge dirty before review",
      "dirty receipts alone do not prove documentation drift", "idx context / idx search",
      "every declared Implementation/Tests dependency", "including unchanged specs",
      "Repair only proven documentation drift", ".indexer-cli/spec-template.md",
      "Perform all work yourself in this session", "source review, documentation repairs, command checks, task audit and final acknowledgment",
      "Do not invoke subagents or spawn/delegate to any agents", "including knowledge-auditor, verify or research",
      "even if general workflow instructions require delegation", "lock conflicts",
      "Run knowledge-base operations sequentially, never in parallel", "track dependency coverage, findings and gaps yourself",
      "target project's .pi/artifacts/", "never root artifacts/ or .artifacts/",
      "harness evidence in .pi/subagents/", "idx audit <changed-paths...>",
      "task-changed paths only", "indexing/audit is not proof of review",
      "Run idx knowledge acknowledge <spec-paths...> yourself", "no unresolved drift",
      "acknowledge accurate unchanged specs too", "Never acknowledge unreviewed/incomplete/unstable work",
      "Concurrent spec/dependency changes invalidate review", "do not overwrite others' edits",
      "at most two review passes total", "one corrective pass", "identified, safe, unblocked gaps",
      "idx knowledge dirty after each pass", "Do not poll", "repeat unchanged failed commands",
      "launch replacement sessions", "delegate cleanup loops to bypass the limit",
      "Escalate immediately and stop", "missing sources", "failed/unsupported commands",
      "no safe corrective pass", "dirty remains yes/unknown at the limit",
      "Defer the global cleanup todo", "end the turn", "resume only on explicit user instruction",
      "no scheduled retries or waiting for agents", "final complete exit-0 idx knowledge dirty result of no",
      "only then complete its todo", "Otherwise report blocked", "unknown for failed/incomplete checks",
      "explicitly unclassified dirtiness", "reviewed/acknowledged paths", "coverage gaps",
      "command errors/exit codes", "next user action", "task-scoped audit success separately",
      "cannot override blocked global cleanup",
    ]) expect(prompt).toContain(requirement);
    expect(prompt).not.toMatch(/wiki|knowledge status|unverified\s*=|needs review\s*=|whole worktree|idx ask/i);
    expect(runPrompt).toHaveBeenCalledWith(client, "session-1", [{ type: "text", text: prompt }], [], "message-1");
  });

  it.each([
    ["provider/model", { modelRef: "provider/model" }],
    [" provider/model:high ", { modelRef: "provider/model", thinkingLevel: "high" }],
    ["provider/model:off", { modelRef: "provider/model", thinkingLevel: "off" }],
  ])("creates review with configured model %s before submitting the prompt", async (ref, config) => {
    const { client, options, runPrompt } = reviewHarness();
    options.knowledgeReviewModelRef = async () => ref as string;
    await createProjectActions(options).refreshKnowledgeBase();
    expect(client.newSession).toHaveBeenCalledWith("/project", config);
    expect(runPrompt).toHaveBeenCalledOnce();
  });

  it("reports invalid model configuration without creating a review session", async () => {
    const { client, options, runPrompt } = reviewHarness();
    options.knowledgeReviewModelRef = async () => "invalid";
    await createProjectActions(options).refreshKnowledgeBase();
    expect(client.newSession).not.toHaveBeenCalled();
    expect(runPrompt).not.toHaveBeenCalled();
    expect(options.reportError).toHaveBeenCalledWith(expect.objectContaining({
      message: "Knowledge review model must use provider/model[:thinking] format.",
    }));
  });

  it("does not create a session if workspace changes while preferences load", async () => {
    const { client, options, runPrompt } = reviewHarness();
    let resolve!: (ref: string) => void;
    options.knowledgeReviewModelRef = () => new Promise((done) => { resolve = done; });
    const pending = createProjectActions(options).refreshKnowledgeBase();
    options.workspace = () => "/other";
    resolve("provider/model:high");
    await pending;
    expect(client.newSession).not.toHaveBeenCalled();
    expect(runPrompt).not.toHaveBeenCalled();
  });

  it("does not create a session if the client disconnects while preferences load", async () => {
    const { client, options, runPrompt } = reviewHarness();
    let resolve!: (ref: string) => void;
    options.knowledgeReviewModelRef = () => new Promise((done) => { resolve = done; });
    const pending = createProjectActions(options).refreshKnowledgeBase();
    options.client = () => null as any;
    resolve("provider/model:high");
    await pending;
    expect(client.newSession).not.toHaveBeenCalled();
    expect(runPrompt).not.toHaveBeenCalled();
  });

  it("closes a stale session if workspace changes while session creation is pending", async () => {
    const { client, options, runPrompt } = reviewHarness();
    let resolve!: (result: { sessionId: string }) => void;
    vi.mocked(client.newSession).mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = createProjectActions(options).refreshKnowledgeBase();
    await Promise.resolve();
    options.workspace = () => "/other";
    resolve({ sessionId: "stale" });
    await pending;
    expect(client.closeSession).toHaveBeenCalledWith("stale");
    expect(runPrompt).not.toHaveBeenCalled();
  });
});

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
