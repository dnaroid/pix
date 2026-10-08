import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import type { LazySessionHistory } from "../lib/acp-client-types";
import { appendLocalUserMessage, emptyTranscript } from "../lib/transcript";
import { createActiveSessionState } from "./active-session-state.svelte";
import { createSessionHistory } from "./session-history.svelte";
import type { SessionTabControllerOptions } from "./session-tab-controller-options";
import { createSessionTabSelection } from "./session-tab-selection";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function page(text: string): LazySessionHistory {
  return {
    updates: [{ sessionUpdate: "user_message_chunk", messageId: `persisted:${text}`,
      content: { type: "text", text } }],
    deferredToolCallIds: [],
    cursor: "older",
  };
}

function fixture() {
  const sessionHistory = vi.fn<(...args: unknown[]) => Promise<LazySessionHistory>>();
  const client = { sessionHistory } as unknown as AcpClient;
  const state = createActiveSessionState();
  state.setSessionId("source");
  state.initializeSessionTranscript("source");
  const reportError = vi.fn();
  const history = createSessionHistory({
    client: () => client, state, workspace: () => "/work",
    ensureRuntime: vi.fn(async () => {}), runtimeReady: () => true,
    scheduleScrollToLatest: vi.fn(), recoverUnavailableSession: vi.fn(), reportError,
  });
  const selection = createSessionTabSelection({
    client: () => client, state, workspace: () => "/work", statusReady: () => true,
    operationRunning: () => false, sessionMutationRunning: () => false,
    draft: { active: false, deactivate: vi.fn() },
    closeProjectSelector: vi.fn(), setErrorMessage: vi.fn(), switchComposerDraft: vi.fn(),
    tabs: { closeSelector: vi.fn(), show: vi.fn(), replace: vi.fn(), rememberActive: vi.fn() },
    runtime: { getConfigOptions: () => [], isReady: () => true,
      ensure: vi.fn(async () => {}), schedulePrewarm: vi.fn(), invalidatePrewarm: vi.fn() },
    promptRunning: () => false, setOperationRunning: vi.fn(),
    refreshQueueState: vi.fn(), catalog: { refresh: vi.fn() }, reportError,
    tabSessionIds: () => ["source", "target"], history,
  } as unknown as SessionTabControllerOptions);
  return { state, history, selection, sessionHistory, reportError };
}

describe("conversation tab history restoration", () => {
  it.each([false, true])("retries interrupted history even with a cached transcript (partial=%s)", async (partial) => {
    const h = fixture();
    const old = deferred<LazySessionHistory>();
    const current = deferred<LazySessionHistory>();
    h.sessionHistory.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await h.selection.loadSession("target");
    if (partial) h.state.setTranscriptFor("target", appendLocalUserMessage(emptyTranscript, "live", "local:1"));
    await h.selection.loadSession("source");
    old.resolve(page("obsolete"));
    await Promise.resolve();
    await h.selection.loadSession("target");
    expect(h.sessionHistory).toHaveBeenCalledTimes(2);
    expect(h.history.loading).toBe(true);
    current.resolve(page("persisted"));
    await h.history.waitForHydration("target");
    expect(h.state.transcript.items).toMatchObject(partial
      ? [{ text: "persisted" }, { text: "live" }]
      : [{ text: "persisted" }]);
    expect(h.history.loading).toBe(false);
    await h.selection.loadSession("source");
    await h.selection.loadSession("target");
    expect(h.sessionHistory).toHaveBeenCalledTimes(2);
    expect(h.history.olderCursorCount).toBe(1);
  });

  it("retries a failed hydration rather than treating its empty cache as complete", async () => {
    const h = fixture();
    h.sessionHistory.mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValueOnce(page("retry"));
    await h.selection.loadSession("target");
    await h.history.waitForHydration("target");
    await h.selection.loadSession("source");
    await h.selection.loadSession("target");
    await h.history.waitForHydration("target");
    expect(h.sessionHistory).toHaveBeenCalledTimes(2);
    expect(h.state.transcript.items).toMatchObject([{ text: "retry" }]);
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });

  it("does not restart submit-owned hydration when returning to its tab", async () => {
    const h = fixture();
    const response = deferred<LazySessionHistory>();
    h.sessionHistory.mockReturnValueOnce(response.promise);
    await h.selection.loadSession("target");
    h.state.setTranscriptFor("target", appendLocalUserMessage(emptyTranscript, "optimistic", "local:1"));
    const acceptedSend = h.history.waitForHydration("target");
    await h.selection.loadSession("source");
    await h.selection.loadSession("target");
    expect(h.sessionHistory).toHaveBeenCalledTimes(1);
    response.resolve(page("persisted"));
    await acceptedSend;
    expect(h.state.transcript.items).toMatchObject([{ text: "persisted" }, { text: "optimistic" }]);
  });

  it("reuses a successfully hydrated empty session", async () => {
    const h = fixture();
    h.sessionHistory.mockResolvedValue({ updates: [], deferredToolCallIds: [] });
    await h.selection.loadSession("target");
    await h.history.waitForHydration("target");
    await h.selection.loadSession("source");
    await h.selection.loadSession("target");
    expect(h.sessionHistory).toHaveBeenCalledTimes(1);
    expect(h.state.transcript.items).toEqual([]);
  });

  it("retries an interrupted cached target when replacing a draft tab", async () => {
    const h = fixture();
    const old = deferred<LazySessionHistory>();
    h.sessionHistory.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page("replacement"));
    await h.selection.loadSession("target");
    h.state.saveActiveTranscript();
    h.history.cancel();
    h.state.setSessionId(null);
    h.state.resetConversation();
    await h.selection.replaceCurrentTabWithSession("target");
    await h.history.waitForHydration("target");
    old.resolve(page("obsolete"));
    await Promise.resolve();
    expect(h.sessionHistory).toHaveBeenCalledTimes(2);
    expect(h.state.transcript.items).toMatchObject([{ text: "replacement" }]);
  });

  it.each(["forget", "reset"])("clears incomplete history on %s without accepting a stale response", async (action) => {
    const h = fixture();
    const old = deferred<LazySessionHistory>();
    h.sessionHistory.mockReturnValueOnce(old.promise);
    await h.selection.loadSession("target");
    expect(h.history.needsHydration("target")).toBe(true);
    if (action === "forget") h.history.forget("target");
    else h.history.reset();
    expect(h.history.needsHydration("target")).toBe(false);
    old.resolve(page("obsolete"));
    await Promise.resolve();
    expect(h.state.transcript.items).toEqual([]);
  });
});
