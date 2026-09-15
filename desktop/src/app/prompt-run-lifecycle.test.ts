import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createPromptRunLifecycle } from "./prompt-run-lifecycle.svelte";

describe("prompt run notification lifecycle", () => {
  it("reports only the final run after the Desktop auto queue drains", async () => {
    const client = {
      prompt: vi.fn(async () => ({ stopReason: "end_turn" as const })),
    } as unknown as AcpClient;
    const onPromptSettled = vi.fn();
    let flushCount = 0;
    let runs!: ReturnType<typeof createPromptRunLifecycle>;
    runs = createPromptRunLifecycle({
      client: () => client,
      activeSessionId: () => "session-1",
      reportError: vi.fn(),
      bindPromptSessionEntry: vi.fn(),
      finalizeTranscriptActivity: vi.fn(),
      onPromptSettled,
      flushAutoQueue: async (sessionId) => {
        if (flushCount++ === 0) await runs.runPromptRequest(client, sessionId, []);
      },
    });

    await runs.runPromptRequest(client, "session-1", []);

    await vi.waitFor(() => expect(onPromptSettled).toHaveBeenCalledTimes(1));
    expect(client.prompt).toHaveBeenCalledTimes(2);
    expect(onPromptSettled).toHaveBeenCalledWith("session-1", "end_turn");
  });

  it("reports prompt failures through the dedicated agent error hook", async () => {
    const failure = new Error("worker crashed");
    const client = {
      prompt: vi.fn(async () => { throw failure; }),
    } as unknown as AcpClient;
    const onPromptError = vi.fn();
    const runs = createPromptRunLifecycle({
      client: () => client,
      activeSessionId: () => "session-1",
      reportError: vi.fn(),
      bindPromptSessionEntry: vi.fn(),
      finalizeTranscriptActivity: vi.fn(),
      onPromptError,
      flushAutoQueue: vi.fn(),
    });

    await expect(runs.runPromptRequest(client, "session-1", [])).rejects.toThrow("worker crashed");
    expect(onPromptError).toHaveBeenCalledWith("session-1", failure);
  });
});
