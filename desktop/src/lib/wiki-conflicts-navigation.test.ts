import { describe, expect, it } from "vitest";
import type { KnowledgeCitation } from "../../../acp/src/knowledge/contract";
import type { WikiFinding } from "./wiki-conflicts-index";
import {
  flattenWikiFindingGroups, moveWikiFindingGroup, moveWikiFindingRow, resolveWikiFindingSelection, wikiFindingRowKey,
} from "./wiki-conflicts-navigation";

const citation = (path: string, quote: string, startLine = 1, endLine = startLine): KnowledgeCitation => ({ path, quote, startLine, endLine });
const finding = (id: string, extra: Partial<WikiFinding> = {}): WikiFinding => ({
  id, kind: "conflict", internal: false,
  draft: citation("wiki/a.md", "Claim A."), existing: citation("wiki/b.md", "Claim B.", 3),
  explanation: "Rules differ.", reportPath: "wiki/a.md", checkedAt: "2026-10-30T00:00:00.000Z",
  current: true, modelRef: "test/judge", reportPaths: ["wiki/a.md"], stale: false, ...extra,
} as WikiFinding);
const rows = flattenWikiFindingGroups([
  { key: "g1", label: "g1", findings: [finding("a"), finding("b")] },
  { key: "g2", label: "g2", findings: [finding("c"), finding("a")] },
] as never);

describe("Wiki Conflicts inbox navigation", () => {
  it("keeps the selected row, falls back to the same finding, then to the first row", () => {
    expect(resolveWikiFindingSelection(rows, wikiFindingRowKey("g2", "c"))).toBe(wikiFindingRowKey("g2", "c"));
    expect(resolveWikiFindingSelection(rows, wikiFindingRowKey("gone", "c"))).toBe(wikiFindingRowKey("g2", "c"));
    expect(resolveWikiFindingSelection(rows, null)).toBe(rows[0]!.key);
    expect(resolveWikiFindingSelection([], "x")).toBeNull();
  });

  it("prefers a requested finding when it is visible", () => {
    expect(resolveWikiFindingSelection(rows, rows[0]!.key, "c")).toBe(wikiFindingRowKey("g2", "c"));
    expect(resolveWikiFindingSelection(rows, rows[1]!.key, "missing")).toBe(rows[1]!.key);
  });

  it("moves between rows without wrapping and between group starts", () => {
    expect(moveWikiFindingRow(rows, rows[0]!.key, -1)).toBe(rows[0]!.key);
    expect(moveWikiFindingRow(rows, rows[3]!.key, 1)).toBe(rows[3]!.key);
    expect(moveWikiFindingRow(rows, rows[1]!.key, 1)).toBe(rows[2]!.key);
    expect(moveWikiFindingGroup(rows, rows[1]!.key, 1)).toBe(rows[2]!.key);
    expect(moveWikiFindingGroup(rows, rows[3]!.key, -1)).toBe(rows[0]!.key);
    expect(moveWikiFindingGroup(rows, rows[3]!.key, 1)).toBe(rows[2]!.key);
  });
});
