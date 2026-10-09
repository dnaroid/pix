import { describe, expect, it } from "vitest";
import { buildSessionTree } from "./session-tabs";
import { expandedSessionRows, flatSessionRow, sessionRowsRelated } from "./saved-session-tree";

const sessions = [
  { sessionId: "root", cwd: "/project" },
  { sessionId: "child", cwd: "/project", updatedAt: "2026-01-03", _meta: { "pix.parentSessionId": "root" } },
  { sessionId: "sibling", cwd: "/project", updatedAt: "2026-01-02", _meta: { "pix.parentSessionId": "root" } },
  { sessionId: "nested", cwd: "/project", _meta: { "pix.parentSessionId": "child" } },
];
const rows = buildSessionTree(sessions);
const ids = (items: typeof rows) => items.map((row) => row.session.sessionId);

describe("graphical saved-session tree", () => {
  it("provides geometry, effective ancestry, and only real child affordances", () => {
    expect(rows.map(({ depth, ancestorIds, ancestorContinues, isLast, hasChildren }) =>
      ({ depth, ancestorIds, ancestorContinues, isLast, hasChildren }))).toEqual([
      { depth: 0, ancestorIds: [], ancestorContinues: [], isLast: true, hasChildren: true },
      { depth: 1, ancestorIds: ["root"], ancestorContinues: [], isLast: false, hasChildren: true },
      { depth: 2, ancestorIds: ["root", "child"], ancestorContinues: [true], isLast: true, hasChildren: false },
      { depth: 1, ancestorIds: ["root"], ancestorContinues: [], isLast: true, hasChildren: false },
    ]);
  });

  it("collapses only descendants and preserves nested collapse when a parent reopens", () => {
    expect(ids(expandedSessionRows(rows, new Set(["child"])))).toEqual(["root", "child", "sibling"]);
    expect(ids(expandedSessionRows(rows, new Set(["root", "child"])))).toEqual(["root"]);
    expect(ids(expandedSessionRows(rows, new Set(["missing"])))).toEqual(ids(rows));
    expect(rows).toHaveLength(4);
  });

  it("flat search rows bypass ancestry, disclosure and collapse", () => {
    const flat = sessions.map(flatSessionRow);
    expect(expandedSessionRows(flat, new Set(["root", "child"]))).toEqual(flat);
    expect(flat.every((row) => row.depth === 0 && !row.hasChildren && !row.treePrefix)).toBe(true);
  });

  it("highlights only the hovered/focused row and its direct relationships", () => {
    expect(rows.filter((row) => sessionRowsRelated(row, rows[1]!)).map((row) => row.session.sessionId))
      .toEqual(["root", "child", "nested"]);
    expect(rows.filter((row) => sessionRowsRelated(row, rows[2]!)).map((row) => row.session.sessionId))
      .toEqual(["child", "nested"]);
    expect(sessionRowsRelated(rows[0]!, null)).toBe(false);
  });

  it("breaks cycles without phantom children or cyclic ancestry", () => {
    const cycle = buildSessionTree([
      { sessionId: "a", cwd: "/project", _meta: { "pix.parentSessionId": "b" } },
      { sessionId: "b", cwd: "/project", _meta: { "pix.parentSessionId": "a" } },
      { sessionId: "orphan", cwd: "/project", _meta: { "pix.parentSessionId": "missing" } },
    ]);
    expect(ids(cycle)).toEqual(["orphan", "a", "b"]);
    expect(cycle[1]?.hasChildren).toBe(true);
    expect(cycle[2]?.hasChildren).toBe(false);
    expect(cycle[2]?.ancestorIds).toEqual(["a"]);
  });
});
