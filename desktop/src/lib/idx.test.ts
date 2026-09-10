import { describe, expect, it } from "vitest";
import {
  idxArchivedPrimaryCount,
  idxCurrentPrimaryCount,
  idxKnowledgeCandidates,
  idxKnowledgeIssues,
  idxKnowledgeNeedsAttention,
  idxNumericField,
  idxOutputSegments,
  reconcileIdxOperationSnapshot,
  type IdxOperationSnapshot,
  type IdxParsedStatus,
} from "./idx";

describe("idx helpers", () => {
  it("parses numeric overview fields", () => {
    const status: IdxParsedStatus = {
      fields: { files: "743", primarySpecs: "44 (43 current/proposed)" },
      raw: "",
    };
    expect(idxNumericField(status, "files")).toBe(743);
    expect(idxNumericField(status, "primarySpecs")).toBe(44);
    expect(idxCurrentPrimaryCount(status)).toBe(43);
    expect(idxArchivedPrimaryCount(status)).toBe(1);
  });

  it("flags semantic knowledge drift without treating unresolved refs as stale", () => {
    const healthy: IdxParsedStatus = {
      fields: {
        primarySpecs: "47 (46 current/proposed)",
        fresh: "46",
        needsReview: "0",
        unresolvedRefs: "7",
        unverified: "0",
        newChangedCandidates: "0",
        uncoveredActiveAsIs: "0",
      },
      raw: "",
    };
    expect(idxKnowledgeNeedsAttention(healthy)).toBe(false);
    expect(idxKnowledgeNeedsAttention({
      ...healthy,
      fields: { ...healthy.fields, fresh: "45", needsReview: "1" },
    })).toBe(true);
    expect(idxKnowledgeNeedsAttention({
      ...healthy,
      fields: { ...healthy.fields, newChangedCandidates: "1" },
    })).toBe(true);
  });

  it("extracts actionable knowledge issue rows", () => {
    const status: IdxParsedStatus = {
      fields: {},
      raw: [
        "primary specs: 44 | needs review: 1",
        "Recommendation: inspect the changed source.",
        "  inputs-changed           specs/desktop-tools.md — input:desktop/src/App.svelte",
      ].join("\n"),
    };
    expect(idxKnowledgeIssues(status)).toEqual([
      {
        status: "inputs-changed",
        path: "specs/desktop-tools.md",
        detail: "input:desktop/src/App.svelte",
      },
    ]);
  });

  it("parses discover candidates with metadata", () => {
    const output = [
      "candidates: 1 | showing 1",
      "score=  4 spec-candidate   DESIGN.md known=design-only",
      "      title: Pix Desktop Design Contract",
      "      signals: design-like-filename, path-references:2",
    ].join("\n");
    expect(idxKnowledgeCandidates(output)).toEqual([
      {
        score: 4,
        kind: "spec-candidate",
        path: "DESIGN.md",
        known: "design-only",
        title: "Pix Desktop Design Contract",
        signals: "design-like-filename, path-references:2",
      },
    ]);
  });

  it("extracts project file references and optional line ranges from IDX output", () => {
    expect(idxOutputSegments("Read desktop/src/App.svelte:3309-3370, then README.md:12")).toEqual([
      { kind: "text", text: "Read " },
      {
        kind: "file",
        text: "desktop/src/App.svelte:3309-3370",
        path: "desktop/src/App.svelte",
        range: { startLine: 3309, endLine: 3370 },
      },
      { kind: "text", text: ", then " },
      {
        kind: "file",
        text: "README.md:12",
        path: "README.md",
        range: { startLine: 12, endLine: 12 },
      },
    ]);
  });

  it("keeps plain project paths linkable without inventing a range", () => {
    expect(idxOutputSegments("spec: ./specs/desktop-session-sidebar.md")).toEqual([
      { kind: "text", text: "spec: " },
      {
        kind: "file",
        text: "./specs/desktop-session-sidebar.md",
        path: "specs/desktop-session-sidebar.md",
      },
    ]);
  });

  it("reconciles operation state missed before start registration", () => {
    const started = operationSnapshot({ status: "running", output: "" });
    const refreshed = operationSnapshot({
      status: "succeeded",
      output: "indexed\n",
      finishedAtMs: 200,
      exitCode: 0,
    });

    expect(reconcileIdxOperationSnapshot(started, refreshed)).toEqual(refreshed);
  });

  it("does not regress a completion event received while reconciliation is in flight", () => {
    const completed = operationSnapshot({
      status: "failed",
      output: "failed after more output\n",
      finishedAtMs: 250,
      exitCode: 2,
    });
    const staleRefresh = operationSnapshot({ status: "running", output: "failed\n" });

    expect(reconcileIdxOperationSnapshot(completed, staleRefresh)).toEqual(completed);
  });
});

function operationSnapshot(overrides: Partial<IdxOperationSnapshot>): IdxOperationSnapshot {
  return {
    id: "idx-operation-1",
    windowLabel: "main",
    workspace: "/tmp/project",
    kind: "index",
    command: "idx index",
    status: "running",
    output: "",
    startedAtMs: 100,
    ...overrides,
  };
}
