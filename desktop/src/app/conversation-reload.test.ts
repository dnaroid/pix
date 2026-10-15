import { describe, expect, it, vi } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";
import { createActiveSessionState } from "./active-session-state.svelte";
import { createConversationSessionActions } from "./conversation-session-actions";
import { createSessionRuntimeStore } from "./session-runtime.svelte";
import { createSessionTabSelection } from "./session-tab-selection";
import type { SessionTabControllerOptions } from "./session-tab-controller-options";

type Response = Awaited<ReturnType<AcpClient["reloadSession"]>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function config(value: string): SessionConfigOption[] {
  return [{ id: "model", name: "Model", type: "select", currentValue: value, options: [{ value, name: value }] }];
}

function setup(busy: { prompt?: boolean; history?: boolean } = {}) {
  const state = createActiveSessionState();
  state.setSessionId("a");
  const reloads = new Map<string, ReturnType<typeof deferred<Response>>>();
  const load = deferred<Response>();
  const client = {
    reloadSession: vi.fn((id: string) => {
      const request = deferred<Response>();
      reloads.set(id, request);
      return request.promise;
    }),
    loadSession: vi.fn(() => load.promise),
  } as unknown as AcpClient;
  let currentClient = client;
  let workspace = "/work";
  let operationRunning = false;
  const setOperationRunning = vi.fn((running: boolean) => { operationRunning = running; });
  const reportError = vi.fn();
  const refreshSessions = vi.fn();
  const scrollToLatest = vi.fn(async () => {});
  const runtime = createSessionRuntimeStore({
    client: () => currentClient,
    workspace: () => workspace,
    activeSessionId: () => state.sessionId,
    setActiveReady: state.setRuntimeReady,
    setActiveConfigOptions: state.setConfigOptions,
    refreshQueueState: vi.fn(),
    reportError,
  });
  runtime.markReady("a", config("old-a"));
  runtime.markReady("b", config("old-b"));
  state.setConfigOptions(config("old-a"));
  state.saveActiveTranscript();
  state.setSessionTranscript("b", { items: [] });
  const actions = createConversationSessionActions({
    client: () => currentClient,
    state,
    workspace: () => workspace,
    promptText: () => "",
    operationRunning: () => operationRunning,
    setOperationRunning,
    promptRunning: () => !!busy.prompt,
    sessionHistoryLoading: () => !!busy.history,
    setErrorMessage: vi.fn(),
    setPromptText: vi.fn(),
    markRuntimeReady: runtime.markReady,
    reloadRuntime: runtime.reload,
    beginHistoryLoad: () => 1,
    hydrateHistory: vi.fn(async () => {}),
    refreshSessions,
    closeProjectSelector: vi.fn(),
    closeSessionSelector: vi.fn(),
    clearCommandPicker: vi.fn(),
    requestLocalTextInput: vi.fn(async () => undefined),
    nextLocalMessageId: () => "reload-echo",
    scrollToLatest,
    reportError,
  });
  const selection = createSessionTabSelection({
    client: () => currentClient,
    state,
    workspace: () => workspace,
    statusReady: () => true,
    operationRunning: () => operationRunning,
    runtime,
    draft: { active: false, deactivate: vi.fn() },
    switchComposerDraft: vi.fn(),
    closeProjectSelector: vi.fn(),
    tabs: { closeSelector: vi.fn(), show: vi.fn(), rememberActive: vi.fn() },
    history: { needsHydration: () => false, cancel: vi.fn() },
    setErrorMessage: vi.fn(),
    tabSessionIds: () => [],
  } as unknown as SessionTabControllerOptions);
  return {
    state, client, reloads, load, runtime, actions, selection, setOperationRunning,
    refreshSessions, reportError, scrollToLatest,
    setOperation: (value: boolean) => { operationRunning = value; },
    setClient: (value: AcpClient) => { currentClient = value; },
    setWorkspace: (value: string) => { workspace = value; },
  };
}

describe("session-local /reload", () => {
  it.each(["prompt", "history", "transition", "unready", "no-workspace"] as const)("retains the %s guard", async (blocker) => {
    const f = setup({ prompt: blocker === "prompt", history: blocker === "history" });
    if (blocker === "transition") f.setOperation(true);
    if (blocker === "unready") f.runtime.forget("a");
    if (blocker === "no-workspace") f.setWorkspace("");
    await f.actions.reloadResources();
    expect(f.client.reloadSession).not.toHaveBeenCalled();
    expect(f.state.transcript.items).toHaveLength(0);
    expect(f.setOperationRunning).not.toHaveBeenCalled();
  });

  it("keeps other tabs usable and joins reload on tab re-entry instead of reusing stale readiness", async () => {
    const f = setup();
    const oldOwner = f.runtime.captureOwnership("a");
    const pending = f.actions.reloadResources();
    expect(f.state.runtimeReady).toBe(false);
    expect(f.runtime.isReady("a")).toBe(false);
    expect(f.runtime.isLoading("a")).toBe(true);
    expect(oldOwner()).toBe(false);
    expect(f.setOperationRunning).not.toHaveBeenCalled();
    await f.actions.reloadResources();
    expect(f.client.reloadSession).toHaveBeenCalledExactlyOnceWith("a");

    await f.selection.loadSession("b");
    expect(f.state.sessionId).toBe("b");
    expect(f.state.runtimeReady).toBe(true);
    expect(f.state.configOptions).toEqual(config("old-b"));
    await f.selection.loadSession("a");
    expect(f.state.sessionId).toBe("a");
    expect(f.state.runtimeReady).toBe(false);
    expect(f.client.loadSession).not.toHaveBeenCalled();
    const waitingSend = f.runtime.ensure(f.client, "a", "/work");
    const owner = f.runtime.captureOwnership("a");
    let sendReady = false;
    void waitingSend.then(() => { sendReady = owner() && f.runtime.isReady("a"); });
    await Promise.resolve();
    expect(sendReady).toBe(false);
    f.reloads.get("a")!.resolve({ configOptions: config("new-a") });
    await Promise.all([pending, waitingSend]);
    expect(sendReady).toBe(true);
    expect(f.state.runtimeReady).toBe(true);
    expect(f.state.configOptions).toEqual(config("new-a"));
    expect(f.runtime.isLoading("a")).toBe(false);
    expect(f.setOperationRunning).not.toHaveBeenCalled();
  });

  it("commits background completion to its own cache without changing the selected conversation", async () => {
    const f = setup();
    const pending = f.actions.reloadResources();
    const echoed = f.state.transcript;
    expect(echoed.items).toHaveLength(1);
    await f.selection.loadSession("b");
    const transcriptB = f.state.transcript;
    f.reloads.get("a")!.resolve({ configOptions: config("new-a") });
    await pending;
    expect(f.state.sessionId).toBe("b");
    expect(f.state.transcript).toEqual(transcriptB);
    expect(f.state.configOptions).toEqual(config("old-b"));
    expect(f.state.runtimeReady).toBe(true);
    expect(f.runtime.getConfigOptions("a")).toEqual(config("new-a"));
    await f.selection.loadSession("a");
    expect(f.state.configOptions).toEqual(config("new-a"));
    expect(f.state.transcript).toEqual(echoed);
  });

  it.each([false, true])("does not release another session's reload on settlement (failure=%s)", async (failure) => {
    const f = setup();
    const first = f.actions.reloadResources({ echo: false });
    await f.selection.loadSession("b");
    const second = f.actions.reloadResources({ echo: false });
    f.setOperation(true); // An unrelated workspace transition owns the global flag.
    if (failure) f.reloads.get("a")!.reject(new Error("reload failed"));
    else f.reloads.get("a")!.resolve({ configOptions: config("new-a") });
    await first;
    expect(f.runtime.isLoading("b")).toBe(true);
    expect(f.state.runtimeReady).toBe(false);
    expect(f.reportError).toHaveBeenCalledTimes(failure ? 1 : 0);
    f.reloads.get("b")!.resolve({ configOptions: config("new-b") });
    await second;
    expect(f.state.configOptions).toEqual(config("new-b"));
    expect(f.setOperationRunning).not.toHaveBeenCalled();
  });

  it("keeps failed reload unready and permits a later load retry", async () => {
    const f = setup();
    const pending = f.actions.reloadResources();
    f.reloads.get("a")!.reject(new Error("reload failed"));
    await pending;
    expect(f.runtime.isReady("a")).toBe(false);
    expect(f.runtime.isLoading("a")).toBe(false);
    expect(f.state.runtimeReady).toBe(false);
    expect(f.reportError).toHaveBeenCalledTimes(1);
    const retry = f.runtime.ensure(f.client, "a", "/work");
    f.load.resolve({ configOptions: config("retry-a") });
    await retry;
    expect(f.state.runtimeReady).toBe(true);
  });

  it.each([false, true])("ignores retired reload after close and same-ID reopen (failure=%s)", async (failure) => {
    const f = setup();
    const pending = f.actions.reloadResources();
    f.runtime.forget("a");
    const reopened = f.runtime.ensure(f.client, "a", "/work");
    if (failure) f.reloads.get("a")!.reject(new Error("closed reload"));
    else f.reloads.get("a")!.resolve({ configOptions: config("obsolete-a") });
    await pending;
    expect(f.runtime.isLoading("a")).toBe(true);
    expect(f.runtime.isReady("a")).toBe(false);
    expect(f.reportError).not.toHaveBeenCalled();
    f.load.resolve({ configOptions: config("reopened-a") });
    await reopened;
    expect(f.state.configOptions).toEqual(config("reopened-a"));
    expect(f.state.runtimeReady).toBe(true);
  });

  for (const invalidation of ["client", "workspace", "reset"] as const) {
    it.each([false, true])(`ignores obsolete reload after ${invalidation} change (failure=%s)`, async (failure) => {
      const f = setup();
      const pending = f.actions.reloadResources();
      if (invalidation === "client") f.setClient({} as AcpClient);
      if (invalidation === "workspace") f.setWorkspace("/other");
      if (invalidation === "reset") f.runtime.reset();
      if (failure) f.reloads.get("a")!.reject(new Error("obsolete reload"));
      else f.reloads.get("a")!.resolve({ configOptions: config("obsolete-a") });
      await pending;
      expect(f.runtime.isReady("a")).toBe(false);
      expect(f.runtime.getConfigOptions("a")).toBeUndefined();
      expect(f.reportError).not.toHaveBeenCalled();
      if (invalidation !== "reset") expect(f.refreshSessions).not.toHaveBeenCalled();
      expect(f.setOperationRunning).not.toHaveBeenCalled();
    });
  }

  it("invalidates config mutations for the reloaded session only", async () => {
    const f = setup();
    const oldA = f.runtime.beginConfigChange("a", "model");
    const oldB = f.runtime.beginConfigChange("b", "model");
    const first = f.runtime.reload(f.client, "a", "/work");
    const duplicate = f.runtime.reload(f.client, "a", "/work");
    expect(duplicate).toBe(first);
    expect(f.runtime.configChangeIsCurrent("a", oldA)).toBe(false);
    expect(f.runtime.configChangeIsCurrent("b", oldB)).toBe(true);
    expect(f.client.reloadSession).toHaveBeenCalledTimes(1);
    f.reloads.get("a")!.resolve({ configOptions: config("new-a") });
    await first;
  });

  it("does not wait for scrolling to start reload, and reports scroll failure without leaving a lock", async () => {
    const f = setup();
    const scroll = deferred<void>();
    f.scrollToLatest.mockReturnValueOnce(scroll.promise);
    const pending = f.actions.reloadResources();
    expect(f.client.reloadSession).toHaveBeenCalledTimes(1);
    expect(f.state.runtimeReady).toBe(false);
    scroll.reject(new Error("scroll failed"));
    f.reloads.get("a")!.resolve({ configOptions: config("new-a") });
    await pending;
    expect(f.reportError).toHaveBeenCalledExactlyOnceWith(new Error("scroll failed"));
    expect(f.state.runtimeReady).toBe(true);
    expect(f.setOperationRunning).not.toHaveBeenCalled();
  });
});
