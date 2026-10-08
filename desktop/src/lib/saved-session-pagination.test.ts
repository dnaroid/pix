import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import { fuzzySearch } from "./fuzzy";
import { buildSessionTree } from "./session-tabs";
import {
  SAVED_SESSION_INITIAL_ROWS,
  SAVED_SESSION_NEXT_ROWS,
  nextSavedSessionRowCount,
  visibleSavedSessionRows,
} from "./saved-session-pagination";

describe("saved conversation progressive list", () => {
  it("shows 30 first and adds 15 per page without moving or duplicating records", () => {
    const sessions = Array.from({ length: 83 }, (_, index) => `id-${index}`);
    const first = visibleSavedSessionRows(sessions, SAVED_SESSION_INITIAL_ROWS);
    expect(first).toEqual(sessions.slice(0, 30));
    expect(SAVED_SESSION_NEXT_ROWS).toBe(15);
    const secondLimit = nextSavedSessionRowCount(first.length, sessions.length);
    expect(secondLimit).toBe(45);
    expect(visibleSavedSessionRows(sessions, secondLimit)).toEqual(sessions.slice(0, 45));
    expect(nextSavedSessionRowCount(secondLimit, sessions.length)).toBe(60);
    expect(nextSavedSessionRowCount(75, sessions.length)).toBe(83);
    expect(nextSavedSessionRowCount(83, sessions.length)).toBe(83);
    expect(visibleSavedSessionRows([], 30)).toEqual([]);
  });

  it("builds fork ancestry before slicing and searches all titles, including undisplayed rows", () => {
    const sessions: SessionInfo[] = Array.from({ length: 70 }, (_, index) => ({
      sessionId: `session-${index}`,
      cwd: "/project",
      title: index === 0 ? "Ancient deep match" : `Session ${index}`,
      updatedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
    }));
    const parent = sessions[65]!;
    const child = sessions[64]!;
    sessions[64] = {
      ...child,
      _meta: { "pix.isFork": true, "pix.parentSessionId": parent.sessionId },
    };
    const fullTree = buildSessionTree(sessions);
    const partialTree = visibleSavedSessionRows(fullTree, SAVED_SESSION_INITIAL_ROWS);
    expect(partialTree).toEqual(fullTree.slice(0, 30));
    expect(partialTree.map(row => row.session.sessionId)).toContain(parent.sessionId);
    expect(partialTree.find(row => row.session.sessionId === child.sessionId)?.treePrefix).toContain("└─");
    expect(partialTree.some(row => row.session.sessionId === "session-0")).toBe(false);
    const matches = fuzzySearch(sessions.map(s => ({ value: s, label: s.title ?? "" })), "Ancient deep match");
    expect(matches[0]?.value.sessionId).toBe("session-0");
  });
});
