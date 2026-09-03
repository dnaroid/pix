import { describe, expect, it } from "vitest";
import type { ListSessionsResponse, SessionInfo } from "@agentclientprotocol/sdk";
import { buildTabSessions, restoredTabSessionIds } from "./session-tabs";

function session(sessionId: string): SessionInfo {
  return { sessionId, cwd: "/tmp/project", title: sessionId };
}

describe("restoredTabSessionIds", () => {
  it("reads ordered, deduplicated ids from Pix metadata", () => {
    const response: ListSessionsResponse = {
      sessions: [],
      _meta: { "pix.tabs": { sessionIds: ["b", "a", "b", 42] } },
    };
    expect(restoredTabSessionIds(response)).toEqual(["b", "a"]);
  });

  it("returns null when talking to an adapter without Pix tab metadata", () => {
    expect(restoredTabSessionIds({ sessions: [] })).toBeNull();
  });
});

describe("buildTabSessions", () => {
  const sessions = [session("a"), session("b"), session("c"), session("d")];

  it("keeps TUI order, then local tabs and the active session", () => {
    expect(buildTabSessions(sessions, ["c", "a"], ["d"], [], "b").map((item) => item.sessionId))
      .toEqual(["c", "a", "d", "b"]);
  });

  it("hides closed and unknown tabs without affecting the all-session input", () => {
    expect(buildTabSessions(sessions, ["missing", "a", "b"], [], ["a"], null).map((item) => item.sessionId))
      .toEqual(["b"]);
    expect(sessions).toHaveLength(4);
  });

  it("falls back to all sessions for an older adapter", () => {
    expect(buildTabSessions(sessions, null, [], [], null)).toEqual(sessions);
  });
});
