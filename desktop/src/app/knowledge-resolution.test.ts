import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import type { KnowledgeResolutionRequest } from "../lib/knowledge-resolution";
import { createKnowledgeResolution } from "./knowledge-resolution.svelte";

const { buildPrompt, buildBatchPrompt } = vi.hoisted(() => ({ buildPrompt: vi.fn(), buildBatchPrompt: vi.fn() }));
vi.mock("../lib/knowledge-resolution", () => ({ knowledgeResolutionPrompt: buildPrompt, knowledgeBatchResolutionPrompt: buildBatchPrompt }));

const prompt = "Разбери проверенный отчёт и сохрани более новые правки пользователя.";
const input = (workspace = "/one"): KnowledgeResolutionRequest => ({
  workspace, content: "Reviewed draft", result: { status: "incomplete", path: "wiki/rules.md", documentHash: "a".repeat(64),
    modelRef: "test/judge", reportLanguage: "ru", checkedSources: 1, conflicts: [], notices: ["Missing deployment scope."] },
});

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  let workspace = "/one", generation = 0, ready = true, running = false;
  const client = {
    newSession: vi.fn(async (_workspace: string) => ({ sessionId: "resolution-session" })),
    closeSession: vi.fn(async (_sessionId: string) => {}),
  };
  let currentClient: typeof client | null = client;
  const runtime = {
    ensure: vi.fn(async (_client: unknown, _sessionId: string, _workspace: string) => {}),
    isReady: vi.fn(() => true),
  };
  const prompts = { runPromptRequest: vi.fn(async () => {}) };
  const activate = vi.fn((_sessionId: string, _workspace: string, _prompt: string) => "message-1");
  const forget = vi.fn(), started = vi.fn(), refresh = vi.fn(), reportError = vi.fn();
  const resolution = createKnowledgeResolution({
    client: () => currentClient as unknown as AcpClient | null, workspace: () => workspace, generation: () => generation,
    ready: () => ready, operationRunning: () => running, runtime: runtime as any, prompts: prompts as any,
    forgetRuntime: forget, activate, onStarted: started, refreshSessions: refresh, reportError,
  });
  return {
    resolution, client, runtime, prompts, activate, forget, started, refresh, reportError,
    changeWorkspace(value: string) { workspace = value; },
    nextGeneration() { generation++; },
    setClient(value: typeof client | null) { currentClient = value; },
    setReady(value: boolean) { ready = value; },
    setRunning(value: boolean) { running = value; },
  };
}

beforeEach(() => {
  buildPrompt.mockReset(); buildPrompt.mockResolvedValue(prompt);
  buildBatchPrompt.mockReset(); buildBatchPrompt.mockReturnValue(prompt);
});

describe("Wiki report to new resolution session", () => {
  it("is idle until explicitly started and hands the complete prompt to a distinct ready session", async () => {
    const f = fixture(), request = input();
    expect(f.resolution.starting).toBe(false);
    expect(f.client.newSession).not.toHaveBeenCalled();
    await f.resolution.start(request);
    expect(buildPrompt).toHaveBeenCalledExactlyOnceWith(request);
    expect(f.client.newSession).toHaveBeenCalledExactlyOnceWith("/one");
    expect(f.runtime.ensure).toHaveBeenCalledExactlyOnceWith(f.client, "resolution-session", "/one");
    expect(f.activate).toHaveBeenCalledExactlyOnceWith("resolution-session", "/one", prompt);
    expect(f.prompts.runPromptRequest).toHaveBeenCalledExactlyOnceWith(f.client, "resolution-session",
      [{ type: "text", text: prompt }], [], "message-1");
    expect(f.started).toHaveBeenCalledExactlyOnceWith("resolution-session");
    expect(f.refresh).toHaveBeenCalled();
    expect(f.client.closeSession).not.toHaveBeenCalled();
    expect(f.forget).not.toHaveBeenCalled();
    expect(f.reportError).not.toHaveBeenCalled();
    expect(f.resolution.starting).toBe(false);
  });

  it.each(["not-ready", "operation", "workspace", "client"])("does not allocate a session when blocked by %s", async reason => {
    const f = fixture();
    if (reason === "not-ready") f.setReady(false);
    if (reason === "operation") f.setRunning(true);
    if (reason === "workspace") f.changeWorkspace("/two");
    if (reason === "client") f.setClient(null);
    await f.resolution.start(input());
    expect(buildPrompt).not.toHaveBeenCalled();
    expect(f.client.newSession).not.toHaveBeenCalled();
    expect(f.resolution.starting).toBe(false);
  });

  it("deduplicates clicks while the same environment is creating the new session", async () => {
    const f = fixture(), created = deferred<{ sessionId: string }>();
    f.client.newSession.mockReturnValueOnce(created.promise);
    const first = f.resolution.start(input());
    await vi.waitFor(() => expect(f.client.newSession).toHaveBeenCalledOnce());
    expect(f.resolution.starting).toBe(true);
    await f.resolution.start(input());
    expect(buildPrompt).toHaveBeenCalledOnce();
    expect(f.client.newSession).toHaveBeenCalledOnce();
    created.resolve({ sessionId: "only-session" });
    await first;
    expect(f.activate).toHaveBeenCalledExactlyOnceWith("only-session", "/one", prompt);
    expect(f.resolution.starting).toBe(false);
  });

  it("abandons a stale prompt build before allocating any session", async () => {
    const f = fixture(), built = deferred<string>();
    buildPrompt.mockReturnValueOnce(built.promise);
    const pending = f.resolution.start(input());
    f.nextGeneration();
    built.resolve(prompt);
    await pending;
    expect(f.client.newSession).not.toHaveBeenCalled();
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.reportError).not.toHaveBeenCalled();
    expect(f.resolution.starting).toBe(false);
  });

  it.each(["workspace", "generation", "client"])("closes only the newly created orphan after a %s switch", async change => {
    const f = fixture(), created = deferred<{ sessionId: string }>();
    const replacement = { newSession: vi.fn(async (_workspace: string) => ({ sessionId: "other-session" })),
      closeSession: vi.fn(async (_sessionId: string) => {}) };
    f.client.newSession.mockReturnValueOnce(created.promise);
    const pending = f.resolution.start(input());
    await vi.waitFor(() => expect(f.client.newSession).toHaveBeenCalledOnce());
    if (change === "workspace") f.changeWorkspace("/two");
    if (change === "generation") f.nextGeneration();
    if (change === "client") f.setClient(replacement);
    expect(f.resolution.starting).toBe(false);
    created.resolve({ sessionId: "created-orphan" });
    await pending;
    expect(f.client.closeSession).toHaveBeenCalledExactlyOnceWith("created-orphan");
    expect(f.forget).toHaveBeenCalledExactlyOnceWith("created-orphan");
    expect(replacement.closeSession).not.toHaveBeenCalled();
    expect(f.runtime.ensure).not.toHaveBeenCalled();
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.prompts.runPromptRequest).not.toHaveBeenCalled();
    expect(f.reportError).not.toHaveBeenCalled();
  });

  it.each(["workspace", "generation", "round-trip"])("closes the created session when runtime preparation becomes stale after %s", async change => {
    const f = fixture(), ensured = deferred<void>();
    f.runtime.ensure.mockReturnValueOnce(ensured.promise);
    const pending = f.resolution.start(input());
    await vi.waitFor(() => expect(f.runtime.ensure).toHaveBeenCalledOnce());
    if (change === "workspace") f.changeWorkspace("/two");
    if (change === "generation") f.nextGeneration();
    if (change === "round-trip") {
      f.changeWorkspace("/two"); f.nextGeneration();
      f.changeWorkspace("/one"); f.nextGeneration();
    }
    ensured.resolve(undefined);
    await pending;
    expect(f.client.closeSession).toHaveBeenCalledExactlyOnceWith("resolution-session");
    expect(f.forget).toHaveBeenCalledExactlyOnceWith("resolution-session");
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.prompts.runPromptRequest).not.toHaveBeenCalled();
    expect(f.started).not.toHaveBeenCalled();
    expect(f.reportError).not.toHaveBeenCalled();
    expect(f.resolution.starting).toBe(false);
  });

  it("does not let completion of the old orphan clear or activate a newer launch", async () => {
    const f = fixture(), old = deferred<{ sessionId: string }>(), current = deferred<{ sessionId: string }>();
    f.client.newSession.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const oldLaunch = f.resolution.start(input());
    await vi.waitFor(() => expect(f.client.newSession).toHaveBeenCalledTimes(1));
    f.changeWorkspace("/two"); f.nextGeneration();
    const newLaunch = f.resolution.start(input("/two"));
    await vi.waitFor(() => expect(f.client.newSession).toHaveBeenCalledTimes(2));
    old.resolve({ sessionId: "old-session" });
    await oldLaunch;
    expect(f.resolution.starting).toBe(true);
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.client.closeSession).toHaveBeenCalledExactlyOnceWith("old-session");
    current.resolve({ sessionId: "new-session" });
    await newLaunch;
    expect(f.activate).toHaveBeenCalledExactlyOnceWith("new-session", "/two", prompt);
    expect(f.forget).toHaveBeenCalledExactlyOnceWith("old-session");
    expect(f.resolution.starting).toBe(false);
  });

  it("forgets the orphan before closing so late close completion cannot delete a reopened runtime", async () => {
    const f = fixture(), ensured = deferred<void>(), closing = deferred<void>();
    const runtimes = new Map<string, string>([["resolution-session", "orphan"]]);
    f.runtime.ensure.mockReturnValueOnce(ensured.promise);
    f.client.closeSession.mockReturnValueOnce(closing.promise);
    f.forget.mockImplementation((sessionId: string) => runtimes.delete(sessionId));
    const pending = f.resolution.start(input());
    await vi.waitFor(() => expect(f.runtime.ensure).toHaveBeenCalledOnce());
    f.nextGeneration();
    ensured.resolve(undefined);
    await vi.waitFor(() => expect(f.client.closeSession).toHaveBeenCalledExactlyOnceWith("resolution-session"));
    expect(f.forget).toHaveBeenCalledExactlyOnceWith("resolution-session");
    expect(runtimes.has("resolution-session")).toBe(false);
    runtimes.set("resolution-session", "reopened");
    closing.resolve(undefined);
    await pending;
    expect(runtimes.get("resolution-session")).toBe("reopened");
    expect(f.forget).toHaveBeenCalledTimes(1);
    expect(f.activate).not.toHaveBeenCalled();
  });

  it.each(["prompt", "creation"])("reports an initial %s failure without closing an unrelated session", async phase => {
    const f = fixture(), failure = new Error("Could not start the resolution");
    if (phase === "prompt") buildPrompt.mockRejectedValueOnce(failure);
    else f.client.newSession.mockRejectedValueOnce(failure);
    await f.resolution.start(input());
    expect(f.reportError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(f.client.closeSession).not.toHaveBeenCalled();
    expect(f.forget).not.toHaveBeenCalled();
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.resolution.starting).toBe(false);
  });

  it.each(["rejected", "not-ready"])("cleans up only its created session if preparation is %s", async phase => {
    const f = fixture(), failure = new Error("Runtime setup failed");
    if (phase === "rejected") f.runtime.ensure.mockRejectedValueOnce(failure);
    else f.runtime.isReady.mockReturnValueOnce(false);
    await f.resolution.start(input());
    expect(f.client.closeSession).toHaveBeenCalledExactlyOnceWith("resolution-session");
    expect(f.forget).toHaveBeenCalledExactlyOnceWith("resolution-session");
    expect(f.reportError).toHaveBeenCalledOnce();
    if (phase === "rejected") expect(f.reportError).toHaveBeenCalledWith(failure);
    else expect(String(f.reportError.mock.calls[0]?.[0])).toContain("Не удалось подготовить новую сессию");
    expect(f.activate).not.toHaveBeenCalled();
    expect(f.prompts.runPromptRequest).not.toHaveBeenCalled();
    expect(f.resolution.starting).toBe(false);
  });

  it("suppresses an obsolete runtime preparation error while still cleaning up its orphan", async () => {
    const f = fixture(), ensured = deferred<void>();
    f.runtime.ensure.mockReturnValueOnce(ensured.promise);
    const pending = f.resolution.start(input());
    await vi.waitFor(() => expect(f.runtime.ensure).toHaveBeenCalledOnce());
    f.nextGeneration();
    ensured.reject(new Error("Old runtime disconnected"));
    await pending;
    expect(f.client.closeSession).toHaveBeenCalledExactlyOnceWith("resolution-session");
    expect(f.reportError).not.toHaveBeenCalled();
  });

  it("reports a rejected prompt run and retains the already activated session for inspection or retry", async () => {
    const f = fixture(), run = deferred<void>(), failure = new Error("Model request failed");
    f.prompts.runPromptRequest.mockReturnValueOnce(run.promise);
    await f.resolution.start(input());
    run.reject(failure);
    await vi.waitFor(() => expect(f.reportError).toHaveBeenCalledExactlyOnceWith(failure));
    expect(f.activate).toHaveBeenCalledOnce();
    expect(f.client.closeSession).not.toHaveBeenCalled();
    expect(f.forget).not.toHaveBeenCalled();
  });

  it("does not surface a stale initial catalog refresh error in the next workspace generation", async () => {
    const f = fixture(), run = deferred<void>(), refresh = deferred<void>();
    f.prompts.runPromptRequest.mockReturnValueOnce(run.promise);
    f.refresh.mockReturnValueOnce(refresh.promise);
    await f.resolution.start(input());
    expect(f.refresh).toHaveBeenCalledOnce();
    f.nextGeneration();
    refresh.reject(new Error("Old catalog refresh failed"));
    await refresh.promise.catch(() => {});
    await Promise.resolve();
    expect(f.reportError).not.toHaveBeenCalled();
    run.resolve(undefined);
    await run.promise;
    expect(f.client.closeSession).not.toHaveBeenCalled();
  });

  it.each(["success", "error"])("does not refresh or report an old run's %s after a workspace generation switch", async outcome => {
    const f = fixture(), run = deferred<void>();
    f.prompts.runPromptRequest.mockReturnValueOnce(run.promise);
    await f.resolution.start(input());
    f.refresh.mockClear();
    f.nextGeneration();
    if (outcome === "success") run.resolve(undefined);
    else run.reject(new Error("Old generation failed"));
    await run.promise.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.reportError).not.toHaveBeenCalled();
    expect(f.client.closeSession).not.toHaveBeenCalled();
  });
});

describe("Wiki basket to new resolution session", () => {
  const batch = (workspace = "/one") => ({ workspace, language: "ru" as const, items: [] });

  it("sends the batch prompt to a new session and reports success", async () => {
    const f = fixture(), request = batch();
    await expect(f.resolution.startBatch(request)).resolves.toBe(true);
    expect(buildBatchPrompt).toHaveBeenCalledExactlyOnceWith(request);
    expect(buildPrompt).not.toHaveBeenCalled();
    expect(f.activate).toHaveBeenCalledExactlyOnceWith("resolution-session", "/one", prompt);
    expect(f.started).toHaveBeenCalledExactlyOnceWith("resolution-session");
  });

  it("reports false without a session when blocked, and closes the session on failure", async () => {
    const blocked = fixture();
    blocked.setRunning(true);
    await expect(blocked.resolution.startBatch(batch())).resolves.toBe(false);
    expect(blocked.client.newSession).not.toHaveBeenCalled();

    const failing = fixture();
    failing.runtime.isReady.mockReturnValue(false);
    await expect(failing.resolution.startBatch(batch())).resolves.toBe(false);
    expect(failing.client.closeSession).toHaveBeenCalledExactlyOnceWith("resolution-session");
    expect(failing.reportError).toHaveBeenCalledOnce();
    expect(String(failing.reportError.mock.calls[0]![0])).toContain("Не удалось подготовить");
  });

  it("reports false when the workspace changes while the prompt is built", async () => {
    const f = fixture();
    buildBatchPrompt.mockImplementationOnce(() => { f.changeWorkspace("/two"); return prompt; });
    await expect(f.resolution.startBatch(batch())).resolves.toBe(false);
    expect(f.client.newSession).not.toHaveBeenCalled();
  });
});
