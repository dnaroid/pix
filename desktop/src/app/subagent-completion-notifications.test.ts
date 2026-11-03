import type { StopReason } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { AcpClient } from "../lib/acp-client";
import {
  agentControlStateFromSessionState,
  agentControlStopReasonFromSessionState,
  type AgentControlState,
} from "../lib/agent-control";
import { createDesktopAgentNotificationCoordinator, createDesktopNotificationService } from "../lib/desktop-notifications";
import { createPromptAgentControl } from "./prompt-agent-control.svelte";
import { createPromptRunLifecycle } from "./prompt-run-lifecycle.svelte";
import { createSessionActivityStore } from "./session-activity.svelte";

describe("subagent completion notification lifecycle", () => {
  const cases = (["end_turn", "cancelled", "refusal", "local-cancel"] as const)
    .flatMap((outcome) => (["snapshot-first", "idle-first"] as const)
      .flatMap((order) => (["before-running", "after-running"] as const)
        .map((pendingSnapshot) => ({ outcome, order, pendingSnapshot }))));
  it.each(cases)("waits for $outcome with $order and pending snapshot $pendingSnapshot", async ({ outcome, order, pendingSnapshot }) => {
    const stopReason = outcome === "local-cancel" ? "end_turn" : outcome;
    const cancelled = outcome === "cancelled" || outcome === "local-cancel";
    const sessionId = "parent";
    const playPixSound = vi.fn(async () => {});
    const service = createDesktopNotificationService({
      isForeground: () => false,
      preferences: async () => ({ notificationsEnabled: true, soundOnlyEnabled: true }),
      playPixSound,
    });
    const completed = vi.spyOn(service, "completed");
    const error = vi.spyOn(service, "error");
    const activity = createSessionActivityStore({ onChange: (id) => {
      control.handleSessionActivityChanged(id);
      notifications.sessionActivityChanged(id);
    } });
    const activityOwner = activity.open(sessionId);
    const client = { cancel: vi.fn(async () => {}) } as unknown as AcpClient;
    const runs = createPromptRunLifecycle({
      client: () => client, activeSessionId: () => sessionId, reportError: vi.fn(),
      bindPromptSessionEntry: vi.fn(), finalizeTranscriptActivity: vi.fn(),
      flushAutoQueue: async () => {},
      onPromptStarted: (id) => notifications.promptStarted(id),
      onPromptSettled: (id, reason) => notifications.promptSettled(id, reason),
    });
    const control = createPromptAgentControl({
      client: () => client, activeSessionId: () => sessionId, runtimeReady: () => true,
      operationRunning: () => false, setErrorMessage: vi.fn(), reportError: vi.fn(), runs,
      shouldNotifyExtensionRun: (id) => activity.subagents.get(id)?.completionPending === true,
    });
    const notifications = createDesktopAgentNotificationCoordinator({
      notifications: service, sessionTitle: () => "Parent task",
      agentState: control.agentState, isPromptRunning: runs.isRunning,
      activeSubagents: (id) => activity.summaries.get(id)?.activeSubagents ?? 0,
      subagentCompletionPending: (id) => activity.subagents.get(id)?.completionPending === true,
    });
    let checkedAt = 0;
    function snapshot(count: number, completionPending: boolean) {
      activity.handle({ sessionId, activityOwner, channel: "pi-tools-suite:async-subagents:live-state",
        data: { version: 1, count, completionPending, checkedAt: ++checkedAt,
          runs: count ? [{ runDir: "/run", agents: [{ id: "child", status: "running" }] }] : [] } });
    }
    function push(state: AgentControlState, reason?: StopReason) {
      const notification = { sessionId, channel: "agent-control", data: { state, stopReason: reason } };
      control.handleAgentControlStatePush(sessionId, agentControlStateFromSessionState(notification)!,
        agentControlStopReasonFromSessionState(notification));
    }

    const generation = runs.beginRun(sessionId);
    snapshot(1, pendingSnapshot === "before-running");
    runs.finishRunAndFlush(sessionId, generation, "end_turn");
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    if (pendingSnapshot === "before-running") {
      snapshot(0, true); // Child done, automatic parent continuation still queued.
    }
    notifications.sessionActivityChanged(sessionId);
    expect(completed).not.toHaveBeenCalled();
    expect(playPixSound).not.toHaveBeenCalled();

    push("running");
    snapshot(0, true);
    expect(completed).not.toHaveBeenCalled();
    if (outcome === "local-cancel") await runs.cancelActivePrompt();
    if (order === "snapshot-first") snapshot(0, false);
    expect(completed).not.toHaveBeenCalled();
    push("idle", stopReason);
    await vi.waitFor(() => expect(runs.isRunning(sessionId)).toBe(false));
    await Promise.resolve();
    await Promise.resolve();
    notifications.sessionActivityChanged(sessionId);
    if (order === "idle-first") {
      expect(completed).not.toHaveBeenCalled();
      snapshot(0, false); // Its onChange must release the deferred completion.
    }
    push("idle", stopReason); // Duplicate push must not notify twice.
    if (cancelled) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(completed).toHaveBeenCalledTimes(!cancelled && stopReason === "end_turn" ? 1 : 0);
    expect(error).toHaveBeenCalledTimes(stopReason === "refusal" ? 1 : 0);
    await vi.waitFor(() => expect(playPixSound).toHaveBeenCalledTimes(cancelled ? 0 : 1));
    service.dispose();
  });
});
