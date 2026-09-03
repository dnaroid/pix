import { describe, expect, it } from "vitest";
import type { ListSessionsResponse, SessionInfo } from "@agentclientprotocol/sdk";
import {
  buildTabSessions,
  parseActiveSessionIds,
  restoredTabSessionIds,
  serializeActiveSessionIds,
  startupSessionId,
} from "./session-tabs";

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

describe("startupSessionId", () => {
  const sessions = [session("desktop"), session("tui")];

  it("prefers the desktop session that was active when the app closed", () => {
    const response: ListSessionsResponse = {
      sessions,
      _meta: { "pix.tabs": { sessionIds: ["tui"], activeSessionId: "tui" } },
    };
    expect(startupSessionId(response, "desktop")).toBe("desktop");
  });

  it("falls back to the TUI active tab when desktop state is unavailable", () => {
    const response: ListSessionsResponse = {
      sessions,
      _meta: { "pix.tabs": { sessionIds: ["tui"], activeSessionId: "tui" } },
    };
    expect(startupSessionId(response, "missing")).toBe("tui");
  });

  it("requests a new session when no saved active session exists", () => {
    expect(startupSessionId({
      sessions,
      _meta: { "pix.tabs": { sessionIds: ["tui"], activeSessionId: "missing" } },
    }, null)).toBeNull();
  });
});

describe("active desktop session storage", () => {
  it("round-trips project-scoped active sessions", () => {
    const sessions = new Map([["/projects/a", "a"], ["/projects/b", "b"]]);
    expect(parseActiveSessionIds(serializeActiveSessionIds(sessions))).toEqual(sessions);
  });

  it("ignores malformed storage values", () => {
    expect(parseActiveSessionIds("not json")).toEqual(new Map());
    expect(parseActiveSessionIds(JSON.stringify({ "/projects/a": 42, "/projects/b": "b" })))
      .toEqual(new Map([["/projects/b", "b"]]));
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
