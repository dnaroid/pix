import { describe, expect, it, vi } from "vitest";
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

function createHarness(
  activeSessionId: string,
  tabSessionIds: readonly string[],
  closeSession: () => Promise<Record<string, never>>,
) {
  const state = {
    sessionId: activeSessionId,
    deleteSessionTranscript: vi.fn(),
    clearActiveSession: vi.fn(),
  };
  const client = { closeSession: vi.fn(closeSession) };
  const tabs = {
    closeSelector: vi.fn(),
    markClosed: vi.fn(),
    show: vi.fn(),
    forgetActive: vi.fn(),
  };
  const options = {
    client: () => client,
    workspace: () => "/project",
    sessionMutationRunning: () => false,
    promptRunning: () => false,
    state,
    catalog: { sessions: [] },
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
  };
}

describe("session tab closure", () => {
  it("hides a background tab before ACP close resolves", async () => {
    const request = deferred<Record<string, never>>();
    const { closure, options, tabs } = createHarness("active", ["active", "closing"], () => request.promise);

    const result = closure.closeSessionTab("closing");

    expect(tabs.markClosed).toHaveBeenCalledWith("closing");
    expect(options.forgetRuntime).not.toHaveBeenCalled();

    request.resolve({});
    await expect(result).resolves.toBe(true);
    expect(options.forgetRuntime).toHaveBeenCalledWith("closing");
  });

  it("hides the active tab before ACP close resolves and loads the fallback after teardown", async () => {
    const request = deferred<Record<string, never>>();
    const { closure, loadSession, tabs } = createHarness("closing", ["closing", "next"], () => request.promise);

    const result = closure.closeSessionTab("closing", "next");

    expect(tabs.markClosed).toHaveBeenCalledWith("closing");
    expect(loadSession).not.toHaveBeenCalled();

    request.resolve({});
    await expect(result).resolves.toBe(true);
    expect(loadSession).toHaveBeenCalledWith("next");
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
});
