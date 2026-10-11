import { describe, expect, it } from "vitest";
import { buildSearchSourceRows, SEARCH_SEMANTIC_LABEL, type SearchIndexStatus, type SemanticConsent } from "./search-index-status";
import { SEARCH_CACHE_REBUILD_REQUIRED } from "../../../acp/src/search/contract";

const consent = (over: Partial<SemanticConsent> = {}): SemanticConsent => ({ configured: false, provider: "openrouter", model: "m", vectorSize: 768, keyAvailable: true, ...over });
const status = (files: Partial<SearchIndexStatus["stores"][number]>, history: Partial<SearchIndexStatus["stores"][number]> = {}): SearchIndexStatus => ({
  stores: [
    { id: "files", state: "present", counts: { codeChunks: 5, knowledgeChunks: 2 }, completedAt: "t", generation: 1, ...files },
    { id: "vectors", state: "absent", counts: {} },
    { id: "history", state: "absent", counts: {}, ...history },
  ],
});
const row = (rows: ReturnType<typeof buildSearchSourceRows>, id: string) => rows.find(r => r.id === id)!;

describe("buildSearchSourceRows", () => {
  it("lists all six sources and treats missing status as unknown", () => {
    const rows = buildSearchSourceRows(null, null);
    expect(rows.map(r => r.id)).toEqual(["code", "knowledge", "settings", "sessions", "tasks", "commits"]);
    expect(rows.every(r => r.local === "unknown")).toBe(true);
    expect(row(rows, "code").semantic).toBe("unknown");
  });
  it("reports independent semantic activity without changing other cells", () => {
    const rows = buildSearchSourceRows(status({}), consent({ configured: true }), {
      indexingSources: { settings: false, tasks: true, sessions: false },
    }, 40);
    expect(rows.filter(r => r.semanticActive).map(r => r.id)).toEqual(["tasks"]);
    expect(row(rows, "settings")).toMatchObject({ local: "ready", localSummary: "40 items", semanticActive: false });
    expect(rows.some(r => r.local === "incomplete")).toBe(false);
    const legacyAggregateOnly = { indexing: true };
    expect(buildSearchSourceRows(status({}), consent(), legacyAggregateOnly as {}).some(r => r.semanticActive)).toBe(false);
  });
  it("reports provider failures only for their own source", () => {
    const rows = buildSearchSourceRows(status({}), consent({ configured: true }), { sourceErrors: { tasks: "Task provider unavailable" } });
    expect(row(rows, "tasks")).toMatchObject({ semantic: "error", semanticDetail: "Task provider unavailable", semanticActive: false });
    expect(row(rows, "settings").semantic).not.toBe("error");
  });
  it("distinguishes missing, incomplete, ready and error local indexes", () => {
    expect(row(buildSearchSourceRows(status({ state: "absent", counts: {} }), consent()), "code").local).toBe("missing");
    expect(row(buildSearchSourceRows(status({ completedAt: null }), consent()), "code").local).toBe("incomplete");
    expect(row(buildSearchSourceRows(status({}), consent()), "knowledge").local).toBe("ready");
    expect(row(buildSearchSourceRows(status({ state: "error", error: "bad" }), consent()), "code")).toMatchObject({ local: "error", localDetail: "bad" });
  });
  it("reports legacy caches and source compatibility errors as needing rebuild, not cached or generic failure", () => {
    const snapshot = status({}, { state: "present", counts: { settingsVectors: 102, sessionVectors: 500, taskVectors: 3 }, legacySources: ["settings", "sessions"] });
    const rows = buildSearchSourceRows(snapshot, consent({ configured: true }));
    expect(row(rows, "settings")).toMatchObject({ semantic: "incompatible", semanticDetail: SEARCH_CACHE_REBUILD_REQUIRED });
    expect(row(rows, "sessions").semantic).toBe("incompatible");
    expect(row(rows, "tasks").semantic).toBe("vectors");
    expect(SEARCH_SEMANTIC_LABEL.incompatible).toBe("Needs rebuild");
    expect(row(buildSearchSourceRows(snapshot, consent()), "sessions").semantic).toBe("disabled");
    const mismatch = buildSearchSourceRows(status({}), consent({ configured: true }), { sourceErrors: { tasks: SEARCH_CACHE_REBUILD_REQUIRED } });
    expect(row(mismatch, "tasks").semantic).toBe("incompatible");
    expect(row(mismatch, "settings").semantic).toBe("no-vectors");
  });
  it("uses one global configuration for all semantic sources", () => {
    expect(row(buildSearchSourceRows(status({}), consent()), "code").semantic).toBe("disabled");
    expect(row(buildSearchSourceRows(status({}), consent({ configured: true, keyAvailable: false })), "code").semantic).toBe("unavailable");
    const configuredRows = buildSearchSourceRows(status({}), consent({ configured: true }));
    expect(configuredRows.every(item => item.semantic === "no-vectors")).toBe(true);
    expect(row(buildSearchSourceRows(status({}), null), "code").semantic).toBe("unknown");
  });
  it("applies global semantic settings to history sources", () => {
    const rows = buildSearchSourceRows(status({}, { state: "present", counts: { taskDocuments: 3, taskVectors: 3 } }), consent({ configured: true }));
    expect(row(rows, "tasks")).toMatchObject({ local: "ready", semantic: "vectors" });
    expect(row(rows, "sessions").local).toBe("on-demand");
    expect(row(rows, "tasks").localSummary).toBe("3 items");
    expect(row(rows, "code").localSummary).toBe("5 chunks");
  });
});
