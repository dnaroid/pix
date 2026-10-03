import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import { createPromptAgentControl } from "./prompt-agent-control.svelte";
import { createPromptRunLifecycle } from "./prompt-run-lifecycle.svelte";

describe("prompt agent control notifications", () => {
  it.each(["resuming", "running"] as const)("adopts %s and enables Pause once the continuation starts", async (initialState) => {
    const agentControl = vi.fn(async () => ({ sessionId: "session-1", state: "pause-requested" as const }));
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
    expect(agentControl).toHaveBeenCalledTimes(1);
    expect(runs.isRunning("session-1")).toBe(true);
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
