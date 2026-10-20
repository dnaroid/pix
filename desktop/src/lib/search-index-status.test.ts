import { describe, expect, it } from "vitest";
import { buildSearchSourceRows, SEARCH_SEMANTIC_LABEL, type SearchIndexStatus, type SemanticConsent } from "./search-index-status";
import { SEARCH_CACHE_REBUILD_REQUIRED } from "../../../acp/src/search/contract";

const consent = (over: Partial<SemanticConsent> = {}): SemanticConsent => ({ configured: false, provider: "openrouter", model: "m", vectorSize: 768, keyAvailable: true, ...over });
const status = (files: Partial<SearchIndexStatus["stores"][number]>, history: Partial<SearchIndexStatus["stores"][number]> = {}): SearchIndexStatus => ({
  stores: [
    ...(["code", "knowledge"] as const).map(id => ({ id, state: "present" as const, counts: { files: 3, codeChunks: 5, knowledgeChunks: 2 }, completedAt: "t", generation: 1, ...files })),
    ...(["settings", "sessions", "tasks", "commits"] as const).map(id => ({ id, state: "absent" as const, counts: {}, ...history })),
  ],
});
const row = (rows: ReturnType<typeof buildSearchSourceRows>, id: string) => rows.find(r => r.id === id)!;

describe("buildSearchSourceRows", () => {
  it("never turns a failed or missing store status into Not indexed", () => {
    for (const snapshot of [null, { stores: [] }]) {
      const rows = buildSearchSourceRows(snapshot, consent({ configured: true }), undefined, 110);
      expect(rows.every(r => r.semantic === "unknown" && r.storedVectors === undefined)).toBe(true);
      expect(row(rows, "settings").localSummary).toBe("110 fields");
    }
    expect(buildSearchSourceRows(status({ state: "absent", counts: {} }), consent({ configured: true }))
      .every(r => r.semantic === "no-vectors")).toBe(true);
  });
  it("does not substitute chunks or zero for unknown cached entity counts", () => {
    const rows = buildSearchSourceRows(status({ counts: { codeChunks: 30 } }, { state: "present", counts: { sessionChunks: 100 } }), consent());
    expect(row(rows, "code").localSummary).toBeUndefined();
    expect(row(rows, "sessions").localSummary).toBeUndefined();
    expect(row(rows, "code").localDetail).toContain("30 chunks");
    expect(row(rows, "sessions").localDetail).toContain("100 public-message chunks");
  });
  it("reports message-chunk-only session indexes without mistaking them for an empty title cache", () => {
    const snapshot: SearchIndexStatus = { stores: [{ id: "sessions", state: "present",
      counts: { sessions: 4, sessionChunks: 240, sessionChunkVectors: 96 } }] };
    const session = row(buildSearchSourceRows(snapshot, consent({ configured: true })), "sessions");
    expect(session).toMatchObject({ local: "ready", localSummary: "4 sessions", semantic: "vectors", storedVectors: 96 });
    expect(session.localDetail).toContain("public-message chunks");
    expect(session.semanticDetail).toContain("96 stored vectors");
    const combined = row(buildSearchSourceRows({ stores: [{ ...snapshot.stores[0]!, counts: { sessionTitles: 3,
      sessionVectors: 2, sessions: 4, sessionChunks: 240, sessionChunkVectors: 96 } }] }, consent({ configured: true })), "sessions");
    expect(combined.storedVectors).toBe(98);
    expect(combined.localDetail).toContain("3 saved titles");
    expect(row(buildSearchSourceRows(null, consent()), "sessions").storedVectors).toBeUndefined();
  });
  it("keeps saved batch counts visible during a partial scan without declaring coverage complete", () => {
    const code = row(buildSearchSourceRows(status({ completedAt: null, counts: { files: 12, codeChunks: 400, vectors: 32 } }), consent({ configured: true })), "code");
    expect(code).toMatchObject({ local: "incomplete", localSummary: "12 files", storedVectors: 32 });
    expect(code.semanticDetail).toContain("stored counts alone do not prove coverage");
    expect(row(buildSearchSourceRows(status({ state: "error" }), consent()), "code").storedVectors).toBeUndefined();
  });
  it("isolates source databases instead of substituting legacy aggregate counts", () => {
    const snapshot: SearchIndexStatus = { stores: [
      { id: "settings", state: "error", counts: {}, error: "broken settings" },
      { id: "tasks", state: "present", counts: { taskDocuments: 2, taskVectors: 2 } },
      { id: "sessions", state: "absent", counts: {} },
      { id: "code", state: "present", counts: { codeChunks: 3, vectors: 3 }, completedAt: "t" },
      { id: "knowledge", state: "error", counts: {}, error: "broken knowledge" },
    ] };
    const rows = buildSearchSourceRows(snapshot, consent({ configured: true }));
    expect(row(rows, "settings").semantic).toBe("error");
    expect(row(rows, "tasks")).toMatchObject({ semantic: "vectors", localSummary: "2 tasks" });
    expect(row(rows, "sessions").semantic).toBe("no-vectors");
    expect(row(rows, "code").local).toBe("ready");
    expect(row(rows, "knowledge").local).toBe("error");
  });
  it("hides actions only for confirmed empty source histories, never an empty cache", () => {
    const absent = status({});
    const unknown = buildSearchSourceRows(absent, consent());
    expect(row(unknown, "sessions").empty).toBe(false);
    expect(row(unknown, "commits").empty).toBe(false);
    const empty = buildSearchSourceRows({ ...absent, commitsEmpty: true }, consent(), { sessionsEmpty: true });
    for (const id of ["sessions", "commits"]) expect(row(empty, id)).toMatchObject({ empty: true, local: "ready", localSummary: "0 items" });
    const populated = buildSearchSourceRows({ ...absent, commitsEmpty: false }, consent(), { sessionsEmpty: false });
    for (const id of ["sessions", "commits"]) expect(row(populated, id).empty).toBe(false);
  });
  it("lists all six sources and treats missing status as unknown", () => {
    const rows = buildSearchSourceRows(null, null);
    expect(rows.map(r => r.id)).toEqual(["code", "knowledge", "settings", "sessions", "tasks", "commits"]);
    expect(rows.every(r => r.local === "unknown")).toBe(true);
    expect(row(rows, "code").semantic).toBe("unknown");
  });
  it("reports independent semantic activity without changing other cells", () => {
    const checking = buildSearchSourceRows(status({}), consent(), {
      indexingSources: { settings: false, tasks: false, sessions: false }, checkingSources: { tasks: true },
    });
    expect(checking.some(r => r.semanticActive)).toBe(false);
    const rows = buildSearchSourceRows(status({}), consent({ configured: true }), {
      indexingSources: { settings: false, tasks: true, sessions: false },
    }, 40);
    expect(rows.filter(r => r.semanticActive).map(r => r.id)).toEqual(["tasks"]);
    expect(row(rows, "settings")).toMatchObject({ local: "ready", localSummary: "40 fields", semanticActive: false });
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
  it("reports incompatible caches and source compatibility errors as needing rebuild", () => {
    const snapshot = status({}, { state: "present", counts: { settingsVectors: 102, sessionVectors: 500, taskVectors: 3 }, incompatibleSources: ["settings", "sessions"] });
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
    expect(row(rows, "tasks").localSummary).toBe("3 tasks");
    expect(row(rows, "code").localSummary).toBe("3 files");
  });
  it("shows saved plans next to tasks instead of counting plan chunks as tasks", () => {
    const summary = (counts: Record<string, number>) =>
      row(buildSearchSourceRows(status({}, { state: "present", counts }), consent({ configured: true })), "tasks").localSummary;
    expect(summary({ taskDocuments: 8, taskPlans: 1, taskVectors: 12 })).toBe("8 tasks · 1 plan");
    expect(summary({ taskDocuments: 8, taskPlans: 3 })).toBe("8 tasks · 3 plans");
    expect(summary({ taskDocuments: 0, taskPlans: 2 })).toBe("0 tasks · 2 plans");
    expect(summary({ taskDocuments: 8, taskPlans: 0 })).toBe("8 tasks");
  });
});
