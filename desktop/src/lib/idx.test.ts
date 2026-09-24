import { describe, expect, it } from "vitest";
import {
  idxAuditPaths,
  idxValidAuditPaths,
  idxNumericField,
  idxOutputSegments,
  reconcileIdxOperationSnapshot,
  type IdxOperationSnapshot,
  type IdxParsedStatus,
} from "./idx";

describe("idx helpers", () => {
  it("parses numeric overview fields", () => {
    const status: IdxParsedStatus = {
      fields: { files: "743" },
      raw: "",
    };
    expect(idxNumericField(status, "files")).toBe(743);
  });

  it("requires explicit project-relative task paths for audits", () => {
    expect(idxAuditPaths(" src/main.ts, specs/design.md\n src/main.ts \n")).toEqual(["src/main.ts", "specs/design.md"]);
    expect(idxValidAuditPaths(idxAuditPaths("  , \n"))).toBe(false);
    for (const path of ["/tmp/secret", "../outside", "src/../../outside", "C:/outside", "src\\file.ts", "./src/file.ts", "src//file.ts"])
      expect(idxValidAuditPaths([path])).toBe(false);
    expect(idxValidAuditPaths(["src/main.ts", "specs/design.md"])).toBe(true);
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
