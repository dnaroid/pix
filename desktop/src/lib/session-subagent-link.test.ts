import { describe, expect, it } from "vitest";
import { isSubagentSession, parseSubagentSessionState, subagentSessionLink } from "./session-subagent-link";

describe("sub-agent viewer link", () => {
  it("parses protocol metadata and rejects malformed links", () => {
    expect(subagentSessionLink({ "pix.subagent": { runDir: "/r", agentId: "a", parentSessionId: "p" } }))
      .toEqual({ runDir: "/r", agentId: "a", parentSessionId: "p" });
    expect(subagentSessionLink({ "pix.subagent": { runDir: "/r", agentId: "a" } })).toEqual({ runDir: "/r", agentId: "a" });
    expect(subagentSessionLink({ "pix.subagent": { runDir: "", agentId: "a" } })).toBeUndefined();
    expect(subagentSessionLink({ "pix.subagent": { runDir: "/r", agentId: "a", parentSessionId: 3 } })).toBeUndefined();
    expect(subagentSessionLink({ "pix.brainstorm": {} })).toBeUndefined();
    expect(subagentSessionLink(undefined)).toBeUndefined();
  });

  it("identifies sub-agent viewer sessions for picker filtering", () => {
    expect(isSubagentSession({ _meta: { "pix.subagent": { runDir: "/r", agentId: "a" } } })).toBe(true);
    expect(isSubagentSession({ _meta: { "pix.sessionFile": "/s.jsonl" } })).toBe(false);
    expect(isSubagentSession({})).toBe(false);
  });

  it("validates session state responses", () => {
    expect(parseSubagentSessionState({ terminal: true, revision: "1:2" }, "m")).toEqual({ terminal: true, revision: "1:2" });
    expect(() => parseSubagentSessionState({ terminal: "yes", revision: "1" }, "m")).toThrow(/invalid/);
    expect(parseSubagentSessionState({
      terminal: false, revision: "1",
      model: { provider: "openai", modelId: "gpt", name: "GPT", thinking: "high" },
      context: { tokens: 500, contextWindow: 1000, percent: 50 },
    }, "m")).toEqual({
      terminal: false, revision: "1",
      model: { provider: "openai", modelId: "gpt", name: "GPT", thinking: "high" },
      context: { tokens: 500, contextWindow: 1000, percent: 50 },
    });
    expect(parseSubagentSessionState({
      terminal: false, revision: "1", model: { provider: "", modelId: "x", name: "x" }, context: { tokens: null, contextWindow: 0, percent: null },
    }, "m")).toEqual({ terminal: false, revision: "1" });
  });

  it("validates private plans and provider quota without accepting a false ready state", () => {
    const todo = { version: 1, checkedAt: 1, details: { action: "create", params: {}, nextId: 2,
      tasks: [{ id: 1, subject: "Child plan", status: "in_progress" }] } };
    const modelUsage = { modelKey: "zai/glm", provider: "zhipu", updatedAt: 1,
      hourly: { remainingPercent: 80, resetAt: 1000, windowSeconds: 3600 } };
    const state = { terminal: false, revision: "1", todo, modelUsageRefresh: "ready", modelUsage };
    expect(parseSubagentSessionState(state, "m")).toEqual(state);
    expect(parseSubagentSessionState({ terminal: false, revision: "1", todo: { bad: true } }, "m")).not.toHaveProperty("todo");
    expect(() => parseSubagentSessionState({ ...state, modelUsage: undefined }, "m")).toThrow(/ready without/);
    expect(() => parseSubagentSessionState({ ...state, modelUsageRefresh: "skipped" }, "m")).toThrow(/supporting refresh/);
  });
});
