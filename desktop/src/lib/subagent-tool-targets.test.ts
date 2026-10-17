import { describe, expect, it } from "vitest";
import { subagentToolTargets } from "./subagent-tool-targets";

const base = { kind: "other", name: "subagents", title: "subagents", status: "completed" as const };

describe("subagentToolTargets", () => {
  it("reads spawn/status details with agent arrays", () => {
    expect(subagentToolTargets({
      ...base,
      rawOutput: { runDir: "/p/.pi/subagents/run", agents: [{ id: "a" }, { id: "b" }, { id: "a" }], mode: "spawn" },
    })).toEqual([
      { runDir: "/p/.pi/subagents/run", agentId: "a" },
      { runDir: "/p/.pi/subagents/run", agentId: "b" },
    ]);
  });

  it("reads send/result details with a single agentId", () => {
    expect(subagentToolTargets({ ...base, rawOutput: { runDir: "/r", agentId: "x", delivery: "resume" } }))
      .toEqual([{ runDir: "/r", agentId: "x" }]);
  });

  it("ignores other tools, unfinished calls and malformed details", () => {
    expect(subagentToolTargets({ ...base, name: "read", rawOutput: { runDir: "/r", agentId: "x" } })).toEqual([]);
    expect(subagentToolTargets({ ...base, status: "in_progress", rawOutput: { runDir: "/r", agentId: "x" } })).toEqual([]);
    expect(subagentToolTargets({ ...base, rawOutput: { agents: [{ id: "a" }] } })).toEqual([]);
    expect(subagentToolTargets({ ...base, rawOutput: "Scheduled 1 agent(s) in /r" })).toEqual([]);
    expect(subagentToolTargets({ ...base, rawOutput: { runDir: "/r", agents: [{ id: 3 }, null] } })).toEqual([]);
  });

  it("caps the number of targets", () => {
    const agents = Array.from({ length: 30 }, (_, index) => ({ id: `a${index}` }));
    expect(subagentToolTargets({ ...base, rawOutput: { runDir: "/r", agents } })).toHaveLength(12);
  });
});
