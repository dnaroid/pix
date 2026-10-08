import { describe, expect, it, vi } from "vitest";
import type { SearchQueryResponse, SearchSetting } from "../../../acp/src/search/contract";
import type { CommitSearchResponse } from "../../../acp/src/search/contract";
import type { ProjectTaskDocument } from "./project-tasks";
import { parseIndexSearch, queryUniversalSearch, type SearchSources, type UnifiedSearchResult } from "./universal-search";
import { SEARCH_SOURCE_TIMEOUT_MS } from "./search-source-deadline";
import { emptySearchDialogState, SearchDialogController } from "./search-dialog-controller";

const settings: SearchSetting[] = [{ id: "theme", section: "appearance", label: "Theme", description: "Color scheme", synonyms: ["dark"] }];
const status = { enabled: false, keyAvailable: false, indexing: false };
const header = (path: string, domain = "code", score = "0.75") => `${path}:2-5 (score: ${score}, rank=hybrid, domain=${domain}, why=semantic)`;
function sources(available = true): SearchSources {
  return {
    overview: vi.fn(async () => ({ available, initialized: available, rawStatus: "", errors: [] })),
    index: vi.fn(async (_workspace, query) => ({ stdout: header(query.kind === "code" ? "src/app.ts" : "specs/app.md", query.kind === "code" ? "code" : "document"), stderr: "", exitCode: 0, truncated: false })),
    local: vi.fn(async () => ({ status, results: [{ kind: "sessions" as const, id: "sessions:1", sessionId: "session", title: "Theme discussion", snippet: "", score: 0.4 }] })),
  };
}

describe("universal hybrid search", () => {
  it("finishes an empty successful search without failure notices", async () => {
    const api = sources();
    api.local = vi.fn(async () => ({ status, results: [] }));
    const result = await queryUniversalSearch(api, "/empty", "nothing", ["sessions"], settings, new AbortController().signal);
    expect(result.results).toEqual([]);
    expect(result.notices).toEqual([]);
  });
  it("publishes fast hits immediately and appends both late IDX domains after initial waiting ends", async () => {
    vi.useFakeTimers();
    let finish!: (value: Awaited<ReturnType<SearchSources["index"]>>) => void;
    const api = sources();
    api.index = vi.fn(() => new Promise<Awaited<ReturnType<SearchSources["index"]>>>(resolve => { finish = resolve; }));
    let view = emptySearchDialogState();
    const controller = new SearchDialogController(
      (query, types, signal, update) => queryUniversalSearch(api, "/hung-idx", query, types, settings, signal, update),
      undefined, state => { view = state; },
    );
    try {
      const pending = controller.submit("theme", ["sessions", "code", "knowledge"]);
      await vi.advanceTimersByTimeAsync(SEARCH_SOURCE_TIMEOUT_MS - 1);
      expect(view.busy).toBe(true);
      expect(view.result.results.map(hit => hit.kind)).toEqual(["sessions"]);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(view.busy).toBe(false);
      expect(view.submitted).toBe(true);
      const result = view.result;
      expect(result.results.map(hit => hit.kind)).toEqual(["sessions"]);
      expect(result.notices).toEqual([expect.stringContaining("IDX) search is taking longer")]);
      expect(result.pendingSources).toEqual(["Code / Knowledge (IDX)"]);
      expect(api.index).toHaveBeenCalledTimes(1);
      const published = JSON.stringify(result);
      finish({ stdout: header("src/late.ts"), stderr: "", exitCode: 0, truncated: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.stringify(result)).toBe(published);
      expect(view.result.results.map(hit => hit.kind)).toContain("code");
      expect(api.index).toHaveBeenCalledTimes(2);
      finish({ stdout: header("specs/late.md", "document"), stderr: "", exitCode: 0, truncated: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(view.result.results.map(hit => hit.kind).sort()).toEqual(["code", "knowledge", "sessions"]);
      expect(view.result.notices).toEqual([]);
      expect(view.result.pendingSources).toBeUndefined();
      expect(view.busy).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { controller.dispose(); vi.useRealTimers(); }
  });
  it("applies one shared deadline to both IDX domains and retains completed code hits", async () => {
    vi.useFakeTimers();
    const api = sources();
    api.index = vi.fn(async (_workspace, query) => {
      if (query.kind === "code") {
        await new Promise(resolve => setTimeout(resolve, 15_000));
        return { stdout: header("src/theme.ts"), stderr: "", exitCode: 0, truncated: false };
      }
      return new Promise<never>(() => {});
    });
    const controller = new AbortController();
    const update = vi.fn();
    try {
      const pending = queryUniversalSearch(api, "/two-domains", "theme", ["code", "knowledge"], settings, controller.signal, update);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(update.mock.lastCall?.[0].results.map((hit: { kind: string }) => hit.kind)).toEqual(["code"]);
      await vi.advanceTimersByTimeAsync(SEARCH_SOURCE_TIMEOUT_MS - 15_000);
      const result = await pending;
      expect(result.results.map(hit => hit.kind)).toEqual(["code"]);
      expect(api.index).toHaveBeenCalledTimes(2);
      expect(result.notices).toEqual([expect.stringContaining("taking longer")]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { controller.abort(); vi.useRealTimers(); }
  });
  it("adds late task metadata through fresh snapshots without mutating published hits", async () => {
    vi.useFakeTimers();
    let finish!: (tasks: ProjectTaskDocument) => void;
    const api = sources();
    api.tasks = vi.fn(() => new Promise<ProjectTaskDocument>(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const update = vi.fn();
    try {
      const pending = queryUniversalSearch(api, "/late-tasks", "theme", ["tasks"], settings, controller.signal, update);
      await vi.advanceTimersByTimeAsync(SEARCH_SOURCE_TIMEOUT_MS);
      const result = await pending;
      const published = JSON.stringify(result);
      finish({ version: 1, tasks: [{ id: "late", title: "Theme late", status: "todo", type: "feature", priority: "medium", createdAt: "2026-10-08T00:00:00Z", updatedAt: "2026-10-08T00:00:00Z" }] });
      await vi.advanceTimersByTimeAsync(0);
      expect(JSON.stringify(result)).toBe(published);
      expect(result.results).toEqual([]);
      expect(result.notices).toEqual([expect.stringContaining("Tasks search is taking longer")]);
      expect(update.mock.lastCall?.[0].results[0].taskId).toBe("late");
      expect(update.mock.lastCall?.[0].notices).toEqual([]);
      expect(update.mock.lastCall?.[0].pendingSources).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally { controller.abort(); vi.useRealTimers(); }
  });
  it("replaces authored settings fallback and adds late session titles when their source completes", async () => {
    vi.useFakeTimers();
    const api = sources(), controller = new AbortController(), update = vi.fn();
    let finish!: (value: SearchQueryResponse) => void;
    api.local = vi.fn(() => new Promise<SearchQueryResponse>(resolve => { finish = resolve; }));
    try {
      const initial = queryUniversalSearch(api, "/late-local", "dark", ["settings", "sessions"], settings, controller.signal, update);
      await vi.advanceTimersByTimeAsync(SEARCH_SOURCE_TIMEOUT_MS);
      const partial = await initial;
      expect(partial.results.map(hit => hit.kind)).toEqual(["settings"]);
      finish({ results: [
        { kind: "settings", id: "settings:theme", title: "Theme", snippet: "dark", score: 1, section: "desktop", fieldId: "theme" },
        { kind: "sessions", id: "sessions:late-local", title: "Dark mode", snippet: "", score: 1, sessionId: "late-local" },
      ], status: { enabled: false, keyAvailable: false, indexing: false } });
      await vi.advanceTimersByTimeAsync(0);
      const final = update.mock.lastCall?.[0] as UnifiedSearchResult;
      expect(final.results.map(hit => hit.kind).sort()).toEqual(["sessions", "settings"]);
      expect(final.results.filter(hit => hit.kind === "settings")).toHaveLength(1);
      expect(final.notices).toEqual([]);
      expect(final.pendingSources).toBeUndefined();
      expect(partial.results.map(hit => hit.kind)).toEqual(["settings"]);
    } finally { controller.abort(); vi.useRealTimers(); }
  });

  it("adds late commits and removes only that source's pending notice", async () => {
    vi.useFakeTimers();
    const api = sources(), controller = new AbortController(), update = vi.fn();
    let finish!: (value: Awaited<ReturnType<NonNullable<SearchSources["commits"]>>>) => void;
    api.commits = vi.fn(() => new Promise<Awaited<ReturnType<NonNullable<SearchSources["commits"]>>>>(resolve => { finish = resolve; }));
    api.tasks = vi.fn(async () => { throw new Error("task source failed"); });
    try {
      const initial = queryUniversalSearch(api, "/late-commits", "theme", ["tasks", "commits"], settings, controller.signal, update);
      await vi.advanceTimersByTimeAsync(SEARCH_SOURCE_TIMEOUT_MS);
      const partial = await initial;
      expect(partial.pendingSources).toEqual(["Commits"]);
      finish([{ hash: "a".repeat(40), shortHash: "aaaaaaa", subject: "Theme cleanup", author: "Developer", date: "2026-10-08" }]);
      await vi.advanceTimersByTimeAsync(0);
      const final = update.mock.lastCall?.[0] as UnifiedSearchResult;
      expect(final.results.map(hit => hit.kind)).toEqual(["commits"]);
      expect(final.notices).toEqual([expect.stringContaining("Tasks search failed")]);
      expect(final.pendingSources).toBeUndefined();
      expect(partial.results).toEqual([]);
    } finally { controller.abort(); vi.useRealTimers(); }
  });

  it("bounds hung overview and backend requests, retaining authored settings fallback", async () => {
    vi.useFakeTimers();
    const api = sources();
    api.overview = vi.fn(() => new Promise<never>(() => {}));
    api.local = vi.fn(() => new Promise<never>(() => {}));
    const controller = new AbortController();
    try {
      const pending = queryUniversalSearch(api, "/hung-overview", "dark", ["settings", "sessions", "code"], settings, controller.signal);
      await vi.advanceTimersByTimeAsync(SEARCH_SOURCE_TIMEOUT_MS);
      const result = await pending;
      expect(result.results.map(hit => hit.kind)).toEqual(["settings"]);
      expect(result.notices).toHaveLength(2);
      expect(result.notices.every(notice => notice.includes("taking longer"))).toBe(true);
      expect(api.index).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { controller.abort(); vi.useRealTimers(); }
  });
  it("returns promptly on cancellation even when metadata ignores abort", async () => {
    vi.useFakeTimers();
    const api = sources();
    api.tasks = vi.fn(() => new Promise<never>(() => {}));
    const controller = new AbortController();
    try {
      const pending = queryUniversalSearch(api, "/hung-tasks", "theme", ["tasks"], settings, controller.signal);
      controller.abort();
      const result = await pending;
      expect(result.results).toEqual([]);
      expect(result.notices).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("ranks pi SDK titles globally rather than cycling through noisy source winners", async () => {
    const api = sources();
    api.local = vi.fn(async () => ({ status, results: [
      { kind: "settings" as const, id: "settings:theme", fieldId: "theme", section: "appearance", title: "Theme", snippet: "", score: 99 },
      { kind: "sessions" as const, id: "sessions:sdk", sessionId: "sdk", title: "Обновление pi SDK", snippet: "", score: 0.1 },
    ] }));
    api.tasks = vi.fn(async (): Promise<ProjectTaskDocument> => ({ version: 1, tasks: [{ id: "1", title: "Pix assistant", type: "feature", status: "done", priority: "low", createdAt: "2026-01-01", updatedAt: "2026-01-01" }] }));
    api.commits = vi.fn(async () => [{ hash: "a".repeat(40), shortHash: "aaaaaaa", subject: "Fix pi quota", author: "A", date: "2026-01-01" }]);
    const result = await queryUniversalSearch(api, "/project", "обновилась pi sdk", ["settings", "sessions", "tasks", "commits", "code", "knowledge"], settings, new AbortController().signal);
    expect(result.results.map(hit => hit.kind)).toEqual(["sessions", "code", "knowledge"]);
    expect(result.results[0]?.title).toBe("Обновление pi SDK");
  });
  it("retains local Tasks/Commits lookup when no hybrid backend is connected", async () => {
    const api = sources();
    api.tasks = vi.fn(async (): Promise<ProjectTaskDocument> => ({ version: 1, tasks: [{ id: "1", title: "Theme task", type: "feature", status: "done", priority: "low", createdAt: "2026-01-01", updatedAt: "2026-01-01" }] }));
    api.commits = vi.fn(async () => [{ hash: "a".repeat(40), shortHash: "aaaaaaa", subject: "Theme commit", author: "A", date: "2026-01-01" }]);
    const result = await queryUniversalSearch(api, "/project", "theme", ["tasks", "commits"], settings, new AbortController().signal);
    expect(result.results.map(hit => hit.kind)).toEqual(["tasks", "commits"]);
    expect(api.tasks).toHaveBeenCalledWith("/project");
    expect(api.commits).toHaveBeenCalledWith("/project", "theme");
    expect(api.local).not.toHaveBeenCalled();
    expect(api.overview).not.toHaveBeenCalled();
    expect(api.index).not.toHaveBeenCalled();
  });
  it("gates extra sources and retains other results on independent failures", async () => {
    const api = sources();
    api.tasks = vi.fn(async () => { throw new Error("Malformed task file"); });
    api.commits = vi.fn(async () => { throw new Error("Not a Git repository"); });
    api.commitHybrid = vi.fn(async () => ({ results: [], notices: [] }));
    await queryUniversalSearch(api, "/project", "theme", ["sessions"], settings, new AbortController().signal);
    expect(api.tasks).not.toHaveBeenCalled();
    expect(api.commits).not.toHaveBeenCalled();
    expect(api.commitHybrid).not.toHaveBeenCalled();
    const result = await queryUniversalSearch(api, "/project", "theme", ["sessions", "tasks", "commits"], settings, new AbortController().signal);
    expect(result.results.map(hit => hit.kind)).toEqual(["sessions"]);
    expect(result.notices).toEqual(["Tasks search failed: Malformed task file", "Commits search failed: Not a Git repository"]);
  });
  it("appends semantic-only commits after the initial wait and prefers hybrid metadata on duplicate hits", async () => {
    vi.useFakeTimers();
    try {
      const api = sources();
      const commit = { hash: "a".repeat(40), shortHash: "aaaaaaa", subject: "Restore backups", author: "A", date: "2026-01-01" };
      const related = { ...commit, hash: "b".repeat(40), shortHash: "bbbbbbb", subject: "Recover archived snapshots" };
      api.commits = vi.fn(async () => [commit]);
      let finish!: (response: Awaited<ReturnType<NonNullable<SearchSources["commitHybrid"]>>>) => void;
      api.commitHybrid = vi.fn(() => new Promise<CommitSearchResponse>(resolve => { finish = resolve; }));
      const updates: UnifiedSearchResult[] = [];
      const run = queryUniversalSearch(api, "/project", "restore backups", ["commits"], settings, new AbortController().signal, value => updates.push(value));
      await vi.advanceTimersByTimeAsync(0);
      expect(updates.at(-1)?.results.map(hit => hit.id)).toEqual([`commits:${commit.hash}`]);
      await vi.advanceTimersByTimeAsync(SEARCH_SOURCE_TIMEOUT_MS);
      const initial = await run;
      expect(initial.pendingSources).toEqual(["Semantic commits"]);
      finish({ results: [commit, related].map(value => ({ kind: "commits", id: `commits:${value.hash}`, title: value.subject, snippet: value.author, score: 1, hash: value.hash, commit: value, semantic: true })), notices: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(updates.at(-1)?.results.map(hit => hit.id)).toEqual([`commits:${commit.hash}`, `commits:${related.hash}`]);
      expect(updates.at(-1)?.results[0]).toHaveProperty("semantic", true);
      expect(updates.at(-1)?.pendingSources).toBeUndefined();
      expect(initial.results).toHaveLength(1);
      expect(api.commitHybrid).toHaveBeenCalledWith("/project", "restore backups", expect.any(AbortSignal));
      expect(api.local).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it("keeps local commit hits on controlled semantic failure and suppresses cancelled updates", async () => {
    const api = sources();
    api.commits = vi.fn(async () => [{ hash: "a".repeat(40), shortHash: "aaaaaaa", subject: "Theme commit", author: "A", date: "2026-01-01" }]);
    api.commitHybrid = vi.fn(async () => { throw new Error("Bearer PRIVATE provider error"); });
    const result = await queryUniversalSearch(api, "/project", "theme", ["commits"], settings, new AbortController().signal);
    expect(result.results).toHaveLength(1);
    expect(result.notices).toEqual(["Semantic commit search unavailable; local commit search remains available."]);
    const controller = new AbortController();
    let finish!: (response: Awaited<ReturnType<NonNullable<SearchSources["commitHybrid"]>>>) => void;
    api.commitHybrid = vi.fn(() => new Promise<CommitSearchResponse>(resolve => { finish = resolve; }));
    const updates: UnifiedSearchResult[] = [];
    const run = queryUniversalSearch(api, "/project", "theme", ["commits"], settings, controller.signal, value => updates.push(value));
    await vi.waitFor(() => expect(api.commitHybrid).toHaveBeenCalled());
    controller.abort();
    await run;
    const count = updates.length;
    finish({ results: [], notices: ["stale"] });
    await Promise.resolve();
    expect(updates).toHaveLength(count);
  });
  it("discards late metadata results after cancellation", async () => {
    const api = sources();
    const controller = new AbortController();
    api.tasks = vi.fn(async (): Promise<ProjectTaskDocument> => { controller.abort(); return { version: 1, tasks: [] }; });
    api.commits = vi.fn(async () => { throw new Error("late failure"); });
    const result = await queryUniversalSearch(api, "/project", "theme", ["tasks", "commits"], settings, controller.signal);
    expect(result.results).toEqual([]);
    expect(result.notices).toEqual([]);
  });
  it("accepts only matching formatter headers and safe relative ranges", () => {
    const output = [header("src/a.ts"), header("src/a.ts"), header("/etc/passwd"), header("../secret"), header("C:\\secret"), header("src/a.ts", "document"), "src/fake.ts:1-2", header("src/b.ts").replace(":2-5", ":5-2")].join("\n");
    expect(parseIndexSearch(output, "code").map(hit => hit.path)).toEqual(["src/a.ts"]);
    expect(parseIndexSearch(header("specs/a.md", "document"), "knowledge")[0]?.startLine).toBe(2);
  });
  it("extracts bounded IDX content and never parses header-shaped content as a separate hit", () => {
    const output = [
      header("src/real.ts"), "Content: 3 lines", "export function autocomplete() {", header("src/forged.ts"), "}",
      header("src/second.ts"), "Content: 0 lines",
    ].join("\n");
    const results = parseIndexSearch(output, "code");
    expect(results.map(hit => hit.path)).toEqual(["src/real.ts", "src/second.ts"]);
    expect(results[0]?.content).toContain("autocomplete()");
    expect(results[0]?.snippet).toContain("autocomplete()");
    expect(results[1]?.content).toBeUndefined();
    const knowledge = parseIndexSearch([header("specs/desktop-autocomplete.md", "document"), "  kind=spec status=active provenance=explicit/explicit", "Content: 1 lines", "# Desktop autocomplete"].join("\n"), "knowledge");
    expect(knowledge[0]?.content).toBe("# Desktop autocomplete");
  });
  it("gates IDX on both installation and initialization, retaining local results", async () => {
    for (const overview of [{ available: false, initialized: true }, { available: true, initialized: false }]) {
      const api = sources();
      api.overview = vi.fn(async () => ({ ...overview, rawStatus: "", errors: [] }));
      const result = await queryUniversalSearch(api, "/project", "theme", ["sessions", "code", "knowledge"], settings, new AbortController().signal);
      expect(api.index).not.toHaveBeenCalled();
      expect(result.results[0]?.kind).toBe("sessions");
      expect(result.notices).toHaveLength(1);
    }
  });
  it("uses hybrid code queries and ranks title matches before opaque IDX matches", async () => {
    const api = sources();
    const result = await queryUniversalSearch(api, "/project", "theme", ["sessions", "code", "knowledge"], settings, new AbortController().signal);
    expect(api.index).toHaveBeenCalledWith("/project", { kind: "code", query: "theme", mode: "hybrid", maxFiles: 15, includeContent: true });
    expect(api.index).toHaveBeenCalledWith("/project", { kind: "knowledge", query: "theme", limit: 15, includeContent: true });
    expect(result.results.map(hit => hit.kind)).toEqual(["sessions", "code", "knowledge"]);
  });
  it("searches IDX with the canonical technical term and treats empty Code results as a normal outcome", async () => {
    const api = sources();
    api.local = vi.fn(async () => ({ status: { enabled: true, keyAvailable: true, indexing: false }, results: [] }));
    api.index = vi.fn(async (_workspace, request) => ({
      stdout: request.kind === "code" ? "WARN no-results suggestion='try broader query or lower --min-score'" : header("specs/desktop-autocomplete.md", "document"),
      stderr: "", exitCode: 0, truncated: false,
    }));
    const result = await queryUniversalSearch(api, "/project", "как работает авто-пополнение?", ["settings", "code", "knowledge"], settings, new AbortController().signal);
    expect(api.local).toHaveBeenCalledWith(expect.objectContaining({ query: "как работает авто-пополнение?" }), expect.any(AbortSignal));
    expect(api.index).toHaveBeenCalledWith("/project", expect.objectContaining({ kind: "code", query: "autocomplete" }));
    expect(api.index).toHaveBeenCalledWith("/project", expect.objectContaining({ kind: "knowledge", query: "autocomplete" }));
    expect(result.results.map(hit => hit.title)).toEqual(["specs/desktop-autocomplete.md"]);
    expect(result.notices).toEqual([]);
  });
  it("shows bounded, redacted hybrid fallback warnings while retaining results", async () => {
    const api = sources();
    api.index = vi.fn(async () => ({
      stdout: [header("src/a.ts"), "WARN vector storage unavailable; using lexical results.", `WARN provider failed: Bearer private-token OPENROUTER_API_KEY=private-key ${"x".repeat(800)}`, ...Array(10).fill("WARN another warning")].join("\n"),
      stderr: "", exitCode: 0, truncated: false,
    }));
    const result = await queryUniversalSearch(api, "/project", "theme", ["sessions", "code"], settings, new AbortController().signal);
    expect(result.results.map(hit => hit.kind)).toEqual(["sessions", "code"]);
    expect(result.notices).toHaveLength(5);
    expect(result.notices[0]).toBe("Code: WARN vector storage unavailable; using lexical results.");
    expect(result.notices[1]).toContain("Bearer [redacted] OPENROUTER_API_KEY=[redacted]");
    expect(result.notices[1]!.length).toBeLessThan(650);
    expect(result.notices.join(" ")).not.toMatch(/private-token|private-key/u);
  });
  it("fails independently and uses authored metadata offline", async () => {
    const api = sources();
    api.local = vi.fn(async () => { throw new Error("disconnected"); });
    api.index = vi.fn(async (_workspace, query) => {
      if (query.kind === "code") throw new Error("broken IDX");
      return { stdout: header("specs/a.md", "document"), stderr: "", exitCode: 0, truncated: false };
    });
    const result = await queryUniversalSearch(api, "/project", "dark", ["settings", "sessions", "code", "knowledge"], settings, new AbortController().signal);
    expect(result.results.map(hit => hit.kind)).toEqual(["settings", "knowledge"]);
    expect(result.notices).toEqual([
      "Settings / Sessions search failed: disconnected",
      "Code search failed: broken IDX",
    ]);
  });
  it("distinguishes a missing connection from an RPC failure", async () => {
    const api = sources();
    delete api.local;
    const offline = await queryUniversalSearch(api, "/project", "dark", ["settings", "sessions"], settings, new AbortController().signal);
    expect(offline.results[0]?.kind).toBe("settings");
    expect(offline.notices).toEqual(["Session title search is unavailable: no backend connection is available to search."]);
    api.local = vi.fn(async () => { throw new Error("Method not found: pix/search/query"); });
    const failed = await queryUniversalSearch(api, "/project", "dark", ["settings", "sessions"], settings, new AbortController().signal);
    expect(failed.results[0]?.kind).toBe("settings");
    expect(failed.notices).toEqual(["Settings / Sessions search failed: Method not found: pix/search/query"]);
    expect(failed.notices.join(" ")).not.toContain("disconnected");
  });
  it("reports settings-only RPC failures while retaining metadata fallback", async () => {
    const api = sources();
    api.local = vi.fn(async () => { throw "Search service unavailable"; });
    const result = await queryUniversalSearch(api, "/project", "dark", ["settings"], settings, new AbortController().signal);
    expect(result.results[0]?.kind).toBe("settings");
    expect(result.notices).toEqual(["Settings search failed: Search service unavailable"]);
  });
  it("retains IDX exit codes and stderr, falling back to stdout", async () => {
    const api = sources();
    api.index = vi.fn(async (_workspace, query) => ({
      stdout: query.kind === "code" ? "ignored stdout" : "snapshot missing",
      stderr: query.kind === "code" ? "error: unknown option --domain" : "",
      exitCode: 2, truncated: false,
    }));
    const result = await queryUniversalSearch(api, "/project", "theme", ["sessions", "code", "knowledge"], settings, new AbortController().signal);
    expect(result.results[0]?.kind).toBe("sessions");
    expect(result.notices).toEqual([
      "Code search failed: IDX failed with exit code 2: error: unknown option --domain",
      "Knowledge search failed: IDX failed with exit code 2: snapshot missing",
    ]);
  });
  it("reports Tauri rejection strings and IDX overview failures", async () => {
    const api = sources();
    api.index = vi.fn(async () => { throw "Command idx_query not found"; });
    let result = await queryUniversalSearch(api, "/project", "theme", ["code"], settings, new AbortController().signal);
    expect(result.notices).toEqual(["Code search failed: Command idx_query not found"]);
    api.overview = vi.fn(async () => { throw new Error("IDX executable not found"); });
    result = await queryUniversalSearch(api, "/project", "theme", ["code"], settings, new AbortController().signal);
    expect(result.notices).toEqual(["Could not check this project's IDX index: IDX executable not found"]);
    api.overview = vi.fn(async () => ({ available: false, initialized: false, rawStatus: "", errors: ["IDX launcher unavailable"] }));
    result = await queryUniversalSearch(api, "/project", "theme", ["code"], settings, new AbortController().signal);
    expect(result.notices).toContain("IDX: IDX launcher unavailable");
  });
  it("bounds diagnostics and redacts common credentials", async () => {
    const api = sources();
    api.local = vi.fn(async () => { throw new Error(`\u001b[31mProvider failed\u001b[0m\nBearer private-token sk-or-v1-secret OPENROUTER_API_KEY=private-key ${"x".repeat(800)}`); });
    const result = await queryUniversalSearch(api, "/project", "theme", ["sessions"], settings, new AbortController().signal);
    const notice = result.notices[0]!;
    expect(notice).toContain("Provider failed Bearer [redacted] [redacted] OPENROUTER_API_KEY=[redacted]");
    expect(notice).not.toMatch(/private-token|sk-or-v1-secret|private-key|\u001b/u);
    expect(notice.length).toBeLessThan(650);
    expect(notice.endsWith("…")).toBe(true);
  });
  it("reports persistent IDX contention without deleting locks or dropping local results", async () => {
    const api = sources();
    api.index = vi.fn(async () => ({ stdout: "", stderr: "Search failed: Lock file is already being held", exitCode: 1, truncated: false }));
    const result = await queryUniversalSearch(api, "/busy", "theme", ["sessions", "code"], settings, new AbortController().signal);
    expect(api.index).toHaveBeenCalledTimes(3);
    expect(result.results[0]?.kind).toBe("sessions");
    expect(result.notices).toEqual(["Code search is temporarily unavailable: IDX is busy. Try Search again shortly."]);
  });
  it("does not publish request failure notices after cancellation", async () => {
    const api = sources();
    const controller = new AbortController();
    api.local = vi.fn(async () => { controller.abort(); throw new Error("request canceled"); });
    const result = await queryUniversalSearch(api, "/project", "theme", ["sessions", "code"], settings, controller.signal);
    expect(result.results).toEqual([]);
    expect(result.notices).toEqual([]);
  });
  it("does not run IDX for local-only filters or publish canceled results", async () => {
    const api = sources();
    await queryUniversalSearch(api, "/project", "theme", ["settings"], settings, new AbortController().signal);
    expect(api.overview).not.toHaveBeenCalled();
    const controller = new AbortController();
    api.overview = vi.fn(async () => { controller.abort(); return { available: true, initialized: true, rawStatus: "", errors: [] }; });
    const result = await queryUniversalSearch(api, "/project", "theme", ["sessions", "code"], settings, controller.signal);
    expect(api.index).not.toHaveBeenCalled();
    expect(result.results).toEqual([]);
  });
});
