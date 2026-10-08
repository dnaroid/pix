import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { agentControlAllowsAutoQueue, type AgentControlState } from "../lib/agent-control";
import { createPromptAgentControl } from "./prompt-agent-control.svelte";
import { createPromptRunLifecycle } from "./prompt-run-lifecycle.svelte";

describe("prompt agent control notifications", () => {
  it.each(["resuming", "running"] as const)("adopts %s and enables Pause once the continuation starts", async (initialState) => {
    const agentControl = vi.fn(async (_sessionId: string, action: string) => ({
      sessionId: "session-1", state: action === "cancel-pause" ? "running" as const : "pause-requested" as const,
    }));
    const client = { agentControl } as unknown as AcpClient;
    const flushAutoQueue = vi.fn(async () => {});
    const runs = createPromptRunLifecycle({
      client: () => client, activeSessionId: () => "session-1", reportError: vi.fn(),
      bindPromptSessionEntry: vi.fn(), finalizeTranscriptActivity: vi.fn(), flushAutoQueue,
    });
    const control = createPromptAgentControl({
      client: () => client, activeSessionId: () => "session-1", runtimeReady: () => true,
      operationRunning: () => false, setErrorMessage: vi.fn(), reportError: vi.fn(), runs,
    });
    control.handleAgentControlStatePush("session-1", initialState);
    expect(runs.isRunning("session-1")).toBe(true);
    if (initialState === "resuming") {
      await control.pauseActiveAgent();
      expect(agentControl).not.toHaveBeenCalled();
    }
    control.handleAgentControlStatePush("session-1", "running");
    control.handleAgentControlStatePush("session-1", "running");
    expect(runs.isRunning("session-1")).toBe(true);
    expect(flushAutoQueue).not.toHaveBeenCalled();
    await control.pauseActiveAgent();
    expect(agentControl).toHaveBeenCalledWith("session-1", "pause");
    expect(control.agentState("session-1")).toBe("pause-requested");
    await control.pauseActiveAgent();
    expect(agentControl).toHaveBeenCalledTimes(2);
    expect(agentControl).toHaveBeenLastCalledWith("session-1", "cancel-pause");
    expect(control.agentState("session-1")).toBe("running");
    expect(agentControlAllowsAutoQueue(control.agentState("session-1"))).toBe(false);
    expect(runs.isRunning("session-1")).toBe(true);
    expect(flushAutoQueue).not.toHaveBeenCalled();
    await control.pauseActiveAgent();
    control.handleAgentControlStatePush("session-1", "paused");
    expect(runs.isRunning("session-1")).toBe(false);
    await vi.waitFor(() => expect(flushAutoQueue).toHaveBeenCalledTimes(1));
  });

  it.each(["idle", "continuable"] as const)("settles an adopted recovered-question run at %s", async (state) => {
    const client = {} as AcpClient;
    const flushAutoQueue = vi.fn(async () => {});
    const runs = createPromptRunLifecycle({
      client: () => client, activeSessionId: () => "session-1", reportError: vi.fn(),
      bindPromptSessionEntry: vi.fn(), finalizeTranscriptActivity: vi.fn(), flushAutoQueue,
    });
    const control = createPromptAgentControl({
      client: () => client, activeSessionId: () => "session-1", runtimeReady: () => true,
      operationRunning: () => false, setErrorMessage: vi.fn(), reportError: vi.fn(), runs,
    });
    control.handleAgentControlStatePush("session-1", "running");
    control.handleAgentControlStatePush("session-1", state);
    expect(runs.isRunning("session-1")).toBe(false);
    expect(control.agentState("session-1")).toBe(state);
    await vi.waitFor(() => expect(flushAutoQueue).toHaveBeenCalledTimes(1));
  });

  it("emits pause attention only for a live transition into paused", () => {
    const client = {} as AcpClient;
    const onAgentPaused = vi.fn();
    const runs = createPromptRunLifecycle({
      client: () => client,
      activeSessionId: () => "session-1",
      reportError: vi.fn(),
      bindPromptSessionEntry: vi.fn(),
      finalizeTranscriptActivity: vi.fn(),
      flushAutoQueue: vi.fn(async () => {}),
    });
    const control = createPromptAgentControl({
      client: () => client,
      activeSessionId: () => "session-1",
      runtimeReady: () => true,
      operationRunning: () => false,
      setErrorMessage: vi.fn(),
      reportError: vi.fn(),
      onAgentPaused,
      runs,
    });

    control.setAgentState("session-1", "paused");
    expect(onAgentPaused).not.toHaveBeenCalled();

    control.setAgentState("session-1", "resuming");
    control.setAgentState("session-1", "paused");
    control.setAgentState("session-1", "paused");

    expect(onAgentPaused).toHaveBeenCalledTimes(1);
    expect(onAgentPaused).toHaveBeenCalledWith("session-1");
  });

  it("propagates the settled stop reason after Continue and queue draining", async () => {
    const client = {
      agentControl: vi.fn(async (_sessionId: string, action: string) => action === "continue"
        ? { sessionId: "session-1", state: "idle" as const, stopReason: "end_turn" as const }
        : { sessionId: "session-1", state: "idle" as const }),
    } as unknown as AcpClient;
    const onPromptSettled = vi.fn();
    const runs = createPromptRunLifecycle({
      client: () => client,
      activeSessionId: () => "session-1",
      reportError: vi.fn(),
      bindPromptSessionEntry: vi.fn(),
      finalizeTranscriptActivity: vi.fn(),
      onPromptSettled,
      flushAutoQueue: vi.fn(async () => {}),
    });
    const control = createPromptAgentControl({
      client: () => client,
      activeSessionId: () => "session-1",
      runtimeReady: () => true,
      operationRunning: () => false,
      setErrorMessage: vi.fn(),
      reportError: vi.fn(),
      runs,
    });
    control.setAgentState("session-1", "continuable");

    await control.continueActiveAgent();

    await vi.waitFor(() => expect(onPromptSettled).toHaveBeenCalledTimes(1));
    expect(onPromptSettled).toHaveBeenCalledWith("session-1", "end_turn");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}

function toggleFixture() {
  const reply = deferred<{ sessionId: string; state: AgentControlState }>();
  const agentControl = vi.fn(async (_sessionId: string, action: string) => action === "pause"
    ? reply.promise : { sessionId: "session-1", state: "running" as AgentControlState });
  let client = { agentControl } as unknown as AcpClient;
  const flushAutoQueue = vi.fn(async () => {});
  const reportError = vi.fn();
  const runs = createPromptRunLifecycle({
    client: () => client, activeSessionId: () => "session-1", reportError,
    bindPromptSessionEntry: vi.fn(), finalizeTranscriptActivity: vi.fn(), flushAutoQueue,
  });
  const control = createPromptAgentControl({
    client: () => client, activeSessionId: () => "session-1", runtimeReady: () => true,
    operationRunning: () => false, setErrorMessage: vi.fn(), reportError, runs,
  });
  control.handleAgentControlStatePush("session-1", "running");
  return { control, runs, reply, agentControl, flushAutoQueue, reportError,
    replaceClient() { client = {} as AcpClient; } };
}

describe("pending Pause toggle races", () => {
  it("serializes undo before the first Pause RPC replies, retaining the busy owner", async () => {
    const { control, runs, reply, agentControl, flushAutoQueue } = toggleFixture();
    const generation = runs.generation("session-1");
    const pause = control.pauseActiveAgent();
    const undo = control.pauseActiveAgent();
    expect(agentControl).toHaveBeenCalledTimes(1);
    expect(control.agentState("session-1")).toBe("pause-requested");
    reply.resolve({ sessionId: "session-1", state: "pause-requested" });
    await Promise.all([pause, undo]);
    expect(agentControl.mock.calls.map((call) => call[1])).toEqual(["pause", "cancel-pause"]);
    expect(control.agentState("session-1")).toBe("running");
    expect(runs.generation("session-1")).toBe(generation);
    expect(runs.isRunning("session-1")).toBe(true);
    expect(flushAutoQueue).not.toHaveBeenCalled();
  });

  it("serializes three clicks into pause, cancel, pause", async () => {
    const { control, reply, agentControl } = toggleFixture();
    const clicks = [control.pauseActiveAgent(), control.pauseActiveAgent(), control.pauseActiveAgent()];
    reply.resolve({ sessionId: "session-1", state: "pause-requested" });
    await Promise.all(clicks);
    expect(agentControl.mock.calls.map((call) => call[1])).toEqual(["pause", "cancel-pause", "pause"]);
    expect(control.agentState("session-1")).toBe("pause-requested");
  });

  it("does not undo a paused push or dispatch queued undo after settlement", async () => {
    const { control, reply, agentControl } = toggleFixture();
    const pause = control.pauseActiveAgent();
    const undo = control.pauseActiveAgent();
    control.handleAgentControlStatePush("session-1", "paused");
    reply.resolve({ sessionId: "session-1", state: "pause-requested" });
    await Promise.all([pause, undo]);
    expect(control.agentState("session-1")).toBe("paused");
    expect(agentControl).toHaveBeenCalledTimes(1);
  });

  it("keeps a paused push authoritative over an in-flight cancel response", async () => {
    const { control, reply, agentControl } = toggleFixture();
    const pause = control.pauseActiveAgent();
    reply.resolve({ sessionId: "session-1", state: "pause-requested" });
    await pause;
    const cancelled = deferred<{ sessionId: string; state: AgentControlState }>();
    agentControl.mockImplementationOnce(() => cancelled.promise);
    const undo = control.pauseActiveAgent();
    control.handleAgentControlStatePush("session-1", "paused");
    cancelled.resolve({ sessionId: "session-1", state: "running" });
    await undo;
    expect(control.agentState("session-1")).toBe("paused");
  });

  it.each(["clear", "reset", "client", "run"] as const)("discards queued clicks and replies after %s replacement", async (replacement) => {
    const fixture = toggleFixture();
    const { control, runs, reply, agentControl } = fixture;
    const pause = control.pauseActiveAgent();
    const undo = control.pauseActiveAgent();
    if (replacement === "clear") { control.clearSession("session-1"); runs.clearSession("session-1"); }
    if (replacement === "reset") { control.reset(); runs.reset(); }
    if (replacement === "client") fixture.replaceClient();
    runs.beginRun("session-1");
    control.setAgentState("session-1", "running");
    reply.resolve({ sessionId: "session-1", state: "pause-requested" });
    await Promise.all([pause, undo]);
    expect(control.agentState("session-1")).toBe("running");
    expect(runs.isRunning("session-1")).toBe(true);
    expect(agentControl).toHaveBeenCalledTimes(1);
  });

  it("keeps pending state and busy ownership when cancellation and recovery query fail", async () => {
    const { control, runs, reply, agentControl, reportError, flushAutoQueue } = toggleFixture();
    const pause = control.pauseActiveAgent();
    reply.resolve({ sessionId: "session-1", state: "pause-requested" });
    await pause;
    agentControl.mockRejectedValue(new Error("unavailable"));
    await control.pauseActiveAgent();
    expect(agentControl.mock.calls.map((call) => call[1])).toEqual(["pause", "cancel-pause", "state"]);
    expect(control.agentState("session-1")).toBe("pause-requested");
    expect(runs.isRunning("session-1")).toBe(true);
    expect(flushAutoQueue).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
  });
});
