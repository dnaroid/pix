import { describe, expect, it } from "vitest";
import type { SessionStateNotification } from "./session-state";
import {
  formatSessionSubagentElapsed,
  sessionSubagentCount,
  sessionSubagentModelLabel,
  sessionSubagentRunName,
  sessionSubagentSnapshot,
  sessionSubagentTaskPreview,
  updateSessionSubagentSnapshots,
  visibleSessionSubagentRuns,
  type SessionSubagentSnapshot,
} from "./session-subagents";

function snapshot(
  runs: SessionSubagentSnapshot["runs"],
  checkedAt = Date.parse("2026-01-01T00:01:05Z"),
): SessionSubagentSnapshot {
  const count = runs.flatMap((run) => run.agents)
    .filter((agent) => agent.status === "planned" || agent.status === "running" || agent.status === "retrying")
    .length;
  return { version: 1, count, runs, checkedAt };
}

function notification(data: unknown, channel = "pi-tools-suite:async-subagents:live-state"): SessionStateNotification {
  return { sessionId: "acp-1", channel, data };
}

describe("desktop session subagents", () => {
  it("validates the channel and versioned live-state snapshot", () => {
    const valid = snapshot([{
      runDir: "/work/.pi/subagents/review-run",
      agents: [{ id: "review", status: "running", pid: 42 }],
      tasks: [{ id: "review", task: "Review transport", model: "openai/gpt-5" }],
    }]);
    expect(sessionSubagentSnapshot(notification(valid))).toEqual(valid);
    expect(sessionSubagentSnapshot(notification(valid, "other"))).toBeUndefined();
    expect(sessionSubagentSnapshot(notification({ ...valid, version: 2 }))).toBeUndefined();
    expect(sessionSubagentSnapshot(notification({ ...valid, count: 2 }))).toBeUndefined();
    expect(sessionSubagentSnapshot(notification({ ...valid, checkedAt: Number.NaN }))).toBeUndefined();
    expect(sessionSubagentSnapshot(notification(snapshot([
      { runDir: "/run", agents: [{ id: "same", status: "running" }, { id: "same", status: "planned" }] },
    ])))).toBeUndefined();
    expect(sessionSubagentSnapshot(notification(snapshot([
      { runDir: "/run", agents: [{ id: "agent", status: "running" }], tasks: [{ id: "agent" }, { id: "agent" }] },
    ])))).toBeUndefined();
  });

  it("keeps active agents grouped by run and permits reused ids across runs", () => {
    const state = snapshot([
      {
        runDir: "/work/first-run",
        agents: [
          { id: "agent-1", status: "running", startedAt: "2026-01-01T00:00:00Z" },
          { id: "done", status: "done" },
        ],
        tasks: [{ id: "agent-1", task: "Inspect API", model: "provider/model-a" }],
      },
      { runDir: "C:\\work\\second-run", agents: [{ id: "agent-1", status: "retrying", retryCount: 1 }] },
    ]);
    const runs = visibleSessionSubagentRuns(state);
    expect(runs.map((run) => [run.runDir, run.agents.map((agent) => agent.id)])).toEqual([
      ["/work/first-run", ["agent-1"]],
      ["C:\\work\\second-run", ["agent-1"]],
    ]);
    expect(sessionSubagentCount(state)).toBe(2);
    expect(sessionSubagentRunName(runs[0]!.runDir)).toBe("first-run");
    expect(sessionSubagentRunName(runs[1]!.runDir)).toBe("second-run");
    const preview = sessionSubagentTaskPreview(runs[0]!, "agent-1");
    expect(preview?.task).toBe("Inspect API");
    expect(sessionSubagentModelLabel(preview)).toBe("model-a");
  });

  it("formats queued, seconds, minutes, hours, and invalid elapsed states", () => {
    const now = Date.parse("2026-01-01T02:03:05Z");
    expect(formatSessionSubagentElapsed(undefined, now)).toBe("queued");
    expect(formatSessionSubagentElapsed("invalid", now)).toBe("elapsed unknown");
    expect(formatSessionSubagentElapsed("2026-01-01T02:02:30Z", now)).toBe("35s");
    expect(formatSessionSubagentElapsed("2026-01-01T02:01:30Z", now)).toBe("1m35s");
    expect(formatSessionSubagentElapsed("2025-12-31T23:59:00Z", now)).toBe("2h04m");
  });

  it("keeps the newest snapshot independently for each ACP session", () => {
    const newer = snapshot([{ runDir: "/new", agents: [{ id: "new", status: "running" }] }], 20);
    const older = snapshot([{ runDir: "/old", agents: [{ id: "old", status: "planned" }] }], 10);
    let states = updateSessionSubagentSnapshots(new Map(), "acp-1", newer);
    states = updateSessionSubagentSnapshots(states, "acp-1", older);
    states = updateSessionSubagentSnapshots(states, "acp-2", older);
    expect(states.get("acp-1")?.runs[0]?.runDir).toBe("/new");
    expect(states.get("acp-2")?.runs[0]?.runDir).toBe("/old");
  });
});
