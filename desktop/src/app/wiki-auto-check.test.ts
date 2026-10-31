// @ts-expect-error Node crypto import in Vitest runner (frontend tsconfig omits Node globals)
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_KNOWLEDGE_DOCUMENT_CHARS, type KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";
import { KNOWLEDGE_STAMP_PREFIX, readKnowledgeAutoCheckAttempt, recordKnowledgeAutoCheckAttempt, recordKnowledgeCheck, stripKnowledgeCheckStamp } from "../../../acp/src/knowledge/stamp";
import type { ManualKnowledgeCheckInput, ProjectKnowledgeJob } from "./project-knowledge-queue.svelte";
import {
  createWikiAutoCheckScheduler, MAX_WIKI_AUTO_CHECK_RAW_BYTES,
  WIKI_AUTO_CHECK_POLL_MS, WIKI_AUTO_CHECK_SETTLE_MS,
  type WikiAutoCheckConfiguration, type WikiCheckInventoryPage, type WikiCheckInventoryRequest,
} from "./wiki-auto-check.svelte";

const PASS = "10000000-0000-4000-8000-000000000001";
const NEXT_PASS = "10000000-0000-4000-8000-000000000002";
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const legacyAttempt = (body: string) => body + "\n" + KNOWLEDGE_STAMP_PREFIX + JSON.stringify({
  version: 1, status: "attempted", runId: PASS, contentHash: digest(body), checkedAt: "2026-10-30T12:00:00.000Z",
}) + " -->\n";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const result = (path: string, content: string, status: "clear" | "incomplete" = "incomplete"): KnowledgeCheckResult => ({
  status, path, documentHash: digest(content), modelRef: "test/model", checkedSources: 1,
  reportLanguage: "ru", conflicts: [], notices: status === "incomplete" ? ["Охват неполный."] : [],
});

function fixture(inventoryLimit?: number) {
  let workspace = "/project";
  let config: WikiAutoCheckConfiguration = { enabled: true, wikiPath: "wiki", runId: PASS };
  let ready = true;
  let revision = 0, sequence = 0;
  const files = new Map<string, { content: string; revision: string; size: number }>();
  let jobs: ProjectKnowledgeJob[] = [];
  const put = (path: string, content: string, size = new TextEncoder().encode(content).byteLength) => {
    files.set(path, { content, size, revision: `revision-${++revision}` });
  };
  const readConfig = vi.fn(async (_workspace: string, _signal: AbortSignal) => config);
  const listDirectory = vi.fn(async (request: WikiCheckInventoryRequest, _signal: AbortSignal): Promise<WikiCheckInventoryPage> => {
    const children = new Map<string, WikiCheckInventoryPage["entries"][number]>();
    for (const [path, file] of files) {
      if (!path.startsWith(request.path + "/")) continue;
      const suffix = path.slice(request.path.length + 1), slash = suffix.indexOf("/");
      if (slash >= 0) {
        const directory = request.path + "/" + suffix.slice(0, slash);
        children.set(directory, { path: directory, kind: "directory" });
      } else children.set(path, { path, kind: "file", revision: file.revision, size: file.size });
    }
    return { entries: [...children.values()] };
  });
  const releaseInventory = vi.fn(async (_workspace: string, _cursor: string) => {});
  const readFile = vi.fn(async (_workspace: string, _wikiPath: string, path: string, _signal: AbortSignal) => {
    const file = files.get(path);
    if (!file) throw new Error("File no longer exists");
    return { path, content: file.content };
  });
  const enqueue = vi.fn((input: ManualKnowledgeCheckInput) => {
    const id = ++sequence;
    jobs = [...jobs, { ...input, id, workspace, state: "queued", createdAt: Date.now() }];
    return id;
  });
  const cancel = vi.fn((id: number) => { jobs = jobs.map(job => job.id === id ? { ...job, state: "cancelled" } : job); });
  const cancelQueuedBackground = vi.fn(() => {
    for (const job of jobs) if (job.state === "queued" && job.origin === "background") cancel(job.id);
  });
  const recordSkipped = vi.fn(async (input: { path: string; content: string; contentHash: string; runId: string }, current: () => boolean) => {
    const content = await recordKnowledgeAutoCheckAttempt(input.content, input.runId, input.contentHash);
    if (!current() || files.get(input.path)?.content !== input.content) return false;
    put(input.path, content);
    return true;
  });
  const reportError = vi.fn();
  const options = { workspace: () => workspace, readConfig, listDirectory, releaseInventory, readFile,
    jobs: () => jobs, enqueue, cancel, cancelQueuedBackground, recordSkipped, ready: () => ready, reportError, inventoryLimit };
  let scheduler = createWikiAutoCheckScheduler(options);
  return {
    get scheduler() { return scheduler; }, files, put, readConfig, listDirectory, releaseInventory,
    readFile, enqueue, cancel, cancelQueuedBackground, recordSkipped, reportError,
    get jobs() { return jobs; }, get config() { return config; },
    setConfig(next: Partial<WikiAutoCheckConfiguration>) { config = { ...config, ...next }; },
    setWorkspace(next: string) { workspace = next; },
    setReady(value: boolean) { ready = value; },
    run(id: number) { jobs = jobs.map(job => job.id === id ? { ...job, state: "running" } : job); },
    manual(path: string, content: string) { return enqueue({ path, content, expectedContent: content, persistStamp: true }); },
    async complete(id: number, status: "clear" | "incomplete" = "incomplete", persist = true) {
      const job = jobs.find(job => job.id === id)!;
      const checked = result(job.path, job.content, status);
      let recorded = false;
      if (persist && files.get(job.path)?.content === job.expectedContent) {
        let saved = await recordKnowledgeCheck(job.content, checked);
        const pass = config.enabled ? config.runId : job.autoCheckRunId;
        if (status !== "clear" && pass) saved = await recordKnowledgeAutoCheckAttempt(saved, pass, checked.documentHash);
        put(job.path, saved); recorded = true;
      }
      const done: ProjectKnowledgeJob = { ...job, state: "completed", result: checked, recorded, finishedAt: Date.now() };
      jobs = jobs.map(item => item.id === id ? done : item);
      scheduler.jobCompleted(done);
    },
    async fail(id: number) {
      const job = jobs.find(job => job.id === id)!;
      if (files.get(job.path)?.content === job.expectedContent) {
        put(job.path, await recordKnowledgeAutoCheckAttempt(job.expectedContent, (config.enabled ? config.runId : job.autoCheckRunId)!, digest(job.content)));
      }
      const done: ProjectKnowledgeJob = { ...job, state: "failed", error: "Judge unavailable", recorded: true };
      jobs = jobs.map(item => item.id === id ? done : item);
      scheduler.jobCompleted(done);
    },
    restart() {
      scheduler.dispose(); jobs = [];
      scheduler = createWikiAutoCheckScheduler(options); scheduler.start();
    },
  };
}

async function advance(ms = 0) { await vi.advanceTimersByTimeAsync(ms); }
async function begin(item: ReturnType<typeof fixture>) {
  item.scheduler.start();
  await advance();
  await advance(WIKI_AUTO_CHECK_SETTLE_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T12:00:00.000Z"));
  // Keep SHA-256 real while removing the worker-thread timing from fake-clock tests.
  vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(async (_algorithm, data) => {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer;
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("project-owned automatic Wiki checks", () => {
  it("skips current green files and resumes completed non-green versions from their inline pass marker", async () => {
    const item = fixture();
    item.put("wiki/green.md", await recordKnowledgeCheck("Green", result("wiki/green.md", "Green", "clear")));
    const yellow = await recordKnowledgeCheck("Yellow", result("wiki/yellow.md", "Yellow"));
    item.put("wiki/yellow.md", await recordKnowledgeAutoCheckAttempt(yellow, PASS, digest("Yellow")));
    item.put("wiki/nested/new.markdown", "New page");
    await begin(item);
    expect(item.enqueue).toHaveBeenCalledTimes(1);
    expect(item.jobs[0]).toMatchObject({ path: "wiki/nested/new.markdown", content: "New page", autoCheckRunId: PASS, origin: "background" });
    expect(item.scheduler.view).toMatchObject({ enabled: true, total: 2, completed: 1 });
    expect(item.listDirectory.mock.calls.map(([request]) => request.path)).toEqual(["wiki", "wiki/nested"]);
    item.scheduler.dispose();
  });

  it("detects new documents after startup, debounces writes, and captures their latest saved bytes", async () => {
    const item = fixture();
    await begin(item);
    expect(item.enqueue).not.toHaveBeenCalled();
    item.put("wiki/new.md", "First write");
    await advance(WIKI_AUTO_CHECK_POLL_MS - WIKI_AUTO_CHECK_SETTLE_MS);
    item.put("wiki/new.md", "Final write");
    item.scheduler.refresh(); await advance();
    await advance(WIKI_AUTO_CHECK_SETTLE_MS - 1);
    expect(item.enqueue).not.toHaveBeenCalled();
    await advance(1);
    expect(item.jobs[0]).toMatchObject({ content: "Final write", expectedContent: "Final write" });
    item.scheduler.dispose();
  });

  it("retries a legacy 48k oversized checkpoint once with chunking, without changing the saved pass", async () => {
    const item = fixture(), content = "Раздел.\n".repeat(6_750);
    expect(content).toHaveLength(54_000);
    item.put("wiki/long.md", legacyAttempt(content));
    await begin(item);
    expect(item.enqueue).toHaveBeenCalledTimes(1);
    expect(item.jobs[0]).toMatchObject({ path: "wiki/long.md", content, expectedContent: legacyAttempt(content), autoCheckRunId: PASS });
    expect(item.recordSkipped).not.toHaveBeenCalled();
    await item.complete(item.jobs[0]!.id);
    expect((await readKnowledgeAutoCheckAttempt(item.files.get("wiki/long.md")!.content))?.maxDocumentChars)
      .toBe(MAX_KNOWLEDGE_DOCUMENT_CHARS);
    await advance(WIKI_AUTO_CHECK_POLL_MS * 2);
    item.restart(); await advance(WIKI_AUTO_CHECK_SETTLE_MS);
    expect(item.enqueue).toHaveBeenCalledTimes(1);
    expect(item.config.runId).toBe(PASS);
    expect(item.reportError).not.toHaveBeenCalled();
    item.scheduler.dispose();
  });

  it("retains legacy checkpoints for bodies already covered by the old limit", async () => {
    const item = fixture();
    item.put("wiki/small.md", legacyAttempt("Small reviewed body"));
    await begin(item);
    expect(item.enqueue).not.toHaveBeenCalled();
    expect(item.scheduler.view).toMatchObject({ completed: 1, total: 1 });
    item.scheduler.dispose();
  });

  it("does not recheck its own report write or a terminal failed version, including after restart", async () => {
    const item = fixture(); item.put("wiki/page.md", "Page body");
    await begin(item);
    await item.complete(item.jobs[0]!.id);
    await advance(WIKI_AUTO_CHECK_POLL_MS * 3);
    expect(item.enqueue).toHaveBeenCalledTimes(1);
    const reads = item.readFile.mock.calls.length;
    await advance(WIKI_AUTO_CHECK_POLL_MS * 2);
    expect(item.readFile).toHaveBeenCalledTimes(reads);
    item.restart(); await advance(WIKI_AUTO_CHECK_SETTLE_MS);
    expect(item.enqueue).toHaveBeenCalledTimes(1);
    item.setConfig({ runId: NEXT_PASS }); item.scheduler.refresh(); await advance(WIKI_AUTO_CHECK_SETTLE_MS);
    expect(item.enqueue).toHaveBeenCalledTimes(2);
    await item.fail(item.jobs[0]!.id);
    item.restart(); await advance(WIKI_AUTO_CHECK_SETTLE_MS);
    expect(item.enqueue).toHaveBeenCalledTimes(2);
    expect(item.scheduler.view.completed).toBe(1);
    item.scheduler.dispose();
  });


  it.each(["manual", "previous pass"] as const)("resumes a %s duplicate completed with the current pass checkpoint", async kind => {
    const item = fixture(); item.put("wiki/page.md", "Page");
    if (kind === "manual") item.manual("wiki/page.md", "Page");
    await begin(item);
    const id = item.jobs[0]!.id; item.run(id);
    if (kind === "previous pass") {
      item.setConfig({ runId: NEXT_PASS }); item.scheduler.refresh(); await advance(WIKI_AUTO_CHECK_SETTLE_MS);
    }
    expect(item.enqueue).toHaveBeenCalledTimes(1);
    await item.complete(id);
    item.restart(); await advance(WIKI_AUTO_CHECK_SETTLE_MS);
    expect(item.enqueue).toHaveBeenCalledTimes(1);
    expect(item.scheduler.view.completed).toBe(1);
    item.scheduler.dispose();
  });

  it("resumes policy-cancelled waiting work while treating explicit cancellation as terminal", async () => {
    const item = fixture(); item.put("wiki/page.md", "Page"); await begin(item);
    const first = item.jobs[0]!.id;
    item.setConfig({ sourcesEnabled: false }); item.scheduler.refresh(); await advance();
    expect(item.jobs.find(job => job.id === first)?.state).toBe("cancelled");
    item.setConfig({ sourcesEnabled: true }); item.scheduler.refresh(); await advance();
    expect(item.enqueue).toHaveBeenCalledTimes(2);
    expect(item.jobs.at(-1)?.state).toBe("queued");
    item.scheduler.dispose();
  });

  it("keeps watching saved body changes after an incomplete result and ignores metadata-only changes", async () => {
    const item = fixture(); item.put("wiki/page.md", "Original body");
    await begin(item); await item.complete(item.jobs[0]!.id);
    const reportOnly = await recordKnowledgeCheck("Original body", { ...result("wiki/page.md", "Original body"), notices: ["Changed report prose"] });
    item.put("wiki/page.md", reportOnly);
    item.scheduler.refresh(); await advance(WIKI_AUTO_CHECK_SETTLE_MS);
    expect(item.enqueue).toHaveBeenCalledTimes(1);
    item.put("wiki/page.md", reportOnly.replace("Original body", "New body"));
    item.scheduler.refresh(); await advance(WIKI_AUTO_CHECK_SETTLE_MS);
    expect(item.enqueue).toHaveBeenCalledTimes(2);
    expect(item.jobs.at(-1)?.content).toBe("New body");
    item.scheduler.dispose();
  });

  it("uses one background slot and leaves room for a manual duplicate", async () => {
    const item = fixture(); item.put("wiki/one.md", "One"); item.put("wiki/two.md", "Two");
    const manual = item.manual("wiki/one.md", "One");
    await begin(item);
    expect(item.jobs.filter(job => job.origin === "background")).toHaveLength(1);
    expect(item.jobs.filter(job => job.path === "wiki/one.md")).toHaveLength(1);
    expect(item.scheduler.view.total).toBe(2);
    await item.complete(manual, "clear");
    await advance(WIKI_AUTO_CHECK_POLL_MS);
    expect(item.jobs.filter(job => job.path === "wiki/one.md")).toHaveLength(1);
    item.scheduler.dispose();
  });

  it("pauses judge work while disconnected and when the Knowledge source is disabled", async () => {
    const item = fixture(); item.put("wiki/page.md", "Page"); item.setReady(false);
    await begin(item); expect(item.enqueue).not.toHaveBeenCalled();
    item.setReady(true); item.setConfig({ sourcesEnabled: false }); item.scheduler.refresh(); await advance();
    const calls = item.listDirectory.mock.calls.length;
    await advance(WIKI_AUTO_CHECK_POLL_MS * 2);
    expect(item.enqueue).not.toHaveBeenCalled();
    expect(item.listDirectory).toHaveBeenCalledTimes(calls);
    expect(item.scheduler.view.error).toContain("Knowledge");
    expect(item.reportError).not.toHaveBeenCalled();
    item.setConfig({ sourcesEnabled: true }); item.scheduler.refresh(); await advance();
    expect(item.enqueue).toHaveBeenCalledTimes(1);
    item.scheduler.dispose();
  });

  it("keeps polling only config while off, and leaves the running check and manual work intact", async () => {
    const item = fixture(); item.setConfig({ enabled: false }); item.put("wiki/page.md", "Page");
    await begin(item); await advance(WIKI_AUTO_CHECK_POLL_MS * 2);
    expect(item.listDirectory).not.toHaveBeenCalled(); expect(item.readFile).not.toHaveBeenCalled();
    item.setConfig({ enabled: true }); await advance(WIKI_AUTO_CHECK_POLL_MS + WIKI_AUTO_CHECK_SETTLE_MS);
    const running = item.jobs[0]!.id; item.run(running);
    const manual = item.manual("wiki/manual.md", "Manual");
    item.setConfig({ enabled: false }); item.scheduler.refresh(); await advance();
    expect(item.jobs.find(job => job.id === running)?.state).toBe("running");
    expect(item.jobs.find(job => job.id === manual)?.state).toBe("queued");
    await item.complete(running);
    expect(item.scheduler.view.enabled).toBe(false);
    item.scheduler.dispose();
  });

  it("does not immediately requeue an explicitly cancelled unchanged version", async () => {
    const item = fixture(); item.put("wiki/page.md", "Page"); await begin(item);
    item.cancel(item.jobs[0]!.id);
    await advance(WIKI_AUTO_CHECK_POLL_MS * 3);
    expect(item.enqueue).toHaveBeenCalledTimes(1);
    item.put("wiki/page.md", "Changed"); item.scheduler.refresh(); await advance(WIKI_AUTO_CHECK_SETTLE_MS);
    expect(item.enqueue).toHaveBeenCalledTimes(2);
    item.scheduler.dispose();
  });

  it("cancels stale waiting snapshots and removed pages, but preserves a running old version until it settles", async () => {
    const item = fixture(); item.put("wiki/page.md", "Old"); await begin(item);
    const old = item.jobs[0]!.id;
    item.put("wiki/page.md", "Latest"); item.scheduler.refresh(); await advance(WIKI_AUTO_CHECK_SETTLE_MS);
    expect(item.jobs.find(job => job.id === old)?.state).toBe("cancelled");
    const latest = item.jobs.at(-1)!.id; item.run(latest);
    item.put("wiki/page.md", "Newer"); item.scheduler.refresh(); await advance(WIKI_AUTO_CHECK_SETTLE_MS);
    expect(item.enqueue).toHaveBeenCalledTimes(2);
    expect(item.jobs.find(job => job.id === latest)?.state).toBe("running");
    await item.complete(latest, "incomplete", false); await advance();
    expect(item.jobs.at(-1)?.content).toBe("Newer");
    const removed = item.jobs.at(-1)!.id; item.files.delete("wiki/page.md");
    item.scheduler.refresh(); await advance();
    expect(item.jobs.find(job => job.id === removed)?.state).toBe("cancelled");
    expect(item.scheduler.view.total).toBe(0);
    item.scheduler.dispose();
  });

  it("fences a late document read after project replacement, including a round trip to the same project", async () => {
    const item = fixture(), reading = deferred<{ path: string; content: string }>();
    item.put("wiki/old.md", "Old"); item.readFile.mockReturnValueOnce(reading.promise);
    await begin(item);
    expect(item.readFile).toHaveBeenCalledTimes(1);
    item.scheduler.reset(); item.setWorkspace("/other"); item.scheduler.start();
    item.scheduler.reset(); item.setWorkspace("/project"); item.files.clear(); item.put("wiki/new.md", "New"); item.scheduler.start();
    reading.resolve({ path: "wiki/old.md", content: "Old" });
    await advance(WIKI_AUTO_CHECK_SETTLE_MS);
    expect(item.enqueue.mock.calls.map(([input]) => input.path)).toEqual(["wiki/new.md"]);
    item.scheduler.dispose();
  });

  it("releases late native cursors and consumes empty pages without losing later entries", async () => {
    const item = fixture(), page = deferred<WikiCheckInventoryPage>(), released = deferred<void>();
    item.listDirectory.mockReturnValueOnce(page.promise);
    item.releaseInventory.mockReturnValueOnce(released.promise);
    item.scheduler.start(); await advance();
    item.scheduler.reset();
    page.resolve({ entries: [], nextCursor: "late-cursor" }); await advance();
    expect(item.releaseInventory).toHaveBeenCalledExactlyOnceWith("/project", "late-cursor");
    item.put("wiki/page.md", "Page");
    item.listDirectory.mockResolvedValueOnce({ entries: [], nextCursor: "next-page" });
    item.scheduler.start(); await advance(WIKI_AUTO_CHECK_SETTLE_MS);
    expect(item.listDirectory.mock.calls.at(-1)?.[0]).toMatchObject({ path: "wiki", cursor: "next-page" });
    expect(item.enqueue).toHaveBeenCalledTimes(1);
    released.reject(new Error("An old cursor already expired")); await advance();
    expect(item.reportError).not.toHaveBeenCalled();
    expect(item.scheduler.view.error).toBeUndefined();
    item.scheduler.dispose();
  });

  it("does not prune unseen files after an incomplete inventory and never accepts an out-of-Wiki path", async () => {
    const item = fixture(); item.put("wiki/page.md", "Page"); await begin(item);
    const id = item.jobs[0]!.id;
    item.listDirectory.mockRejectedValueOnce(new Error("Directory changed during paging"));
    item.scheduler.refresh(); await advance();
    expect(item.jobs.find(job => job.id === id)?.state).toBe("queued");
    item.listDirectory.mockResolvedValueOnce({ entries: [{ path: "other/secret.md", kind: "file", size: 6, revision: "bad" }] });
    item.scheduler.refresh(); await advance();
    expect(item.readFile.mock.calls.every(([, , path]) => path.startsWith("wiki/"))).toBe(true);
    expect(item.enqueue).toHaveBeenCalledTimes(1);
    expect(item.reportError).toHaveBeenCalledTimes(2);
    item.scheduler.refresh(); await advance();
    expect(item.scheduler.view.error).toBeUndefined();
    item.scheduler.dispose();
  });

  it("recovers at the inventory cap after every old document is replaced or renamed", async () => {
    const item = fixture(3);
    for (const name of ["a", "b", "c"]) item.put(`wiki/old-${name}.md`, name);
    await begin(item);
    const running = item.jobs[0]!.id; item.run(running);
    item.files.clear();
    for (const name of ["a", "b", "c"]) item.put(`wiki/new-${name}.md`, "new " + name);
    item.scheduler.refresh(); await advance(WIKI_AUTO_CHECK_SETTLE_MS);
    expect(item.scheduler.view.total).toBe(3);
    expect(item.scheduler.view.error).toBeUndefined();
    expect(item.jobs.find(job => job.id === running)?.state).toBe("running");
    await item.complete(running, "incomplete", false);
    await advance(WIKI_AUTO_CHECK_POLL_MS);
    expect(item.jobs.at(-1)?.path).toMatch(/^wiki\/new-/u);
    expect(item.reportError).not.toHaveBeenCalled();
    item.scheduler.dispose();
  });

  it("clears an inventory-limit warning when the Wiki returns within its budget", async () => {
    const item = fixture(3);
    for (const name of ["a", "b", "c", "d"]) item.put(`wiki/${name}.md`, name);
    await begin(item);
    expect(item.scheduler.view.error).toContain("3-file limit");
    item.files.delete("wiki/d.md"); item.scheduler.refresh(); await advance();
    expect(item.scheduler.view.error).toBeUndefined();
    expect(item.scheduler.view.total).toBe(3);
    item.scheduler.dispose();
  });

  it("records an oversize logical version once, and never reads a raw file beyond the bounded budget", async () => {
    const item = fixture();
    item.put("wiki/long.md", "x".repeat(MAX_KNOWLEDGE_DOCUMENT_CHARS + 1));
    item.put("wiki/huge.md", "Do not read", MAX_WIKI_AUTO_CHECK_RAW_BYTES + 1);
    await begin(item);
    expect(item.enqueue).not.toHaveBeenCalled();
    expect(item.readFile.mock.calls.map(([, , path]) => path)).toEqual(["wiki/long.md"]);
    expect(item.recordSkipped).toHaveBeenCalledTimes(1);
    expect(item.reportError.mock.calls.some(([error]) => error instanceof Error
      && error.message.includes(`${MAX_KNOWLEDGE_DOCUMENT_CHARS.toLocaleString("en-US")}-character`))).toBe(true);
    expect(stripKnowledgeCheckStamp(item.files.get("wiki/long.md")!.content)).toHaveLength(MAX_KNOWLEDGE_DOCUMENT_CHARS + 1);
    await advance(WIKI_AUTO_CHECK_POLL_MS * 2);
    expect(item.recordSkipped).toHaveBeenCalledTimes(1);
    item.restart(); await advance(WIKI_AUTO_CHECK_SETTLE_MS);
    expect(item.recordSkipped).toHaveBeenCalledTimes(1);
    expect(item.enqueue).not.toHaveBeenCalled();
    item.scheduler.dispose();
  });

  it("stops native work, timers and scheduling after disposal even when an operation ignores abort", async () => {
    const item = fixture(), configuration = deferred<WikiAutoCheckConfiguration>();
    item.readConfig.mockReturnValueOnce(configuration.promise);
    item.scheduler.start(); await advance(); item.scheduler.dispose();
    configuration.resolve({ enabled: true, wikiPath: "wiki", runId: PASS });
    await advance(WIKI_AUTO_CHECK_POLL_MS * 3);
    expect(item.readConfig).toHaveBeenCalledTimes(1);
    expect(item.listDirectory).not.toHaveBeenCalled(); expect(item.enqueue).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
