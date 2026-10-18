import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createPromptRuntime } from "./prompt-runtime.svelte";

describe("Stop auto-queue ownership", () => {
  it("keeps queued work stopped through settlement and late pushes until an explicit new run", async () => {
    let finish!: (value: { stopReason: "cancelled" }) => void;
    const client = {
      prompt: vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
        .mockResolvedValue({ stopReason: "end_turn" }),
      cancel: vi.fn().mockResolvedValue(undefined),
      takeAutoMessage: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpClient;
    const runtime = createPromptRuntime({
      client: () => client, activeSessionId: () => "source", runtimeReady: () => true,
      operationRunning: () => false, sessionHistoryLoading: () => false,
      setErrorMessage: vi.fn(), reportError: vi.fn(), appendQueuedMessage: vi.fn(),
      bindPromptSessionEntry: vi.fn(), finalizeTranscriptActivity: vi.fn(),
    });
    const pending = runtime.runPromptRequest(client, "source", []);
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledOnce());
    await runtime.cancelActivePrompt();
    finish({ stopReason: "cancelled" });
    await pending;
    runtime.handleQueueState({ sessionId: "source", items: [] });
    await runtime.flushAutoQueue("source");
    expect(client.takeAutoMessage).not.toHaveBeenCalled();

    await runtime.runPromptRequest(client, "source", []);
    await vi.waitFor(() => expect(client.takeAutoMessage).toHaveBeenCalledWith("source"));
  });
});
