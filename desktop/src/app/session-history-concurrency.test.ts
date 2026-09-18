import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import type { LazySessionHistory } from "../lib/acp-client-types";
import { type ToolItem } from "../lib/transcript";
import { createActiveSessionState } from "./active-session-state.svelte";
import { createSessionHistory } from "./session-history.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function result(text: string): SessionUpdate {
  return { sessionUpdate: "tool_call_update", toolCallId: "same-tool", status: "completed",
    content: [{ type: "content", content: { type: "text", text } }] };
}

function harness() {
  const toolResult = vi.fn<(...args: unknown[]) => Promise<SessionUpdate>>().mockResolvedValue(result("unexpected duplicate"));
  const sessionHistory = vi.fn<(...args: unknown[]) => Promise<LazySessionHistory>>();
  const client = { toolResult, sessionHistory } as unknown as AcpClient;
  const state = createActiveSessionState();
  state.setSessionId("session-1");
  state.setTranscript({ items: [{ type: "tool", id: "tool:same-tool", toolCallId: "same-tool", name: "read",
    title: "Read", kind: "read", status: "completed", content: "", diffs: [], attachments: [], deferredResult: true }] });
  const reportError = vi.fn();
  const history = createSessionHistory({
    client: () => client, state, workspace: () => "/project", ensureRuntime: vi.fn(async () => {}),
    runtimeReady: () => true, scheduleScrollToLatest: vi.fn(), recoverUnavailableSession: vi.fn(), reportError,
  });
  return { history, state, client, toolResult, sessionHistory, reportError };
}

describe("lazy history request ownership", () => {
  it("coalesces duplicate tool requests and does not request an already hydrated body", async () => {
    const h = harness();
    const response = deferred<SessionUpdate>();
    h.toolResult.mockReturnValueOnce(response.promise);
    const first = h.history.loadDeferredToolResult("same-tool");
    await h.history.loadDeferredToolResult("same-tool");
    expect(h.toolResult).toHaveBeenCalledTimes(1);
    response.resolve(result("body"));
    await first;
    await h.history.loadDeferredToolResult("same-tool");
    expect(h.toolResult).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "failure"])("an old %s cannot unlock a replacement request after cancel", async (outcome) => {
    const h = harness();
    const old = deferred<SessionUpdate>();
    const current = deferred<SessionUpdate>();
    h.toolResult.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const first = h.history.loadDeferredToolResult("same-tool");
    h.history.cancel();
    h.history.begin();
    const second = h.history.loadDeferredToolResult("same-tool");
    if (outcome === "success") old.resolve(result("stale body"));
    else old.reject(new Error("stale error"));
    await first;
    expect(h.state.transcript.items[0]).toMatchObject({ content: "", resultLoading: true });
    await h.history.loadDeferredToolResult("same-tool");
    expect(h.toolResult).toHaveBeenCalledTimes(2);
    current.resolve(result("current body"));
    await second;
    expect(h.state.transcript.items[0]).toMatchObject({ content: "current body", resultLoading: false });
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("begin alone invalidates the previous generation's in-flight deduplication", async () => {
    const h = harness();
    const old = deferred<SessionUpdate>();
    h.toolResult.mockReturnValueOnce(old.promise).mockResolvedValueOnce(result("new generation"));
    const first = h.history.loadDeferredToolResult("same-tool");
    h.history.begin();
    await h.history.loadDeferredToolResult("same-tool");
    expect(h.toolResult).toHaveBeenCalledTimes(2);
    old.resolve(result("old generation"));
    await first;
    expect(h.state.transcript.items[0]).toMatchObject({ content: "new generation" });
  });

  it("ignores a result after switching sessions even if the new session has the same tool ID", async () => {
    const h = harness();
    const old = deferred<SessionUpdate>();
    h.toolResult.mockReturnValueOnce(old.promise);
    const first = h.history.loadDeferredToolResult("same-tool");
    h.history.cancel();
    h.state.setSessionId("session-2");
    h.state.setTranscript({ items: [{ ...(h.state.transcript.items[0] as ToolItem), content: "new session", resultLoading: false }] });
    old.resolve(result("wrong session"));
    await first;
    expect(h.state.transcript.items[0]).toMatchObject({ content: "new session", resultLoading: false });
  });

  it("an old cursor completion cannot unlock a newer page request for the same session", async () => {
    const h = harness();
    const old = deferred<LazySessionHistory>();
    const current = deferred<LazySessionHistory>();
    const tail: LazySessionHistory = { updates: [], deferredToolCallIds: [], cursor: "4096" };
    h.sessionHistory.mockResolvedValueOnce(tail).mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(tail).mockReturnValueOnce(current.promise).mockResolvedValue(tail);
    await h.history.hydrate(h.client, "session-1", "/project", h.history.begin());
    const first = h.history.loadOlder();
    h.history.cancel();
    await h.history.hydrate(h.client, "session-1", "/project", h.history.begin());
    const second = h.history.loadOlder();
    old.resolve({ updates: [], deferredToolCallIds: [] });
    await first;
    await expect(h.history.loadOlder()).resolves.toBe(false);
    expect(h.sessionHistory).toHaveBeenCalledTimes(4);
    current.resolve({ updates: [], deferredToolCallIds: [] });
    await second;
  });
});
