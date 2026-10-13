import { describe, expect, it, vi } from "vitest";
import type { AcpClient, QueueState } from "../lib/acp-client";
import { createPromptQueueRuntime } from "./prompt-queue-runtime.svelte";

function setup() {
  const takeAutoMessage = vi.fn().mockResolvedValue(undefined);
  const client = { takeAutoMessage } as unknown as AcpClient;
  const queue = createPromptQueueRuntime({
    client: () => client, activeSessionId: () => "s", runtimeReady: () => true,
    isRunning: () => false, hasPromptRun: () => false, agentState: () => "idle",
    runPromptRequest: vi.fn(), appendQueuedMessage: vi.fn(), reportError: vi.fn(),
  });
  return { queue, takeAutoMessage };
}

describe("explicit queued-send dispatch hold", () => {
  it("does not dispatch an auto message returned after an explicit send takes ownership", async () => {
    let resolve!: (message: { id: string; promptText: string; displayText: string; images: [] }) => void;
    const take = new Promise<{ id: string; promptText: string; displayText: string; images: [] }>((done) => { resolve = done; });
    const client = { takeAutoMessage: vi.fn(() => take), deferMessage: vi.fn().mockResolvedValue(undefined) };
    const runPromptRequest = vi.fn();
    const queue = createPromptQueueRuntime({ client: () => client as unknown as AcpClient, activeSessionId: () => "s", runtimeReady: () => true,
      isRunning: () => false, hasPromptRun: () => false, agentState: () => "idle", runPromptRequest, appendQueuedMessage: vi.fn(), reportError: vi.fn() });
    const flushing = queue.flushAutoQueue("s");
    const release = queue.holdAutoQueue("s");
    resolve({ id: "q", promptText: "keep me", displayText: "keep me", images: [] });
    await flushing;
    expect(runPromptRequest).not.toHaveBeenCalled();
    expect(client.deferMessage).toHaveBeenCalledWith("s", [{ type: "text", text: "keep me" }], "keep me");
    queue.clearSession("s");
    release();
  });

  it("blocks idle notifications and settlement flushes until released", async () => {
    const { queue, takeAutoMessage } = setup();
    const release = queue.holdAutoQueue("s");
    queue.handleQueueState({ sessionId: "s", items: [] } as QueueState);
    await queue.flushAutoQueue("s");
    expect(takeAutoMessage).not.toHaveBeenCalled();
    release();
    expect(takeAutoMessage).toHaveBeenCalledWith("s");
    release();
    expect(takeAutoMessage).toHaveBeenCalledOnce();
  });

  it("keeps sessions independent and waits for all holds", async () => {
    const { queue, takeAutoMessage } = setup();
    const first = queue.holdAutoQueue("s");
    const second = queue.holdAutoQueue("s");
    await queue.flushAutoQueue("other");
    expect(takeAutoMessage).toHaveBeenCalledWith("other");
    takeAutoMessage.mockClear();
    first();
    await queue.flushAutoQueue("s");
    expect(takeAutoMessage).not.toHaveBeenCalled();
    second();
    expect(takeAutoMessage).toHaveBeenCalledWith("s");
  });

  it.each(["clear", "reset"])("ignores an old release after %s and replacement ownership", async (cleanup) => {
    const { queue, takeAutoMessage } = setup();
    const staleRelease = queue.holdAutoQueue("s");
    if (cleanup === "clear") queue.clearSession("s");
    else queue.reset();
    const release = queue.holdAutoQueue("s");
    staleRelease();
    await queue.flushAutoQueue("s");
    expect(takeAutoMessage).not.toHaveBeenCalled();
    release();
    expect(takeAutoMessage).toHaveBeenCalledWith("s");
  });
});
