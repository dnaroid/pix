import { describe, expect, it } from "vitest";
import type { IdxCommandResult } from "./idx";
import { idxKnowledgeReason, parseIdxKnowledgeReport } from "./idx-knowledge";

function output(report: unknown, exitCode = 0): IdxCommandResult {
  return { stdout: JSON.stringify(report), stderr: "", exitCode, truncated: false };
}
const dirty = {
  status: "dirty", counts: { clean: 1, dirty: 1, error: 0 }, warnings: [],
  specs: [
    { path: "specs/clean.md", status: "clean", reasons: [], changedPaths: [] },
    { path: "specs/pending.md", status: "dirty", reasons: ["content-changed"], changedPaths: ["src/a.ts", "src/deleted.ts"] },
  ],
};

describe("IDX knowledge details", () => {
  it("preserves all files and reasons in a complete dirty report", () => {
    const report = parseIdxKnowledgeReport(output(dirty));
    expect(report.specs).toEqual(dirty.specs);
    expect(report.status).toBe("dirty");
  });

  it("accepts clean including empty selection, and incomplete exit-2 reports without hiding warnings", () => {
    expect(parseIdxKnowledgeReport(output({ status: "clean", counts: { clean: 0, dirty: 0, error: 0 }, specs: [], warnings: [] })).status).toBe("clean");
    const report = { status: "error", counts: { clean: 0, dirty: 0, error: 1 }, specs: [{ path: "specs/missing.md", status: "error", reasons: ["Missing dependency"], changedPaths: [] }], warnings: ["skipped file"] };
    expect(parseIdxKnowledgeReport(output(report, 2))).toMatchObject({ status: "error", warnings: ["skipped file"], specs: report.specs });
  });

  it.each([
    { ...output(dirty), truncated: true },
    { ...output(dirty), exitCode: 1 },
    { ...output(dirty), exitCode: undefined },
    output({ ...dirty, status: "clean" }),
    output({ ...dirty, counts: { clean: 1, dirty: 0, error: 0 } }),
    output({ ...dirty, counts: { clean: 0, dirty: 2, error: 0 }, specs: [dirty.specs[1], dirty.specs[1]] }),
    output({ ...dirty, warnings: ["incomplete"] }),
    output({ ...dirty, specs: [{ path: "a", status: "dirty", reasons: [], changedPaths: [42] }] }),
    output(null),
  ])("rejects incomplete, inconsistent or malformed output", (result) => {
    expect(() => parseIdxKnowledgeReport(result)).toThrow();
  });

  it("explains old CLI failures and translates known reasons without dropping new ones", () => {
    expect(() => parseIdxKnowledgeReport({ stdout: "", stderr: "unknown command 'status'", exitCode: 1, truncated: false })).toThrow("Update IDX");
    expect(idxKnowledgeReason("never-reviewed")).toBe("Not reviewed yet");
    expect(idxKnowledgeReason("content-changed")).toContain("dependencies changed");
    expect(idxKnowledgeReason("no-declarations")).toContain("No Implementation/Tests");
    expect(idxKnowledgeReason("Cannot read dependency")).toBe("Cannot read dependency");
  });
});
