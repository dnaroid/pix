import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createPromptSubmit } from "./prompt-submit";

function setup() {
  let activeSessionId = "session-a";
  let draft = "Keep this unfinished draft";
  let running = false;
  let ready = true;
  const queued = vi.fn(async () => {});
  const sent = vi.fn(async () => {});
  const append = vi.fn(() => vi.fn());
  const refreshQueueState = vi.fn(async () => {});
  const client = { queueMessage: queued } as unknown as AcpClient;
  const submit = createPromptSubmit({
    client: () => client,
    activeSessionId: () => activeSessionId,
    sessionMutationRunning: () => false,
    sessionHistoryLoading: () => false,
    sessionRuntimeReady: () => ready,
    promptRunning: () => running,
    nextLocalMessageId: () => "local:sandbox",
    appendUserMessage: append,
    scrollToLatest: async () => {},
    refreshSessions: async () => {},
    prompts: { hasPromptRun: () => running, runPromptRequest: sent, refreshQueueState },
    reportError: vi.fn(),
  } as unknown as Parameters<typeof createPromptSubmit>[0]);
  return {
    submit, queued, sent, append, refreshQueueState,
    get draft() { return draft; },
    setSession: (id: string) => { activeSessionId = id; },
    setRunning: (value: boolean) => { running = value; },
    setReady: (value: boolean) => { ready = value; },
  };
}

describe("HTML sandbox ACP submission", () => {
  it("routes a form submission directly without clobbering the composer", async () => {
    const test = setup();
    expect(await test.submit.submitHtmlSandbox("session-a", "assistant:3", { color: "blue" })).toBe("sent");
    expect(test.queued).not.toHaveBeenCalled();
    expect(test.append).toHaveBeenCalledWith(expect.stringContaining('"color": "blue"'), "local:sandbox", []);
    expect(test.sent).toHaveBeenCalledWith(expect.anything(), "session-a", [
      { type: "text", text: expect.stringContaining('"color": "blue"') },
    ], [], "local:sandbox");
    expect(test.draft).toBe("Keep this unfinished draft");
  });

  it("queues on a running session without generating another prompt", async () => {
    const test = setup();
    test.setRunning(true);
    expect(await test.submit.submitHtmlSandbox("session-a", "assistant:3", { event: "game_over" })).toBe("queued");
    expect(test.queued).toHaveBeenCalledWith("session-a", [
      { type: "text", text: expect.stringContaining('"event": "game_over"') },
    ], expect.stringContaining("HTML Sandbox submission"));
    expect(test.sent).not.toHaveBeenCalled();
    expect(test.refreshQueueState).toHaveBeenCalledWith("session-a");
  });

  it("rejects a stale session, a closed runtime or a session switch during queueing", async () => {
    const test = setup();
    test.setSession("session-b");
    await expect(test.submit.submitHtmlSandbox("session-a", "a", {})).rejects.toThrow("not ready");
    test.setSession("session-a");
    test.setReady(false);
    await expect(test.submit.submitHtmlSandbox("session-a", "a", {})).rejects.toThrow("not ready");
    test.setReady(true);
    test.setRunning(true);
    let finish!: () => void;
    test.queued.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = test.submit.submitHtmlSandbox("session-a", "a", {});
    await expect(test.submit.submitHtmlSandbox("session-a", "a", {})).rejects.toThrow("not ready");
    test.setSession("session-b");
    finish();
    await expect(pending).rejects.toThrow("conversation changed");
  });
});
