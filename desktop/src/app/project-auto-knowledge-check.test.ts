// @ts-expect-error Node crypto import in Vitest runner (frontend tsconfig omits Node globals)
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeCheckRequest, KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";
import {
  preserveKnowledgeReport, readKnowledgeAutoCheckAttempt, readKnowledgeCheckStamp,
  readKnowledgeReport, recordKnowledgeCheck, stripKnowledgeCheckStamp,
} from "../../../acp/src/knowledge/stamp";
import { EMPTY_PROJECT_DOCUMENTS } from "../lib/project-documents";
import { createProjectDocumentsStore } from "./project-documents.svelte";
import { WIKI_AUTO_CHECK_POLL_MS, WIKI_AUTO_CHECK_SETTLE_MS } from "./wiki-auto-check.svelte";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), readSearchSourceSelection: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/search-source-selection", () => ({ readSearchSourceSelection: mocks.readSearchSourceSelection }));

const WORKSPACE = "/project";
const CONFIG = ".pi/workspace.jsonc";
const PASS = "10000000-0000-4000-8000-000000000001";
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const stores = new Set<ReturnType<typeof createProjectDocumentsStore>>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function result(path: string, content: string, status: KnowledgeCheckResult["status"] = "clear"): KnowledgeCheckResult {
  return {
    status, path, documentHash: digest(content), modelRef: "test/judge", reportLanguage: "ru", checkedSources: 1,
    conflicts: status === "conflicts" ? [{
      draft: { path, quote: content, startLine: 1, endLine: 1 },
      existing: { path: "wiki/green.md", quote: "Существующее правило", startLine: 1, endLine: 1 },
      explanation: "Правила несовместимы в одной области действия.",
    }] : [],
    notices: status === "incomplete" ? ["Для сравнения нужен дополнительный контекст."] : [],
  };
}

type NativeArgs = { workspace?: string; wikiPath?: string; path?: string; cursor?: string; content?: string; expectedContent?: string | null };

function fixture() {
  let revision = 0;
  let config = JSON.stringify({ wiki: { path: "wiki", autoCheck: true, autoCheckRunId: PASS }, search: { sources: { knowledge: true } } });
  const files = new Map<string, { content: string; revision: string }>();
  const statuses = new Map<string, KnowledgeCheckResult["status"]>();
  const writes: { path: string; content: string; expectedContent: string }[] = [];
  const put = (path: string, content: string) => { files.set(path, { content, revision: `revision-${++revision}` }); };
  const raw = (path: string) => {
    const file = files.get(path);
    if (!file) throw new Error("Fixture file does not exist: " + path);
    return file.content;
  };
  const checkKnowledge = vi.fn(async (request: KnowledgeCheckRequest, _signal: AbortSignal) =>
    result(request.path, request.content, statuses.get(request.path) ?? "clear"));
  const clearError = vi.fn(), reportError = vi.fn(), reportBackgroundKnowledgeError = vi.fn();
  const afterSave = vi.fn(), onKnowledgeJobComplete = vi.fn();
  mocks.invoke.mockImplementation(async (command: string, args: NativeArgs) => {
    if (args.workspace !== WORKSPACE) throw new Error("Unexpected workspace in fixture native request");
    if (command === "list_project_documents") return EMPTY_PROJECT_DOCUMENTS;
    if (command === "project_file_exists") return args.path === CONFIG || files.has(args.path!);
    if (command === "read_project_file") return { path: args.path!, content: args.path === CONFIG ? config : raw(args.path!) };
    if (command === "write_project_workspace_config_if_unchanged") {
      if (args.expectedContent !== config) return { written: false, document: { path: CONFIG, content: config } };
      config = args.content!;
      return { written: true, document: { path: CONFIG, content: config } };
    }
    if (command === "list_wiki_check_directory") {
      const directory = args.path!, wikiPath = args.wikiPath!;
      if (directory !== wikiPath && !directory.startsWith(wikiPath + "/")) throw new Error("Inventory outside configured Wiki");
      const children = new Map<string, { path: string; kind: "directory" | "file"; revision?: string; size?: number }>();
      for (const [path, file] of files) {
        if (!path.startsWith(directory + "/")) continue;
        const suffix = path.slice(directory.length + 1), slash = suffix.indexOf("/");
        if (slash >= 0) {
          const child = directory + "/" + suffix.slice(0, slash);
          children.set(child, { path: child, kind: "directory" });
        } else children.set(path, { path, kind: "file", revision: file.revision, size: new TextEncoder().encode(file.content).byteLength });
      }
      return { entries: [...children.values()] };
    }
    if (command === "release_wiki_check_inventory") return;
    if (command === "read_wiki_check_document") {
      if (!args.path!.startsWith(args.wikiPath! + "/")) throw new Error("Document outside configured Wiki");
      return { path: args.path!, content: raw(args.path!) };
    }
    if (command === "write_project_file" || command === "write_project_markdown") {
      // The integration must supply and respect the exact raw loaded bytes, including metadata.
      if (typeof args.expectedContent !== "string" || args.expectedContent !== raw(args.path!)) {
        throw new Error("Native raw expected-content guard refused the write");
      }
      writes.push({ path: args.path!, content: args.content!, expectedContent: args.expectedContent });
      put(args.path!, args.content!);
      return { path: args.path!, content: args.content! };
    }
    throw new Error("Unexpected fixture native command: " + command);
  });
  function makeStore() {
    const store = createProjectDocumentsStore({
      workspace: () => WORKSPACE, previewId: () => undefined, currentFile: () => undefined,
      openProjectFile: vi.fn(), showEmptyFile: vi.fn(), afterSave, clearError, reportError,
      checkKnowledge, onKnowledgeJobComplete, knowledgeBackgroundReady: () => true,
      reportBackgroundKnowledgeError,
    });
    stores.add(store);
    return store;
  }
  let store = makeStore();
  return {
    get store() { return store; }, files, put, raw, statuses, writes,
    checkKnowledge, clearError, reportError, reportBackgroundKnowledgeError, afterSave, onKnowledgeJobComplete,
    async start() { await store.load(WORKSPACE); await advance(WIKI_AUTO_CHECK_SETTLE_MS + 250); },
    async restart() {
      store.dispose(); stores.delete(store); store = makeStore();
      await store.load(WORKSPACE); await advance(WIKI_AUTO_CHECK_SETTLE_MS + 250);
    },
    setWikiPath(path: string) {
      config = JSON.stringify({ wiki: { path, autoCheck: true, autoCheckRunId: PASS }, search: { sources: { knowledge: true } } });
    },
  };
}

async function advance(ms = 0) { await vi.advanceTimersByTimeAsync(ms); }

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.readSearchSourceSelection.mockReset().mockResolvedValue({ enabled: { knowledge: true } });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T12:00:00.000Z"));
  // Preserve real SHA-256 while eliminating worker-thread scheduling from the fake clock.
  vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (_algorithm, data) => {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer;
  });
});
afterEach(() => {
  for (const store of stores) store.dispose();
  stores.clear();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe("automatic Wiki checks through the actual project documents store", () => {
  it("checks only non-green files and quietly persists complete reports, pass checkpoints and success stamps through raw CAS", async () => {
    const item = fixture();
    item.put("wiki/green.md", await recordKnowledgeCheck("Существующее правило", result("wiki/green.md", "Существующее правило")));
    item.put("wiki/clear.md", "Consistent new page");
    item.put("wiki/red.md", "Противоречащее правило"); item.statuses.set("wiki/red.md", "conflicts");
    item.put("wiki/yellow.md", "Incomplete new page"); item.statuses.set("wiki/yellow.md", "incomplete");
    await item.start();
    expect(item.checkKnowledge.mock.calls.map(([request]) => request.path).sort())
      .toEqual(["wiki/clear.md", "wiki/red.md", "wiki/yellow.md"]);
    expect(item.store.knowledgeJobs.every(job => job.state === "completed" && job.recorded)).toBe(true);
    expect(item.writes).toHaveLength(3);
    expect(item.writes.map(write => write.expectedContent).sort()).toEqual(["Consistent new page", "Incomplete new page", "Противоречащее правило"].sort());
    expect(await readKnowledgeCheckStamp(item.raw("wiki/clear.md"))).toMatchObject({ status: "clear", contentHash: digest("Consistent new page") });
    expect(await readKnowledgeReport(item.raw("wiki/red.md"))).toMatchObject({ current: true, result: { status: "conflicts", conflicts: [{ explanation: "Правила несовместимы в одной области действия." }] } });
    expect(await readKnowledgeReport(item.raw("wiki/yellow.md"))).toMatchObject({ current: true, result: { status: "incomplete" } });
    for (const path of ["wiki/red.md", "wiki/yellow.md"]) {
      expect(await readKnowledgeAutoCheckAttempt(item.raw(path))).toMatchObject({ current: true, runId: PASS });
    }
    expect(item.clearError).not.toHaveBeenCalled();
    expect(item.reportError).not.toHaveBeenCalled();
    expect(item.reportBackgroundKnowledgeError).not.toHaveBeenCalled();
    await advance(WIKI_AUTO_CHECK_POLL_MS * 2);
    expect(item.checkKnowledge).toHaveBeenCalledTimes(3);
    await item.restart();
    expect(item.checkKnowledge).toHaveBeenCalledTimes(3);
  });

  it("keeps the previous stale report on a model failure and resumes its completed attempted version after recreating the store", async () => {
    const item = fixture(), path = "wiki/page.md";
    const previous = result(path, "Previous body", "incomplete");
    const oldReport = await recordKnowledgeCheck("Previous body", previous, "2026-01-01T00:00:00.000Z");
    const raw = await preserveKnowledgeReport("Changed body", oldReport);
    item.put(path, raw);
    item.checkKnowledge.mockRejectedValueOnce(new Error("Judge unavailable"));
    await item.start();
    expect(item.store.knowledgeJobs[0]).toMatchObject({ state: "failed", recorded: true, origin: "background" });
    expect(stripKnowledgeCheckStamp(item.raw(path))).toBe("Changed body");
    expect(await readKnowledgeReport(item.raw(path))).toMatchObject({ current: false, checkedAt: "2026-01-01T00:00:00.000Z", result: previous });
    expect(await readKnowledgeAutoCheckAttempt(item.raw(path))).toMatchObject({ current: true, runId: PASS, contentHash: digest("Changed body") });
    expect(item.writes).toHaveLength(1);
    expect(item.writes[0]?.expectedContent).toBe(raw);
    expect(item.reportBackgroundKnowledgeError).toHaveBeenCalled();
    expect(item.clearError).not.toHaveBeenCalled();
    expect(item.reportError).not.toHaveBeenCalled();
    await item.restart();
    await advance(WIKI_AUTO_CHECK_POLL_MS * 2);
    expect(item.checkKnowledge).toHaveBeenCalledTimes(1);
    expect(item.writes).toHaveLength(1);
  });

  it("discovers a new nested document and rechecks an edited body while ignoring its own metadata writes", async () => {
    const item = fixture();
    item.put("wiki/page.md", "Initial body");
    await item.start();
    expect(item.checkKnowledge).toHaveBeenCalledTimes(1);
    item.put("wiki/page.md", "Changed body");
    item.put("wiki/new-section/new.markdown", "New nested page");
    await advance(WIKI_AUTO_CHECK_POLL_MS + WIKI_AUTO_CHECK_SETTLE_MS + 250);
    expect(item.checkKnowledge.mock.calls.map(([request]) => [request.path, request.content]))
      .toEqual(expect.arrayContaining([["wiki/page.md", "Changed body"], ["wiki/new-section/new.markdown", "New nested page"]]));
    expect(item.checkKnowledge).toHaveBeenCalledTimes(3);
    expect(stripKnowledgeCheckStamp(item.raw("wiki/page.md"))).toBe("Changed body");
    expect(await readKnowledgeCheckStamp(item.raw("wiki/new-section/new.markdown"))).toBeDefined();
    await advance(WIKI_AUTO_CHECK_POLL_MS * 2);
    expect(item.checkKnowledge).toHaveBeenCalledTimes(3);
    expect(item.writes).toHaveLength(3);
  });

  it("refuses a late report for externally replaced bytes and subsequently checks the new saved version", async () => {
    const item = fixture(), path = "wiki/page.md", backend = deferred<KnowledgeCheckResult>();
    item.put(path, "Captured body");
    item.checkKnowledge.mockReturnValueOnce(backend.promise);
    await item.start();
    expect(item.checkKnowledge.mock.calls[0]?.[0]).toMatchObject({ path, content: "Captured body", expectedContent: "Captured body" });
    item.put(path, "New external body");
    backend.resolve(result(path, "Captured body"));
    await advance();
    expect(item.raw(path)).toBe("New external body");
    expect(item.store.knowledgeJobs[0]).toMatchObject({ state: "completed", recorded: false });
    expect(item.writes).toHaveLength(0);
    expect(item.afterSave).not.toHaveBeenCalled();
    await advance(WIKI_AUTO_CHECK_POLL_MS + WIKI_AUTO_CHECK_SETTLE_MS + 250);
    expect(item.checkKnowledge).toHaveBeenCalledTimes(2);
    expect(item.checkKnowledge.mock.calls[1]?.[0]).toMatchObject({ content: "New external body", expectedContent: "New external body" });
    expect(stripKnowledgeCheckStamp(item.raw(path))).toBe("New external body");
    expect(await readKnowledgeCheckStamp(item.raw(path))).toMatchObject({ contentHash: digest("New external body") });
    expect(item.writes).toHaveLength(1);
    expect(item.clearError).not.toHaveBeenCalled();
    expect(item.reportError).not.toHaveBeenCalled();
  });

  it("preserves an existing green stamp when an explicit recheck fails while automatic checking is enabled", async () => {
    const item = fixture(), path = "wiki/green.md", body = "Previously checked body";
    const green = await recordKnowledgeCheck(body, result(path, body));
    item.put(path, green);
    await item.start();
    expect(item.checkKnowledge).not.toHaveBeenCalled();
    item.checkKnowledge.mockRejectedValueOnce(new Error("Judge unavailable"));
    const id = item.store.enqueueKnowledgeCheck({ path, content: body, expectedContent: green, persistStamp: true });
    expect(id).toBeDefined();
    await advance();
    expect(item.store.knowledgeJobs.find(job => job.id === id)).toMatchObject({ state: "failed", recorded: true });
    expect(item.raw(path)).toBe(green);
    expect(await readKnowledgeCheckStamp(item.raw(path))).toMatchObject({ status: "clear", contentHash: digest(body) });
    expect(await readKnowledgeAutoCheckAttempt(item.raw(path))).toBeUndefined();
    expect(item.writes).toHaveLength(0);
    expect(item.afterSave).not.toHaveBeenCalled();
    expect(item.clearError).not.toHaveBeenCalled();
    // The existing success is historical metadata, not a new successful completion event.
    expect(item.onKnowledgeJobComplete).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ state: "failed", error: "Judge unavailable" }));
    expect(item.onKnowledgeJobComplete.mock.calls[0]?.[0].result).toBeUndefined();
    await advance(WIKI_AUTO_CHECK_POLL_MS + WIKI_AUTO_CHECK_SETTLE_MS);
    expect(item.checkKnowledge).toHaveBeenCalledTimes(1);
    expect(item.raw(path)).toBe(green);
  });

  it("defers background metadata while a waiting manual pre-save comparison owns the shared judge slot", async () => {
    const item = fixture(), autoPath = "wiki/automatic.md", manualPath = "wiki/pre-save.md";
    const autoBody = "Saved automatic page", manualDraft = "Edited manual draft";
    const manualSaved = await recordKnowledgeCheck("Saved manual page", result(manualPath, "Saved manual page"));
    item.put(autoPath, autoBody);
    item.put(manualPath, manualSaved);
    const automatic = deferred<KnowledgeCheckResult>(), manual = deferred<KnowledgeCheckResult>();
    let activeModels = 0, peakModels = 0;
    const events: string[] = [], activeAtSave: number[] = [];
    item.afterSave.mockImplementation(() => { activeAtSave.push(activeModels); });
    item.checkKnowledge.mockImplementation(async request => {
      activeModels++; peakModels = Math.max(peakModels, activeModels);
      events.push("start:" + request.path);
      try {
        if (request.path === autoPath) return await automatic.promise;
        if (request.path === manualPath) return await manual.promise;
        throw new Error("Unexpected comparison in shared-gate fixture");
      } finally {
        activeModels--; events.push("finish:" + request.path);
      }
    });
    await item.start();
    expect(item.checkKnowledge).toHaveBeenCalledTimes(1);
    expect(activeModels).toBe(1);
    const preSave = item.store.checkKnowledge(manualPath, manualDraft, new AbortController().signal);
    await advance();
    expect(item.checkKnowledge).toHaveBeenCalledTimes(1);
    automatic.resolve(result(autoPath, autoBody, "incomplete"));
    await advance();
    expect(item.checkKnowledge.mock.calls.map(([request]) => request.path)).toEqual([autoPath, manualPath]);
    expect(events).toEqual(["start:" + autoPath, "finish:" + autoPath, "start:" + manualPath]);
    expect(peakModels).toBe(1);
    expect(activeModels).toBe(1);
    // The manual comparison may be using the original automatic page as evidence.
    // Even completed automatic results must wait before changing its raw bytes.
    await advance(WIKI_AUTO_CHECK_POLL_MS);
    expect(item.raw(autoPath)).toBe(autoBody);
    expect(item.writes).toHaveLength(0);
    expect(item.afterSave).not.toHaveBeenCalled();
    expect(item.store.knowledgeJobs[0]?.state).toBe("running");
    manual.resolve(result(manualPath, manualDraft));
    const manualResult = expect(preSave).resolves.toMatchObject({ status: "clear", path: manualPath, documentHash: digest(manualDraft) });
    await advance();
    await manualResult;
    expect(activeModels).toBe(0);
    expect(peakModels).toBe(1);
    expect(events).toEqual(["start:" + autoPath, "finish:" + autoPath, "start:" + manualPath, "finish:" + manualPath]);
    expect(item.writes).toHaveLength(1);
    expect(item.writes[0]).toMatchObject({ path: autoPath, expectedContent: autoBody });
    expect(activeAtSave).toEqual([0]);
    expect(await readKnowledgeReport(item.raw(autoPath))).toMatchObject({ current: true, result: { status: "incomplete" } });
    expect(await readKnowledgeAutoCheckAttempt(item.raw(autoPath))).toMatchObject({ current: true, runId: PASS });
    expect(item.raw(manualPath)).toBe(manualSaved);
    expect(item.store.knowledgeJobs[0]).toMatchObject({ state: "completed", recorded: true });
    expect(item.checkKnowledge).toHaveBeenCalledTimes(2);
  });

  it("rereads the configured Wiki before persistence and prevents an old task from writing after its scope changes", async () => {
    const item = fixture(), path = "wiki/page.md", backend = deferred<KnowledgeCheckResult>();
    item.put(path, "Original scope body");
    item.checkKnowledge.mockReturnValueOnce(backend.promise);
    await item.start();
    expect(item.checkKnowledge).toHaveBeenCalledTimes(1);
    // Change the saved config immediately before completion, without waiting for the poller to notice it.
    item.setWikiPath("docs/reference");
    backend.resolve(result(path, "Original scope body", "incomplete"));
    await advance();
    expect(item.store.knowledgeJobs[0]).toMatchObject({ state: "completed", recorded: false });
    expect(item.raw(path)).toBe("Original scope body");
    expect(await readKnowledgeAutoCheckAttempt(item.raw(path))).toBeUndefined();
    expect(await readKnowledgeReport(item.raw(path))).toBeUndefined();
    expect(item.writes).toHaveLength(0);
    expect(item.afterSave).not.toHaveBeenCalled();
    await advance(WIKI_AUTO_CHECK_POLL_MS + WIKI_AUTO_CHECK_SETTLE_MS + 250);
    expect(mocks.invoke).toHaveBeenCalledWith("list_wiki_check_directory", expect.objectContaining({ wikiPath: "docs/reference", path: "docs/reference" }));
    expect(item.checkKnowledge).toHaveBeenCalledTimes(1);
    expect(item.clearError).not.toHaveBeenCalled();
    expect(item.reportError).not.toHaveBeenCalled();
  });
});
