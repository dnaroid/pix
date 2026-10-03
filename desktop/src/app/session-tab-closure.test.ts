import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmRunningTabClose } from "../lib/close-confirmation";
import { createSessionTabClosure } from "./session-tab-closure";
import type { SessionTabControllerOptions } from "./session-tab-controller-options";

vi.mock("../lib/close-confirmation", () => ({ confirmRunningTabClose: vi.fn() }));
beforeEach(() => vi.mocked(confirmRunningTabClose).mockReset().mockResolvedValue(true));

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
  let errorMessage: string | null = null;
  const state = {
    sessionId: activeSessionId,
    deleteSessionTranscript: vi.fn(),
    saveActiveTranscript: vi.fn(),
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
    draft: { openStartTab: vi.fn(async () => undefined) },
    runtime: { invalidatePrewarm: vi.fn() },
    history: { cancel: vi.fn() },
    tabSessionIds: () => tabSessionIds,
    setOperationRunning: vi.fn(),
    setErrorMessage: vi.fn((message: string | null) => { errorMessage = message; }),
    forgetRuntime: vi.fn(),
    clearSessionActivity: vi.fn(),
    forgetComposerDraft: vi.fn(),
    retargetWorkbenchAnchors: vi.fn(),
    reportError: vi.fn((error: unknown) => { errorMessage = String(error); }),
  } as unknown as SessionTabControllerOptions;
  const loadSession = vi.fn(async () => undefined);

  return {
    closure: createSessionTabClosure(options, loadSession),
    client,
    loadSession,
    options,
    tabs,
    getErrorMessage: () => errorMessage,
    setWorkspace(value: string) { workspace = value; },
  };
}

describe("session tab closure", () => {
  it.each(["active", "background"])("cancelling running %s close preserves the tab and runtime", async (id) => {
    const h = createHarness("active", ["active", "background"], async () => ({}));
    h.options.promptRunning = () => true;
    vi.mocked(confirmRunningTabClose).mockResolvedValueOnce(false);
    await expect(h.closure.closeSessionTab(id)).resolves.toBe(false);
    expect(confirmRunningTabClose).toHaveBeenCalledOnce();
    expect(h.client.closeSession).not.toHaveBeenCalled();
    expect(h.tabs.markClosed).not.toHaveBeenCalled();
    expect(h.options.runtime.invalidatePrewarm).not.toHaveBeenCalled();
    expect(h.options.clearSessionActivity).not.toHaveBeenCalled();
  });

  it("deduplicates close attempts while consent is pending, then closes exactly once", async () => {
    const consent = deferred<boolean>();
    const close = deferred<Record<string, never>>();
    const h = createHarness("active", ["active", "background"], () => close.promise);
    h.options.promptRunning = () => true;
    vi.mocked(confirmRunningTabClose).mockReturnValueOnce(consent.promise);
    const pending = h.closure.closeSessionTab("background");
    await expect(h.closure.closeSessionTab("background")).resolves.toBe(false);
    expect(h.tabs.markClosed).not.toHaveBeenCalled();
    consent.resolve(true);
    await vi.waitFor(() => expect(h.tabs.markClosed).toHaveBeenCalledWith("background"));
    expect(h.client.closeSession).toHaveBeenCalledOnce();
    close.resolve({});
    await expect(pending).resolves.toBe(true);
  });

  it("does not close a session in a replacement workspace after delayed consent", async () => {
    const consent = deferred<boolean>();
    const h = createHarness("active", ["active"], async () => ({}));
    h.options.promptRunning = () => true;
    vi.mocked(confirmRunningTabClose).mockReturnValueOnce(consent.promise);
    const pending = h.closure.closeSessionTab("active");
    h.setWorkspace("/other");
    consent.resolve(true);
    await expect(pending).resolves.toBe(false);
    expect(h.client.closeSession).not.toHaveBeenCalled();
  });

  it("fails closed if the confirmation dialog cannot open and permits retry", async () => {
    const h = createHarness("active", ["active"], async () => ({}));
    h.options.promptRunning = () => true;
    vi.mocked(confirmRunningTabClose).mockRejectedValueOnce(new Error("dialog unavailable"));
    await expect(h.closure.closeSessionTab("active")).resolves.toBe(false);
    expect(h.options.reportError).toHaveBeenCalledOnce();
    expect(h.tabs.markClosed).not.toHaveBeenCalled();
    await expect(h.closure.closeSessionTab("active")).resolves.toBe(true);
  });

  it.each([false, true])("hides a participant without touching its runtime (active=%s)", async (active) => {
    const h = createHarness(active ? "participant" : "parent", ["participant", "parent"], async () => ({}));
    h.options.isBrainstormParticipant = (id) => id === "participant";
    h.options.promptRunning = () => true;
    const confirm = vi.fn(() => false);
    vi.stubGlobal("window", { confirm });
    await expect(h.closure.closeSessionTab("participant", "parent")).resolves.toBe(true);
    expect(h.tabs.markClosed).toHaveBeenCalledWith("participant");
    expect(confirm).not.toHaveBeenCalled();
    expect(h.client.closeSession).not.toHaveBeenCalled();
    expect(h.client.deleteSession).not.toHaveBeenCalled();
    expect(h.options.forgetRuntime).not.toHaveBeenCalled();
    expect(h.options.clearSessionActivity).not.toHaveBeenCalled();
    expect(h.options.state.deleteSessionTranscript).not.toHaveBeenCalled();
    expect(h.options.forgetComposerDraft).not.toHaveBeenCalled();
    if (active) expect(h.loadSession).toHaveBeenCalledWith("parent");
    else expect(h.loadSession).not.toHaveBeenCalled();
  });

  it("opens a draft after hiding the sole participant, without reopening itself", async () => {
    const h = createHarness("participant", ["participant"], async () => ({}));
    h.options.isBrainstormParticipant = () => true;
    await expect(h.closure.closeSessionTab("participant", "participant")).resolves.toBe(true);
    expect(h.options.state.saveActiveTranscript).toHaveBeenCalledOnce();
    expect(h.options.state.clearActiveSession).toHaveBeenCalledOnce();
    expect(h.options.draft.openStartTab).toHaveBeenCalledOnce();
    expect(h.client.closeSession).not.toHaveBeenCalled();
    expect(h.loadSession).not.toHaveBeenCalled();
  });

  it("still respects mutation guards when hiding a participant", async () => {
    const h = createHarness("participant", ["participant"], async () => ({}));
    h.options.isBrainstormParticipant = () => true;
    h.options.sessionMutationRunning = () => true;
    await expect(h.closure.closeSessionTab("participant")).resolves.toBe(false);
    expect(h.tabs.markClosed).not.toHaveBeenCalled();
  });

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
    const { closure, getErrorMessage, loadSession, options, tabs } = createHarness("closing", ["closing", "next"], () => request.promise);

    const result = closure.closeSessionTab("closing", "next");

    expect(tabs.markClosed).toHaveBeenCalledWith("closing");
    expect(loadSession).not.toHaveBeenCalled();

    options.reportError(new Error("unknown session closing"));
    request.resolve({});
    await expect(result).resolves.toBe(true);
    expect(loadSession).toHaveBeenCalledWith("next");
    expect(getErrorMessage()).toBeNull();
    expect(options.setOperationRunning).toHaveBeenCalledWith(true);
    expect(options.setOperationRunning).toHaveBeenCalledWith(false);
  });

  it("opens the sole-tab draft without carrying a teardown-time session error", async () => {
    const request = deferred<Record<string, never>>();
    const { closure, getErrorMessage, loadSession, options, tabs } = createHarness("closing", ["closing"], () => request.promise);

    const pending = closure.closeSessionTab("closing");
    expect(tabs.markClosed).toHaveBeenCalledWith("closing");
    // Another session-scoped request may fail after ACP removes the runtime,
    // but before the close response clears the active session ID.
    options.reportError(new Error("unknown session closing"));
    request.resolve({});

    await expect(pending).resolves.toBe(true);
    expect(options.state.clearActiveSession).toHaveBeenCalledOnce();
    expect(options.tabs.forgetActive).toHaveBeenCalledWith("/project");
    expect(options.draft.openStartTab).toHaveBeenCalledOnce();
    expect(loadSession).not.toHaveBeenCalled();
    expect(getErrorMessage()).toBeNull();
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
