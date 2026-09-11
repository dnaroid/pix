import { describe, expect, it } from "vitest";
import type { ListSessionsResponse, SessionInfo } from "@agentclientprotocol/sdk";
import {
  buildTabSessions,
  mergeRestoredSessionTabs,
  parseActiveSessionIds,
  replaceSessionTab,
  restoredTabSessionIds,
  sessionTabFocusIndex,
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

describe("sessionTabFocusIndex", () => {
  it("wraps horizontal arrow navigation without activating tabs", () => {
    expect(sessionTabFocusIndex(0, "ArrowRight", 3)).toBe(1);
    expect(sessionTabFocusIndex(2, "ArrowRight", 3)).toBe(0);
    expect(sessionTabFocusIndex(0, "ArrowLeft", 3)).toBe(2);
  });

  it("supports Home/End and ignores unrelated keys", () => {
    expect(sessionTabFocusIndex(1, "Home", 3)).toBe(0);
    expect(sessionTabFocusIndex(1, "End", 3)).toBe(2);
    expect(sessionTabFocusIndex(1, "Enter", 3)).toBeNull();
  });
});

describe("replaceSessionTab", () => {
  it("replaces the current restored tab instead of appending another tab", () => {
    const state = replaceSessionTab(["a", "b", "c"], [], [], "b", "history");
    expect(state).toEqual({
      restoredIds: ["a", "history", "c"],
      locallyOpenedIds: ["history"],
      closedIds: ["b"],
    });
  });

  it("collapses the source tab when the target is already open", () => {
    const state = replaceSessionTab(["a", "b", "target"], ["local"], ["target"], "b", "target");
    expect(state).toEqual({
      restoredIds: ["a", "target"],
      locallyOpenedIds: ["local"],
      closedIds: ["b"],
    });
  });

  it("keeps legacy all-session adapters working by hiding only the replaced source", () => {
    expect(replaceSessionTab(null, [], [], "a", "b")).toEqual({
      restoredIds: null,
      locallyOpenedIds: [],
      closedIds: ["a"],
    });
  });

  it("opens the target persistently when there is no current tab to replace", () => {
    expect(replaceSessionTab(["a"], [], ["history"], null, "history")).toEqual({
      restoredIds: ["a"],
      locallyOpenedIds: ["history"],
      closedIds: [],
    });
  });
});

describe("mergeRestoredSessionTabs", () => {
  it("keeps a Desktop replacement in the original slot across backend refreshes", () => {
    expect(mergeRestoredSessionTabs(
      ["a", "history", "c"],
      ["a", "source", "c"],
      ["history"],
      ["source"],
    )).toEqual(["a", "history", "c"]);
  });

  it("drops TUI tabs that disappeared and appends newly opened TUI tabs", () => {
    expect(mergeRestoredSessionTabs(["a", "b"], ["a", "c"], [], [])).toEqual(["a", "c"]);
  });
});
