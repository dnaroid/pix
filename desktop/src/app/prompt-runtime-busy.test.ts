import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createPromptRuntime } from "./prompt-runtime.svelte";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const reply = deferred<{ stopReason: "end_turn" }>();
  const client = {
    prompt: vi.fn(() => reply.promise),
    cancel: vi.fn().mockResolvedValue(undefined),
    takeAutoMessage: vi.fn().mockResolvedValue(undefined),
  } as unknown as AcpClient;
  const finalizeTranscriptActivity = vi.fn();
  const onPromptSettled = vi.fn();
  const runtime = createPromptRuntime({
    client: () => client, activeSessionId: () => "source", runtimeReady: () => true,
    operationRunning: () => false, sessionHistoryLoading: () => false,
    setErrorMessage: vi.fn(), reportError: vi.fn(), appendQueuedMessage: vi.fn(),
    bindPromptSessionEntry: vi.fn(), finalizeTranscriptActivity, onPromptSettled,
  });
  return { client, reply, runtime, finalizeTranscriptActivity, onPromptSettled };
}

describe("server busy ownership across prompt responses", () => {
  it.each(["running", "resuming", "pause-requested"] as const)(
    "retains Stop when %s arrives before the previous prompt response",
    async (state) => {
      const { client, reply, runtime, finalizeTranscriptActivity, onPromptSettled } = fixture();
      const pending = runtime.runPromptRequest(client, "source", []);
      await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledOnce());
      runtime.handleAgentControlStatePush("source", "idle");
      // A todo nudge/extension starts after ACP settlement, before its old
      // prompt response (or Desktop's transcript metadata) finishes.
      runtime.handleAgentControlStatePush("source", state);
      reply.resolve({ stopReason: "end_turn" });
      await pending;

      expect(runtime.hasPromptRun("source")).toBe(false);
      expect(runtime.isRunning("source")).toBe(true);
      expect(finalizeTranscriptActivity).not.toHaveBeenCalled();
      expect(onPromptSettled).not.toHaveBeenCalled();
      expect(client.takeAutoMessage).not.toHaveBeenCalled();
      await runtime.cancelActivePrompt();
      expect(client.cancel).toHaveBeenCalledExactlyOnceWith("source");
      runtime.handleAgentControlStatePush("source", "idle");
      expect(runtime.isRunning("source")).toBe(false);
    },
  );

  it("retains the authoritative busy owner after a rejected overlapping send", async () => {
    const { client, reply, runtime } = fixture();
    const pending = runtime.runPromptRequest(client, "source", []);
    const rejected = expect(pending).rejects.toThrow("already in progress");
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledOnce());
    runtime.handleAgentControlStatePush("source", "running");
    reply.reject(new Error("a prompt is already in progress for this session"));
    await rejected;
    expect(runtime.isRunning("source")).toBe(true);
    await runtime.cancelActivePrompt();
    expect(client.cancel).toHaveBeenCalledExactlyOnceWith("source");
  });

  it("does not retain a run that has already settled before the response", async () => {
    const { client, reply, runtime } = fixture();
    const pending = runtime.runPromptRequest(client, "source", []);
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledOnce());
    runtime.handleAgentControlStatePush("source", "running");
    runtime.handleAgentControlStatePush("source", "idle");
    reply.resolve({ stopReason: "end_turn" });
    await pending;
    expect(runtime.isRunning("source")).toBe(false);
  });

  it("retains a restart during post-prompt transcript metadata", async () => {
    const { client, reply, runtime, finalizeTranscriptActivity } = fixture();
    const snapshot = deferred<[]>();
    client.branchUserMessages = vi.fn().mockResolvedValueOnce([]).mockReturnValueOnce(snapshot.promise);
    const pending = runtime.runPromptRequestWithResult(client, "source", [], "local:1");
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledOnce());
    reply.resolve({ stopReason: "end_turn" });
    await vi.waitFor(() => expect(client.branchUserMessages).toHaveBeenCalledTimes(2));
    runtime.handleAgentControlStatePush("source", "running");
    snapshot.resolve([]);
    const completion = await pending;
    expect(completion?.isCurrent()).toBe(false);
    expect(runtime.isRunning("source")).toBe(true);
    expect(finalizeTranscriptActivity).not.toHaveBeenCalled();
    runtime.handleAgentControlStatePush("source", "idle");
    expect(runtime.isRunning("source")).toBe(false);
    expect(finalizeTranscriptActivity).toHaveBeenCalledOnce();
  });

  it("retains a newer busy push over the old Continue response", async () => {
    const { client, runtime, finalizeTranscriptActivity, onPromptSettled } = fixture();
    const reply = deferred<{ sessionId: string; state: "idle"; stopReason: "end_turn" }>();
    client.agentControl = vi.fn(() => reply.promise);
    runtime.setAgentState("source", "continuable");
    const pending = runtime.continueActiveAgent();
    runtime.handleAgentControlStatePush("source", "idle");
    runtime.handleAgentControlStatePush("source", "running");
    reply.resolve({ sessionId: "source", state: "idle", stopReason: "end_turn" });
    await pending;
    expect(runtime.agentState("source")).toBe("running");
    expect(runtime.isRunning("source")).toBe(true);
    expect(finalizeTranscriptActivity).not.toHaveBeenCalled();
    expect(onPromptSettled).not.toHaveBeenCalled();
    expect(client.takeAutoMessage).not.toHaveBeenCalled();
    await runtime.cancelActivePrompt();
    expect(client.cancel).toHaveBeenCalledExactlyOnceWith("source");
    runtime.handleAgentControlStatePush("source", "idle");
    expect(runtime.isRunning("source")).toBe(false);
  });

  it("does not lose a known busy push when Continue and its recovery query fail", async () => {
    const { client, runtime } = fixture();
    const reply = deferred<{ sessionId: string; state: "idle" }>();
    client.agentControl = vi.fn().mockReturnValueOnce(reply.promise).mockRejectedValue(new Error("offline"));
    runtime.setAgentState("source", "continuable");
    const pending = runtime.continueActiveAgent();
    runtime.handleAgentControlStatePush("source", "running");
    reply.reject(new Error("failed continue"));
    await pending;
    expect(runtime.agentState("source")).toBe("running");
    expect(runtime.isRunning("source")).toBe(true);
    await runtime.cancelActivePrompt();
    expect(client.cancel).toHaveBeenCalledExactlyOnceWith("source");
  });

  it("does not let a stale Continue recovery query erase a newer push", async () => {
    const { client, runtime } = fixture();
    const reply = deferred<{ sessionId: string; state: "idle" }>();
    client.agentControl = vi.fn().mockRejectedValueOnce(new Error("failed continue")).mockReturnValueOnce(reply.promise);
    runtime.setAgentState("source", "continuable");
    const pending = runtime.continueActiveAgent();
    await vi.waitFor(() => expect(client.agentControl).toHaveBeenCalledTimes(2));
    runtime.handleAgentControlStatePush("source", "running");
    reply.resolve({ sessionId: "source", state: "idle" });
    await pending;
    expect(runtime.agentState("source")).toBe("running");
    expect(runtime.isRunning("source")).toBe(true);
  });

  it.each(["clear", "reset"] as const)("ignores an old prompt response after %s and a new run", async (transition) => {
    const { client, reply, runtime } = fixture();
    const pending = runtime.runPromptRequest(client, "source", []);
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledOnce());
    if (transition === "clear") runtime.clearSession("source");
    else runtime.reset();
    runtime.handleAgentControlStatePush("source", "running");
    reply.resolve({ stopReason: "end_turn" });
    await pending;
    expect(runtime.isRunning("source")).toBe(true);
    runtime.handleAgentControlStatePush("source", "idle");
    expect(runtime.isRunning("source")).toBe(false);
  });
});
