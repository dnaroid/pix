import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionTabClosure } from "./session-tab-closure";
import type { SessionTabControllerOptions } from "./session-tab-controller-options";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => vi.unstubAllGlobals());

function createHarness(
  activeSessionId: string,
  tabSessionIds: readonly string[],
  closeSession: () => Promise<Record<string, never>>,
) {
  let workspace = "/project";
  const state = {
    sessionId: activeSessionId,
    deleteSessionTranscript: vi.fn(),
    clearActiveSession: vi.fn(),
  };
  const client = {
    closeSession: vi.fn(closeSession),
    deleteSession: vi.fn(async () => ({})),
  };
  const tabs = {
    closeSelector: vi.fn(),
    markClosed: vi.fn(),
    show: vi.fn(),
    forgetActive: vi.fn(),
  };
  const options = {
    client: () => client,
    workspace: () => workspace,
    sessionMutationRunning: () => false,
    promptRunning: () => false,
    state,
    catalog: {
      sessions: [
        { sessionId: activeSessionId, title: "Active" },
        ...tabSessionIds
          .filter((sessionId) => sessionId !== activeSessionId)
          .map((sessionId) => ({ sessionId, title: sessionId })),
      ],
      remove: vi.fn(),
      refresh: vi.fn(async () => undefined),
    },
    tabs,
    runtime: { invalidatePrewarm: vi.fn() },
    history: { cancel: vi.fn() },
    tabSessionIds: () => tabSessionIds,
    setOperationRunning: vi.fn(),
    setErrorMessage: vi.fn(),
    forgetRuntime: vi.fn(),
    clearSessionActivity: vi.fn(),
    forgetComposerDraft: vi.fn(),
    retargetWorkbenchAnchors: vi.fn(),
    reportError: vi.fn(),
  } as unknown as SessionTabControllerOptions;
  const loadSession = vi.fn(async () => undefined);

  return {
    closure: createSessionTabClosure(options, loadSession),
    client,
    loadSession,
    options,
    tabs,
    setWorkspace(value: string) { workspace = value; },
  };
}

describe("session tab closure", () => {
  it("hides a background tab before ACP close resolves", async () => {
    const request = deferred<Record<string, never>>();
    const { closure, options, tabs } = createHarness("active", ["active", "closing"], () => request.promise);

    const result = closure.closeSessionTab("closing");

    expect(tabs.markClosed).toHaveBeenCalledWith("closing");
    expect(options.forgetRuntime).not.toHaveBeenCalled();
    expect(options.setOperationRunning).not.toHaveBeenCalled();

    request.resolve({});
    await expect(result).resolves.toBe(true);
    expect(options.forgetRuntime).toHaveBeenCalledWith("closing");
    expect(options.setOperationRunning).not.toHaveBeenCalled();
  });

  it("hides the active tab before ACP close resolves and loads the fallback after teardown", async () => {
    const request = deferred<Record<string, never>>();
    const { closure, loadSession, options, tabs } = createHarness("closing", ["closing", "next"], () => request.promise);

    const result = closure.closeSessionTab("closing", "next");

    expect(tabs.markClosed).toHaveBeenCalledWith("closing");
    expect(loadSession).not.toHaveBeenCalled();

    request.resolve({});
    await expect(result).resolves.toBe(true);
    expect(loadSession).toHaveBeenCalledWith("next");
    expect(options.setOperationRunning).toHaveBeenCalledWith(true);
    expect(options.setOperationRunning).toHaveBeenCalledWith(false);
  });

  it("restores an optimistically hidden tab when ACP close fails", async () => {
    const request = deferred<Record<string, never>>();
    const { closure, options, tabs } = createHarness("active", ["active", "closing"], () => request.promise);

    const result = closure.closeSessionTab("closing");

    expect(tabs.markClosed).toHaveBeenCalledWith("closing");
    request.reject(new Error("close failed"));

    await expect(result).resolves.toBe(false);
    expect(tabs.show).toHaveBeenCalledWith("closing");
    expect(options.reportError).toHaveBeenCalledOnce();
  });

  it("ignores a background close completion after the workspace changes", async () => {
    const request = deferred<Record<string, never>>();
    const { closure, options, setWorkspace } = createHarness(
      "active",
      ["active", "closing"],
      () => request.promise,
    );

    const pending = closure.closeSessionTab("closing");
    setWorkspace("/other");
    request.resolve({});
    await pending;

    expect(options.forgetRuntime).not.toHaveBeenCalled();
    expect(options.clearSessionActivity).not.toHaveBeenCalled();
    expect(options.reportError).not.toHaveBeenCalled();
    expect(options.setOperationRunning).not.toHaveBeenCalled();
  });

  it("deletes a background session without taking the global operation lock", async () => {
    const request = deferred<Record<string, never>>();
    const { closure, client, options } = createHarness("active", ["active", "deleting"], async () => ({}));
    client.deleteSession.mockReturnValueOnce(request.promise);
    vi.stubGlobal("window", { confirm: vi.fn(() => true) });

    const pending = closure.deleteSelectedSession("deleting");

    expect(client.deleteSession).toHaveBeenCalledWith("deleting");
    expect(options.setOperationRunning).not.toHaveBeenCalled();

    request.resolve({});
    await pending;

    expect(options.catalog.remove).toHaveBeenCalledWith("deleting");
    expect(options.setOperationRunning).not.toHaveBeenCalled();
  });
});
