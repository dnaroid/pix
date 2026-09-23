import { describe, expect, it } from "vitest";
import type { ListSessionsResponse, SessionInfo } from "@agentclientprotocol/sdk";
import {
  buildTabSessions,
  buildSessionTree,
  mergeRestoredSessionTabs,
  parseActiveSessionIds,
  parseSessionTabIds,
  replaceSessionTab,
  restoreDesktopSessionTabs,
  restoredTabSessionIds,
  sessionIsFork,
  serializeActiveSessionIds,
  serializeSessionTabIds,
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

describe("sessionIsFork", () => {
  it("reads the Pix fork marker from session-list metadata", () => {
    expect(sessionIsFork({ sessionId: "fork", cwd: "/tmp/project", _meta: { "pix.isFork": true } })).toBe(true);
    expect(sessionIsFork({ sessionId: "regular", cwd: "/tmp/project" })).toBe(false);
  });
});

describe("buildSessionTree", () => {
  const treeSession = (sessionId: string, updatedAt: string, parentSessionId?: unknown): SessionInfo => ({
    ...session(sessionId),
    updatedAt,
    ...(parentSessionId === undefined ? {} : { _meta: { "pix.parentSessionId": parentSessionId } }),
  });

  it("sorts roots and siblings by descending activity and places children after their parent", () => {
    const rows = buildSessionTree([
      treeSession("older-root", "2025-01-01T00:00:00.000Z"),
      treeSession("older-child", "2025-01-03T00:00:00.000Z", "older-root"),
      treeSession("newer-child", "2025-01-04T00:00:00.000Z", "older-root"),
      treeSession("newer-root", "2025-01-02T00:00:00.000Z"),
    ]);
    expect(rows.map((row) => [row.session.sessionId, row.treePrefix])).toEqual([
      ["newer-root", ""],
      ["older-root", ""],
      ["newer-child", "   ├─"],
      ["older-child", "   └─"],
    ]);
  });

  it("draws continuation columns for arbitrarily nested forks", () => {
    const rows = buildSessionTree([
      treeSession("root", "2025-01-01T00:00:00.000Z"),
      treeSession("first", "2025-01-03T00:00:00.000Z", "root"),
      treeSession("second", "2025-01-02T00:00:00.000Z", "root"),
      treeSession("nested", "2025-01-04T00:00:00.000Z", "first"),
      treeSession("deep", "2025-01-05T00:00:00.000Z", "nested"),
    ]);
    expect(rows.map((row) => [row.session.sessionId, row.treePrefix])).toEqual([
      ["root", ""],
      ["first", "   ├─"],
      ["nested", "   │  └─"],
      ["deep", "   │     └─"],
      ["second", "   └─"],
    ]);
  });

  it("keeps orphaned, malformed and cyclic parent metadata visible as roots", () => {
    const rows = buildSessionTree([
      treeSession("orphan", "2025-01-04T00:00:00.000Z", "missing"),
      treeSession("malformed", "2025-01-03T00:00:00.000Z", 42),
      treeSession("cycle-a", "2025-01-02T00:00:00.000Z", "cycle-b"),
      treeSession("cycle-b", "2025-01-01T00:00:00.000Z", "cycle-a"),
    ]);
    expect(rows.map((row) => row.session.sessionId)).toEqual(["orphan", "malformed", "cycle-a", "cycle-b"]);
    expect(rows.map((row) => row.treePrefix)).toEqual(["", "", "", "   └─"]);
  });
});

describe("startupSessionId", () => {
  const sessions = [session("desktop"), session("tui")];

  it("prefers the desktop session that was active when the app closed and is still open", () => {
    const response: ListSessionsResponse = {
      sessions,
      _meta: { "pix.tabs": { sessionIds: ["tui"], activeSessionId: "tui" } },
    };
    expect(startupSessionId(response, "desktop", ["desktop"])).toBe("desktop");
  });

  it("does not fall back to the TUI active tab when the Desktop snapshot is missing", () => {
    const response: ListSessionsResponse = {
      sessions,
      _meta: { "pix.tabs": { sessionIds: ["tui"], activeSessionId: "tui" } },
    };
    expect(startupSessionId(response, "missing", null)).toBeNull();
  });

  it("requests a new session when no saved active session exists", () => {
    expect(startupSessionId({
      sessions,
      _meta: { "pix.tabs": { sessionIds: ["tui"], activeSessionId: "missing" } },
    }, null, null)).toBeNull();
  });

  it("uses the Desktop tab snapshot to reject a stale active session and stale TUI tabs", () => {
    const response: ListSessionsResponse = {
      sessions: [session("closed"), session("open")],
      _meta: { "pix.tabs": { sessionIds: ["closed"], activeSessionId: "closed" } },
    };
    expect(startupSessionId(response, "closed", ["open"])).toBe("open");
  });

  it("keeps an explicit empty Desktop tab snapshot empty", () => {
    const response: ListSessionsResponse = {
      sessions: [session("closed")],
      _meta: { "pix.tabs": { sessionIds: ["closed"], activeSessionId: "closed" } },
    };
    expect(startupSessionId(response, "closed", [])).toBeNull();
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

describe("Desktop session-tab storage", () => {
  it("round-trips ordered project-scoped tab lists including an explicit empty list", () => {
    const tabs = new Map<string, readonly string[]>([
      ["/projects/a", ["a", "b"]],
      ["/projects/b", []],
    ]);
    expect(parseSessionTabIds(serializeSessionTabIds(tabs))).toEqual(new Map([
      ["/projects/a", ["a", "b"]],
      ["/projects/b", []],
    ]));
  });

  it("deduplicates ids and ignores malformed project values", () => {
    expect(parseSessionTabIds(JSON.stringify({
      "/projects/a": ["a", "a", 42, "b"],
      "/projects/b": "not-an-array",
    }))).toEqual(new Map([["/projects/a", ["a", "b"]]]));
  });
});

describe("restoreDesktopSessionTabs", () => {
  it("keeps the Desktop snapshot authoritative over stale TUI membership", () => {
    expect(restoreDesktopSessionTabs(["open", "desktop-only"], ["closed", "open"], [
      "closed", "open", "desktop-only",
    ])).toEqual({
      restoredIds: ["open", "desktop-only"],
      locallyOpenedIds: ["desktop-only"],
      closedIds: ["closed"],
    });
  });

  it("treats a missing Desktop snapshot as empty instead of restoring TUI tabs", () => {
    expect(restoreDesktopSessionTabs(null, ["a", "b"], ["a", "b"])).toEqual({
      restoredIds: [],
      locallyOpenedIds: [],
      closedIds: ["a", "b"],
    });
  });

  it("filters deleted sessions but preserves an explicit empty Desktop snapshot", () => {
    expect(restoreDesktopSessionTabs(["deleted"], ["stale"], ["stale"])).toEqual({
      restoredIds: [],
      locallyOpenedIds: [],
      closedIds: ["stale"],
    });
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
