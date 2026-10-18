import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createPromptRunLifecycle } from "./prompt-run-lifecycle.svelte";

describe("prompt run notification lifecycle", () => {
  it("cancels before the initial transcript snapshot without starting a late prompt", async () => {
    let resolveSnapshot!: (value: []) => void;
    const client = {
      branchUserMessages: vi.fn(() => new Promise<[]>((resolve) => { resolveSnapshot = resolve; })),
      prompt: vi.fn(), cancel: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpClient;
    const runs = createPromptRunLifecycle({
      client: () => client, activeSessionId: () => "source", reportError: vi.fn(),
      bindPromptSessionEntry: vi.fn(), finalizeTranscriptActivity: vi.fn(), flushAutoQueue: vi.fn(),
    });
    const pending = runs.runPromptRequestWithResult(client, "source", [], "local:1");
    const cancel = runs.cancelActivePrompt();
    expect(runs.isCancellationRequested("source")).toBe(true);
    expect(client.cancel).toHaveBeenCalledWith("source");
    await cancel;
    const completion = await pending;
    expect(completion?.stopReason).toBe("cancelled");
    expect(completion?.isCurrent()).toBe(false);
    expect(runs.isRunning("source")).toBe(false);
    resolveSnapshot([]);
    await Promise.resolve();
    expect(client.prompt).not.toHaveBeenCalled();
  });

  it("cuts off output synchronously but holds ownership until the prompt settles", async () => {
    let finish!: (value: { stopReason: "cancelled" }) => void;
    let acceptCancel!: () => void;
    const client = {
      prompt: vi.fn(() => new Promise((resolve) => { finish = resolve; })),
      cancel: vi.fn(() => new Promise<void>((resolve) => { acceptCancel = resolve; })),
    } as unknown as AcpClient;
    const runs = createPromptRunLifecycle({
      client: () => client, activeSessionId: () => "source", reportError: vi.fn(),
      bindPromptSessionEntry: vi.fn(), finalizeTranscriptActivity: vi.fn(), flushAutoQueue: vi.fn(),
    });
    const pending = runs.runPromptRequest(client, "source", []);
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledOnce());
    const cancel = runs.cancelActivePrompt();
    expect(runs.isCancellationRequested("source")).toBe(true);
    expect(runs.isCancellationRequested("other")).toBe(false);
    expect(runs.hasPromptRun("source")).toBe(true);
    expect(runs.isRunning("source")).toBe(true);
    acceptCancel();
    await cancel;
    expect(runs.isRunning("source")).toBe(true);
    finish({ stopReason: "cancelled" });
    await pending;
    expect(runs.isCancellationRequested("source")).toBe(true);
    runs.beginRun("source");
    expect(runs.isCancellationRequested("source")).toBe(false);
  });

  it("does not wait for post-prompt metadata after Stop", async () => {
    const bindPromptSessionEntry = vi.fn();
    const client = {
      branchUserMessages: vi.fn().mockResolvedValueOnce([]).mockImplementationOnce(() => new Promise(() => {})),
      prompt: vi.fn(async () => ({ stopReason: "end_turn" as const })),
      cancel: vi.fn().mockResolvedValue(undefined),
    } as unknown as AcpClient;
    const runs = createPromptRunLifecycle({
      client: () => client, activeSessionId: () => "source", reportError: vi.fn(),
      bindPromptSessionEntry, finalizeTranscriptActivity: vi.fn(), flushAutoQueue: vi.fn(),
    });
    const pending = runs.runPromptRequest(client, "source", [], [], "local:1");
    await vi.waitFor(() => expect(client.branchUserMessages).toHaveBeenCalledTimes(2));
    await runs.cancelActivePrompt();
    await pending;
    expect(runs.isRunning("source")).toBe(false);
    expect(bindPromptSessionEntry).not.toHaveBeenCalled();
  });

  it.each(["clear", "reset"] as const)("clears stopped output after %s", async (transition) => {
    const client = { cancel: vi.fn().mockResolvedValue(undefined) } as unknown as AcpClient;
    const runs = createPromptRunLifecycle({
      client: () => client, activeSessionId: () => "source", reportError: vi.fn(),
      bindPromptSessionEntry: vi.fn(), finalizeTranscriptActivity: vi.fn(), flushAutoQueue: vi.fn(),
    });
    runs.beginRun("source");
    await runs.cancelActivePrompt();
    if (transition === "clear") runs.clearSession("source");
    else runs.reset();
    expect(runs.isCancellationRequested("source")).toBe(false);
  });

  it.each(["current", "cancel", "clear", "reset", "client", "new run"] as const)(
    "exposes completion ownership for handoff (%s)", async (change) => {
      let finish!: (value: { stopReason: "end_turn" }) => void;
      const pending = new Promise<{ stopReason: "end_turn" }>((resolve) => { finish = resolve; });
      const client = { prompt: vi.fn(() => pending), cancel: vi.fn().mockResolvedValue(undefined) } as unknown as AcpClient;
      let activeClient = client;
      const runs = createPromptRunLifecycle({
        client: () => activeClient, activeSessionId: () => "source", reportError: vi.fn(),
        bindPromptSessionEntry: vi.fn(), finalizeTranscriptActivity: vi.fn(), flushAutoQueue: vi.fn(),
      });
      const result = runs.runPromptRequestWithResult(client, "source", []);
      await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledOnce());
      if (change === "cancel") await runs.cancelActivePrompt();
      if (change === "clear") runs.clearSession("source");
      if (change === "reset") runs.reset();
      if (change === "client") activeClient = {} as AcpClient;
      finish({ stopReason: "end_turn" });
      const completion = await result;
      if (change === "new run") runs.beginRun("source");
      expect(completion?.isCurrent() ?? false).toBe(change === "current");
      if (change === "current") expect(completion?.stopReason).toBe("end_turn");
    },
  );
  it.each(["current", "clear session", "reset", "replace client"] as const)(
    "binds the submitted prompt rather than the final steering entry (%s)",
    async (transition) => {
      let finish!: (value: { stopReason: "end_turn" }) => void;
      const client = {
        branchUserMessages: vi.fn()
          .mockResolvedValueOnce([{ entryId: "old", text: "repeat" }])
          .mockResolvedValueOnce([
            { entryId: "old", text: "repeat" },
            { entryId: "submitted", text: "repeat" },
            { entryId: "steering", text: "repeat" },
          ]),
        prompt: vi.fn(() => new Promise((resolve) => { finish = resolve; })),
      } as unknown as AcpClient;
      let activeClient = client;
      const bindPromptSessionEntry = vi.fn();
      const runs = createPromptRunLifecycle({
        client: () => activeClient, activeSessionId: () => "session-1", reportError: vi.fn(),
        bindPromptSessionEntry, finalizeTranscriptActivity: vi.fn(), flushAutoQueue: vi.fn(),
      });
      const pending = runs.runPromptRequest(client, "session-1", [], [], "local:1");
      await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledOnce());
      if (transition === "clear session") runs.clearSession("session-1");
      if (transition === "reset") runs.reset();
      if (transition === "replace client") activeClient = {} as AcpClient;
      finish({ stopReason: "end_turn" });
      await pending;
      if (transition === "current") expect(bindPromptSessionEntry).toHaveBeenCalledWith("session-1", "local:1", "submitted");
      else expect(bindPromptSessionEntry).not.toHaveBeenCalled();
    },
  );

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
