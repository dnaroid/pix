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
});

