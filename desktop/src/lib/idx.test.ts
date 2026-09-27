import { describe, expect, it } from "vitest";
import {
  applyIdxOverviewToOpenrouterEmbeddings,
  idxAuditPaths,
  idxOpenrouterEmbeddingsDefault,
  idxValidAuditPaths,
  idxNumericField,
  idxOutputSegments,
  reconcileIdxOperationSnapshot,
  resetIdxOpenrouterEmbeddings,
  setIdxOpenrouterEmbeddings,
  type IdxOperationSnapshot,
  type IdxOverview,
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

describe("idx OpenRouter embeddings checkbox", () => {
  it("defaults checked only when the workspace overview reports the openrouter provider", () => {
    expect(idxOpenrouterEmbeddingsDefault(overview("openrouter"))).toBe(true);
    expect(idxOpenrouterEmbeddingsDefault(overview("ollama"))).toBe(false);
    expect(idxOpenrouterEmbeddingsDefault(overview(undefined))).toBe(false);
    expect(idxOpenrouterEmbeddingsDefault(undefined)).toBe(false);
  });

  it("applies the provider-derived default from workspace-scoped overview refreshes", () => {
    let state = resetIdxOpenrouterEmbeddings();
    expect(state.checked).toBe(false);

    state = applyIdxOverviewToOpenrouterEmbeddings(state, undefined);
    expect(state.checked).toBe(false);

    state = applyIdxOverviewToOpenrouterEmbeddings(state, overview("openrouter"));
    expect(state.checked).toBe(true);

    state = applyIdxOverviewToOpenrouterEmbeddings(state, overview(undefined));
    expect(state.checked).toBe(false);
  });

  it("preserves manual edits across overview refreshes in the same workspace", () => {
    let state = applyIdxOverviewToOpenrouterEmbeddings(
      resetIdxOpenrouterEmbeddings(),
      overview("openrouter"),
    );
    expect(state.checked).toBe(true);

    state = setIdxOpenrouterEmbeddings(state, false);
    state = applyIdxOverviewToOpenrouterEmbeddings(state, overview("openrouter"));
    expect(state).toEqual({ checked: false, manual: true });

    state = setIdxOpenrouterEmbeddings(state, true);
    state = applyIdxOverviewToOpenrouterEmbeddings(state, overview(undefined));
    expect(state).toEqual({ checked: true, manual: true });
  });

  it("resets manual edits when the workspace changes and re-derives from the new overview", () => {
    let state = setIdxOpenrouterEmbeddings(
      applyIdxOverviewToOpenrouterEmbeddings(resetIdxOpenrouterEmbeddings(), overview("openrouter")),
      false,
    );

    state = resetIdxOpenrouterEmbeddings();
    expect(state).toEqual({ checked: false, manual: false });

    state = applyIdxOverviewToOpenrouterEmbeddings(state, overview("ollama"));
    expect(state.checked).toBe(false);
  });
});

/** Wire-shaped overview; non-openrouter providers exercise the panel's defensive default. */
function overview(embeddingProvider: string | undefined): IdxOverview {
  return {
    available: true,
    initialized: true,
    ...(embeddingProvider === undefined ? {} : { embeddingProvider }),
    rawStatus: "",
    errors: [],
  } as IdxOverview;
}

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
