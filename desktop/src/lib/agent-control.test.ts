import { describe, expect, it } from "vitest";
import { agentControlStateFromSessionState, isAgentControlState } from "./agent-control";

describe("Desktop agent control state", () => {
  it("parses pause and continuation states from the private session-state channel", () => {
    expect(agentControlStateFromSessionState({
      sessionId: "session-1",
      channel: "agent-control",
      data: { state: "paused" },
    })).toBe("paused");
    expect(agentControlStateFromSessionState({
      sessionId: "session-1",
      channel: "agent-control",
      data: { state: "continuable" },
    })).toBe("continuable");
  });

  it("rejects malformed or unrelated session state", () => {
    expect(agentControlStateFromSessionState({
      sessionId: "session-1",
      channel: "pi-tools-suite:todo:state",
      data: { state: "paused" },
    })).toBeUndefined();
    expect(agentControlStateFromSessionState({
      sessionId: "session-1",
      channel: "agent-control",
      data: { state: "stopped" },
    })).toBeUndefined();
    expect(isAgentControlState("resuming")).toBe(true);
    expect(isAgentControlState("stopped")).toBe(false);
  });
});
