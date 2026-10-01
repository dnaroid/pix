import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createPromptRunLifecycle } from "./prompt-run-lifecycle.svelte";

describe("prompt run notification lifecycle", () => {
  it.each(["next run", "clear session", "reset"] as const)(
    "ignores a stale completion after %s",
    async (transition) => {
      const client = {} as AcpClient;
      const finalizeTranscriptActivity = vi.fn();
      const flushAutoQueue = vi.fn();
      const onPromptSettled = vi.fn();
      const runs = createPromptRunLifecycle({
        client: () => client, activeSessionId: () => "session-1", reportError: vi.fn(),
        bindPromptSessionEntry: vi.fn(), finalizeTranscriptActivity, flushAutoQueue, onPromptSettled,
      });
      const staleGeneration = runs.beginRun("session-1");
      if (transition === "clear session") runs.clearSession("session-1");
      if (transition === "reset") runs.reset();
      const currentGeneration = runs.beginRun("session-1");

      // A late Continue finally must not finish a newer run, including after teardown.
      runs.finishRunAndFlush("session-1", staleGeneration, "cancelled");
      await Promise.resolve();
      expect(runs.isRunning("session-1")).toBe(true);
      expect(runs.endedAt("session-1")).toBeUndefined();
      expect(finalizeTranscriptActivity).not.toHaveBeenCalled();
      expect(flushAutoQueue).not.toHaveBeenCalled();
      expect(onPromptSettled).not.toHaveBeenCalled();

      runs.finishRunAndFlush("session-1", currentGeneration, "end_turn");
      await vi.waitFor(() => expect(onPromptSettled).toHaveBeenCalledWith("session-1", "end_turn"));
      expect(runs.isRunning("session-1")).toBe(false);
    },
  );

  it("does not flush a stale settlement microtask after a newer run starts", async () => {
    const client = {} as AcpClient;
    const flushAutoQueue = vi.fn();
    const runs = createPromptRunLifecycle({
      client: () => client, activeSessionId: () => "session-1", reportError: vi.fn(),
      bindPromptSessionEntry: vi.fn(), finalizeTranscriptActivity: vi.fn(), flushAutoQueue,
    });
    const generation = runs.beginRun("session-1");
    runs.finishRunAndFlush("session-1", generation, "end_turn");
    runs.beginRun("session-1");
    await Promise.resolve();
    expect(runs.isRunning("session-1")).toBe(true);
    expect(flushAutoQueue).not.toHaveBeenCalled();
  });

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
