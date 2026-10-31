import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WikiCheckDirectoryPage, WikiCheckInventoryRequest } from "../lib/wiki-check-inventory";
import type { WikiPageFinding } from "../lib/wiki-conflicts-index";
import type { WikiConsistencyClassification, WikiConsistencyStatus } from "../lib/wiki-consistency-tree";
import { createWikiConsistencyTreeState, WIKI_TREE_STATUS_SETTLE_MS } from "./wiki-consistency-tree-state.svelte";

const states = new Set<ReturnType<typeof createWikiConsistencyTreeState>>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(inventoryLimit?: number) {
  let workspace = "/project", wikiPath = "wiki", sequence = 0;
  const files = new Map<string, { workspace: string; path: string; content: string; revision: string; size: number }>();
  const unreadable = new Set<string>();
  const blockedDirectories = new Set<string>();
  const key = (path: string, target = workspace) => target + "\0" + path;
  const findingsByRevision = new Map<string, readonly WikiPageFinding[]>();
  const put = (path: string, status: WikiConsistencyStatus, size?: number, findings?: readonly WikiPageFinding[]) => {
    const revision = `revision-${++sequence}`, content = status + "\n" + path + "\n" + revision;
    if (findings) findingsByRevision.set(revision, findings);
    files.set(key(path), { workspace, path, content, revision, size: size ?? new TextEncoder().encode(content).byteLength });
  };
  const listDirectory = vi.fn(async (request: WikiCheckInventoryRequest, _signal: AbortSignal): Promise<WikiCheckDirectoryPage> => {
    if (blockedDirectories.has(request.path)) throw new Error("Directory unavailable: " + request.path);
    const children = new Map<string, WikiCheckDirectoryPage["entries"][number]>();
    for (const file of files.values()) {
      if (file.workspace !== request.workspace || !file.path.startsWith(request.path + "/")) continue;
      const suffix = file.path.slice(request.path.length + 1), separator = suffix.indexOf("/");
      if (separator >= 0) {
        const path = request.path + "/" + suffix.slice(0, separator);
        children.set(path, { path, kind: "directory" });
      } else children.set(file.path, { path: file.path, kind: "file", revision: file.revision, size: file.size });
    }
    const entries = [...children.values()], offset = Number(request.cursor ?? 0), end = offset + 64;
    return { entries: entries.slice(offset, end), ...(end < entries.length ? { nextCursor: String(end) } : {}) };
  });
  const readFile = vi.fn(async (target: string, _wikiPath: string, path: string, _signal: AbortSignal) => {
    const file = files.get(key(path, target));
    if (!file || unreadable.has(key(path, target))) throw new Error("Read failed: " + path);
    return { path, content: file.content };
  });
  const classify = vi.fn(async (content: string, _path: string): Promise<WikiConsistencyClassification> => {
    const [status, , revision] = content.split("\n");
    return { status: status as WikiConsistencyStatus, findings: findingsByRevision.get(revision!) ?? [] };
  });
  const releaseInventory = vi.fn(async (_workspace: string, _cursor: string) => {});
  const reportError = vi.fn();
  const state = createWikiConsistencyTreeState({ workspace: () => workspace, wikiPath: () => wikiPath,
    listDirectory, readFile, classify, releaseInventory, reportError, inventoryLimit });
  states.add(state);
  return {
    state, files, unreadable, blockedDirectories, key, put, listDirectory, readFile, classify, releaseInventory, reportError,
    get workspace() { return workspace; }, get wikiPath() { return wikiPath; },
    setWorkspace(value: string) { workspace = value; }, setWikiPath(value: string) { wikiPath = value; },
    remove(path: string) { files.delete(key(path)); },
  };
}

const advance = (ms = 0) => vi.advanceTimersByTimeAsync(ms);
async function refresh(item: ReturnType<typeof fixture>) {
  item.state.refresh();
  await vi.runAllTimersAsync();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T12:00:00.000Z"));
});
afterEach(() => {
  for (const state of states) state.dispose();
  states.clear();
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe("mounted Wiki consistency discovery", () => {
  it("counts the root index and closed nested sections before allowing a recursive green folder", async () => {
    const item = fixture();
    item.put("wiki/index.md", "clear");
    item.put("wiki/combat/index.md", "clear");
    item.put("wiki/combat/cover/rules.markdown", "clear");
    item.state.refresh();
    await advance();
    expect(item.state.summary("")).toMatchObject({ status: "unknown", documents: 3, unknown: 3 });
    expect(item.readFile).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(item.state.summary("")).toEqual({ status: "clear", documents: 3, clear: 3, conflicts: 0, unknown: 0, accepted: 0, complete: true });
    expect(item.state.summary("combat")).toMatchObject({ status: "clear", documents: 2 });
    expect(item.state.summary("combat/cover")).toMatchObject({ status: "clear", documents: 1 });
    expect(item.listDirectory.mock.calls.map(([request]) => request.path)).toEqual(["wiki", "wiki/combat", "wiki/combat/cover"]);
    expect(item.readFile.mock.calls.map(([, , path]) => path)).toContain("wiki/index.md");
  });

  it("uses only metadata for warm refreshes and does not classify unchanged bodies again", async () => {
    const item = fixture();
    for (let number = 0; number < 160; number++) item.put(`wiki/pages/page-${number}.md`, "clear");
    await refresh(item);
    expect(item.state.summary("")).toMatchObject({ status: "clear", documents: 160 });
    expect(item.readFile).toHaveBeenCalledTimes(160);
    expect(item.classify).toHaveBeenCalledTimes(160);
    const listings = item.listDirectory.mock.calls.length;
    await refresh(item);
    await refresh(item);
    expect(item.listDirectory.mock.calls.length).toBeGreaterThan(listings);
    expect(item.readFile).toHaveBeenCalledTimes(160);
    expect(item.classify).toHaveBeenCalledTimes(160);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("neutralizes changed metadata immediately, then publishes only the latest saved status", async () => {
    const item = fixture(), pending = deferred<WikiConsistencyClassification>();
    item.put("wiki/combat/rules.md", "clear");
    item.put("wiki/world/rules.md", "clear");
    await refresh(item);
    item.put("wiki/combat/rules.md", "conflicts");
    item.classify.mockImplementationOnce(() => pending.promise);
    item.state.refresh();
    await advance();
    expect(item.state.summary("combat")).toMatchObject({ status: "unknown", unknown: 1, clear: 0 });
    expect(item.state.summary("world").status).toBe("clear");
    expect(item.readFile).toHaveBeenCalledTimes(2);
    await advance(WIKI_TREE_STATUS_SETTLE_MS);
    expect(item.state.summary("combat").status).toBe("unknown");
    pending.resolve({ status: "conflicts", findings: [] });
    await advance();
    expect(item.state.summary("")).toMatchObject({ status: "conflicts", conflicts: 1, clear: 1 });
    item.put("wiki/combat/rules.md", "clear");
    item.state.refresh();
    await advance();
    expect(item.state.summary("combat").status).toBe("unknown");
    await vi.runAllTimersAsync();
    expect(item.state.summary("")).toMatchObject({ status: "clear", clear: 2, conflicts: 0 });
    expect(item.readFile).toHaveBeenCalledTimes(4);
  });

  it("prunes deleted and renamed descendants, removing cached red from their old parents", async () => {
    const item = fixture();
    item.put("wiki/old/deep/conflict.md", "conflicts");
    item.put("wiki/old/index.md", "clear");
    await refresh(item);
    expect(item.state.summary("old").status).toBe("conflicts");
    item.remove("wiki/old/deep/conflict.md");
    item.put("wiki/new/renamed.md", "unknown");
    await refresh(item);
    expect(item.state.summary("old")).toMatchObject({ status: "clear", documents: 1, conflicts: 0 });
    expect(item.state.summary("old/deep")).toMatchObject({ status: "unknown", documents: 0 });
    expect(item.state.summary("new")).toMatchObject({ status: "unknown", documents: 1, unknown: 1 });
    expect(item.state.summary("")).toMatchObject({ status: "unknown", documents: 2, conflicts: 0 });
    item.remove("wiki/old/index.md"); item.remove("wiki/new/renamed.md");
    await refresh(item);
    expect(item.state.summary("")).toMatchObject({ status: "unknown", documents: 0, complete: true });
  });

  it("keeps unreadable, oversized and unreviewed documents neutral, retrying a transient failure only on refresh", async () => {
    const item = fixture();
    item.put("wiki/unreadable.md", "clear");
    item.unreadable.add(item.key("wiki/unreadable.md"));
    item.put("wiki/oversized.md", "clear", 1_000_000);
    item.put("wiki/unreviewed.md", "unknown");
    await refresh(item);
    expect(item.state.summary("")).toMatchObject({ status: "unknown", documents: 3, unknown: 3, complete: true });
    expect(item.readFile.mock.calls.map(([, , path]) => path)).toEqual(["wiki/unreadable.md", "wiki/unreviewed.md"]);
    expect(item.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "Read failed: wiki/unreadable.md" }));
    const reads = item.readFile.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000);
    expect(item.readFile).toHaveBeenCalledTimes(reads);
    // Recovery must not require a revision change when only the reader failed.
    item.unreadable.delete(item.key("wiki/unreadable.md"));
    await refresh(item);
    expect(item.state.summary("")).toMatchObject({ status: "unknown", clear: 1, unknown: 2 });
    expect(item.readFile).toHaveBeenCalledTimes(reads + 1);
    await refresh(item);
    expect(item.readFile).toHaveBeenCalledTimes(reads + 1);
  });

  it("withholds all folder greens after a root listing failure, retains known red, and recovers", async () => {
    const item = fixture();
    item.put("wiki/red.md", "conflicts");
    item.put("wiki/green/rules.md", "clear");
    await refresh(item);
    expect(item.state.summary("green").status).toBe("clear");
    item.listDirectory.mockRejectedValueOnce(new Error("Directory unavailable"));
    await refresh(item);
    expect(item.state.summary("")).toMatchObject({ status: "conflicts", conflicts: 1, complete: false });
    expect(item.state.summary("green")).toMatchObject({ status: "unknown", clear: 1, complete: false });
    expect(item.state.summary("green/rules.md").status).toBe("clear");
    expect(item.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "Directory unavailable" }));
    await refresh(item);
    expect(item.state.summary("green")).toMatchObject({ status: "clear", complete: true });
    expect(item.readFile).toHaveBeenCalledTimes(2);
  });

  it("continues after a failed sibling and grants green only to completely discovered branches", async () => {
    const item = fixture();
    item.put("wiki/broken/index.md", "clear");
    item.put("wiki/good/index.md", "clear");
    item.put("wiki/good/deep/rules.md", "clear");
    item.blockedDirectories.add("wiki/broken");
    await refresh(item);
    expect(item.listDirectory.mock.calls.map(([request]) => request.path)).toEqual([
      "wiki", "wiki/broken", "wiki/good", "wiki/good/deep",
    ]);
    expect(item.state.summary("good")).toMatchObject({ status: "clear", documents: 2, complete: true });
    expect(item.state.summary("good/deep")).toMatchObject({ status: "clear", documents: 1, complete: true });
    expect(item.state.summary("broken")).toMatchObject({ status: "unknown", complete: false });
    expect(item.state.summary("")).toMatchObject({ status: "unknown", documents: 2, clear: 2, complete: false });
    expect(item.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: "Directory unavailable: wiki/broken" }));
    expect(vi.getTimerCount()).toBe(0);
    item.blockedDirectories.clear();
    await refresh(item);
    expect(item.state.summary("broken")).toMatchObject({ status: "clear", documents: 1, complete: true });
    expect(item.state.summary("")).toMatchObject({ status: "clear", documents: 3, complete: true });
    expect(item.readFile).toHaveBeenCalledTimes(3);
  });

  it("retains cached conflicts under an unreadable branch while discovering and pruning independent siblings", async () => {
    const item = fixture();
    item.put("wiki/broken/index.md", "clear");
    item.put("wiki/broken/deep/issue.md", "conflicts");
    item.put("wiki/good/old.md", "clear");
    await refresh(item);
    item.remove("wiki/broken/deep/issue.md");
    item.remove("wiki/good/old.md");
    item.put("wiki/good/new.md", "clear");
    item.blockedDirectories.add("wiki/broken");
    await refresh(item);
    expect(item.state.summary("good")).toMatchObject({ status: "clear", documents: 1, complete: true });
    expect(item.state.summary("good/old.md").documents).toBe(0);
    expect(item.state.summary("broken")).toMatchObject({ status: "conflicts", documents: 2, complete: false });
    expect(item.state.summary("broken/deep")).toMatchObject({ status: "conflicts", documents: 1, complete: false });
    expect(item.state.summary("")).toMatchObject({ status: "conflicts", conflicts: 1, complete: false });
    item.blockedDirectories.clear();
    await refresh(item);
    expect(item.state.summary("broken/deep").documents).toBe(0);
    expect(item.state.summary("broken")).toMatchObject({ status: "clear", documents: 1, complete: true });
    expect(item.state.summary("")).toMatchObject({ status: "clear", documents: 2, complete: true });
  });

  it("excludes dot-prefixed files and directories from traversal, reads and recursive counts", async () => {
    const item = fixture();
    item.put("wiki/index.md", "clear");
    item.put("wiki/section/page.md", "clear");
    item.put("wiki/.hidden.md", "conflicts");
    item.put("wiki/.pi/artifacts/issue.md", "conflicts");
    item.put("wiki/section/.draft.md", "conflicts");
    item.put("wiki/section/.private/issue.md", "conflicts");
    item.blockedDirectories.add("wiki/.pi/artifacts");
    await refresh(item);
    expect(item.listDirectory.mock.calls.map(([request]) => request.path)).toEqual(["wiki", "wiki/section"]);
    expect(item.readFile.mock.calls.map(([, , path]) => path)).toEqual(["wiki/index.md", "wiki/section/page.md"]);
    expect(item.state.summary("")).toMatchObject({ status: "clear", documents: 2, complete: true });
    expect(item.state.summary("section")).toMatchObject({ status: "clear", documents: 1, complete: true });
    expect(item.reportError).not.toHaveBeenCalled();
  });

  it("keeps a branch neutral when only its hidden index page has no successful check", async () => {
    const item = fixture();
    item.put("wiki/architecture/index.md", "unknown");
    item.put("wiki/architecture/contract.md", "clear");
    await refresh(item);
    expect(item.state.summary("architecture")).toMatchObject({ status: "unknown", documents: 2, clear: 1, unknown: 1, complete: true });
    expect(item.state.summary("architecture/contract.md").status).toBe("clear");
    item.put("wiki/architecture/index.md", "clear");
    await refresh(item);
    expect(item.state.summary("architecture")).toMatchObject({ status: "clear", documents: 2, complete: true });
  });

  it("recovers from a file cap and from replacing the entire full old inventory with new paths", async () => {
    const item = fixture(3);
    for (let number = 0; number < 4; number++) item.put(`wiki/old/page-${number}.md`, "clear");
    await refresh(item);
    expect(item.state.summary("")).toMatchObject({ status: "unknown", documents: 3, clear: 3, complete: false });
    expect(item.reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("3 документов") }));
    item.remove("wiki/old/page-3.md");
    await refresh(item);
    expect(item.state.summary("")).toMatchObject({ status: "clear", documents: 3, complete: true });
    for (let number = 0; number < 3; number++) {
      item.remove(`wiki/old/page-${number}.md`);
      item.put(`wiki/new/page-${number}.md`, "clear");
    }
    await refresh(item);
    expect(item.state.summary("old")).toMatchObject({ status: "unknown", documents: 0 });
    expect(item.state.summary("new")).toMatchObject({ status: "clear", documents: 3, complete: true });
    expect(item.state.summary("")).toMatchObject({ status: "clear", documents: 3, clear: 3 });
    expect(item.readFile).toHaveBeenCalledTimes(6);
  });

  it("retains unvisited red at the cache limit and recovers after authoritative deletion", async () => {
    const item = fixture(2);
    item.put("wiki/broken/first.md", "conflicts");
    item.put("wiki/broken/second.md", "conflicts");
    await refresh(item);
    item.put("wiki/good/first.md", "clear");
    item.put("wiki/good/second.md", "clear");
    item.blockedDirectories.add("wiki/broken");
    await refresh(item);
    expect(item.state.summary("broken")).toMatchObject({ status: "conflicts", documents: 2, conflicts: 2, complete: false });
    expect(item.state.summary("good")).toMatchObject({ status: "unknown", complete: false });
    expect(item.state.summary("")).toMatchObject({ status: "conflicts", documents: 2, complete: false });
    expect(item.readFile).toHaveBeenCalledTimes(2);
    item.remove("wiki/broken/first.md"); item.remove("wiki/broken/second.md");
    item.blockedDirectories.clear();
    await refresh(item);
    expect(item.state.summary("broken").documents).toBe(0);
    expect(item.state.summary("")).toMatchObject({ status: "unknown", complete: false });
    await refresh(item);
    expect(item.state.summary("")).toMatchObject({ status: "clear", documents: 2, complete: true });
    expect(item.readFile).toHaveBeenCalledTimes(4);
  });

  it("coalesces repeated refreshes without overlapping directory requests or restarting pending work", async () => {
    const item = fixture(), pending = deferred<WikiCheckDirectoryPage>();
    item.put("wiki/page.md", "clear");
    const list = item.listDirectory.getMockImplementation()!;
    let active = 0, peak = 0;
    item.listDirectory.mockImplementationOnce(async () => {
      active++; peak = Math.max(peak, active);
      try { return await pending.promise; } finally { active--; }
    });
    for (let count = 0; count < 10; count++) item.state.refresh();
    await advance();
    expect(item.listDirectory).toHaveBeenCalledTimes(1);
    for (let count = 0; count < 10; count++) item.state.refresh();
    await advance(1_000);
    expect(item.listDirectory).toHaveBeenCalledTimes(1);
    pending.resolve(await list({ workspace: "/project", wikiPath: "wiki", path: "wiki" }, new AbortController().signal));
    await vi.runAllTimersAsync();
    expect(item.state.summary("").status).toBe("clear");
    expect(item.readFile).toHaveBeenCalledTimes(1);
    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["project", "Wiki root"] as const)("releases a stale page cursor across an abort-ignoring %s A→B→A switch", async (scope) => {
    const item = fixture(), pending = deferred<WikiCheckDirectoryPage>();
    item.put("wiki/page.md", "conflicts");
    item.listDirectory.mockImplementationOnce(() => pending.promise);
    item.state.refresh();
    await advance();
    const oldSignal = item.listDirectory.mock.calls[0]![1];
    if (scope === "project") item.setWorkspace("/other");
    else item.setWikiPath("docs/reference");
    item.put(item.wikiPath + "/other.md", "clear");
    await refresh(item);
    expect(oldSignal.aborted).toBe(true);
    if (scope === "project") item.setWorkspace("/project");
    else item.setWikiPath("wiki");
    item.put("wiki/page.md", "clear");
    await refresh(item);
    expect(item.state.summary("")).toMatchObject({ status: "clear", documents: 1 });
    item.releaseInventory.mockRejectedValueOnce(new Error("Old cursor already closed"));
    pending.resolve({ entries: [], nextCursor: "late-old-cursor" });
    await advance();
    expect(item.releaseInventory).toHaveBeenCalledExactlyOnceWith("/project", "late-old-cursor");
    expect(item.state.summary("")).toMatchObject({ status: "clear", documents: 1 });
    expect(item.reportError).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an obsolete asynchronous classification when its project identity is reused", async () => {
    const item = fixture(), pending = deferred<WikiConsistencyClassification>();
    item.put("wiki/page.md", "conflicts");
    item.classify.mockImplementationOnce(() => pending.promise);
    item.state.refresh();
    await advance(WIKI_TREE_STATUS_SETTLE_MS);
    expect(item.classify).toHaveBeenCalledTimes(1);
    item.setWorkspace("/other"); item.put("wiki/other.md", "clear");
    await refresh(item);
    item.setWorkspace("/project"); item.put("wiki/page.md", "clear");
    await refresh(item);
    const before = item.state.summary("");
    expect(before).toMatchObject({ status: "clear", documents: 1, conflicts: 0 });
    pending.resolve({ status: "conflicts", findings: [] });
    await advance();
    expect(item.state.summary("")).toEqual(before);
    expect(item.classify).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes timers and pending reads without publishing or scheduling late work", async () => {
    const timer = fixture();
    timer.put("wiki/not-read.md", "clear");
    timer.state.refresh();
    await advance();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    timer.state.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await advance(10_000);
    expect(timer.readFile).not.toHaveBeenCalled();

    const item = fixture(), pending = deferred<{ path: string; content: string }>();
    item.put("wiki/pending.md", "clear");
    item.readFile.mockImplementationOnce(() => pending.promise);
    item.state.refresh();
    await advance(WIKI_TREE_STATUS_SETTLE_MS);
    expect(item.readFile).toHaveBeenCalledTimes(1);
    const signal = item.readFile.mock.calls[0]![3];
    item.state.dispose();
    expect(signal.aborted).toBe(true);
    pending.resolve({ path: "wiki/pending.md", content: "conflicts\nlate response" });
    await advance(10_000);
    item.state.refresh();
    expect(item.classify).not.toHaveBeenCalled();
    expect(item.state.summary("")).toMatchObject({ status: "unknown", documents: 0, complete: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});

function finding(id: string, reportPath: string, other = "wiki/other.md"): WikiPageFinding {
  return {
    id, kind: "conflict", internal: other === reportPath,
    draft: { path: reportPath, startLine: 1, endLine: 1, quote: `draft ${id}` },
    existing: { path: other, startLine: 2, endLine: 2, quote: `existing ${id}` },
    explanation: "differs", reportPath, checkedAt: "2026-10-30T11:00:00.000Z", current: true, modelRef: "test/model",
  } as WikiPageFinding;
}

describe("Wiki findings projection", () => {
  it("publishes merged findings once discovery and reads complete, memoized per version", async () => {
    const item = fixture();
    item.put("wiki/a.md", "conflicts", undefined, [finding("shared", "wiki/a.md", "wiki/b.md")]);
    item.put("wiki/b.md", "conflicts", undefined, [finding("shared", "wiki/b.md", "wiki/a.md"), finding("own", "wiki/b.md", "wiki/b.md")]);
    item.put("wiki/c.md", "clear");
    item.state.refresh();
    await advance();
    expect(item.state.findings()).toMatchObject({ findings: [], complete: false });
    await vi.runAllTimersAsync();
    const snapshot = item.state.findings();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.findings.map(entry => [entry.id, entry.reportPaths])).toEqual(expect.arrayContaining([
      ["shared", ["wiki/a.md", "wiki/b.md"]], ["own", ["wiki/b.md"]],
    ]));
    expect(snapshot.findings).toHaveLength(2);
    expect(item.state.findings()).toBe(snapshot);
  });

  it("drops a page's findings when it changes, is deleted, or the project changes", async () => {
    const item = fixture();
    item.put("wiki/a.md", "conflicts", undefined, [finding("first", "wiki/a.md")]);
    item.put("wiki/b.md", "conflicts", undefined, [finding("second", "wiki/b.md")]);
    await refresh(item);
    expect(item.state.findings().findings.map(entry => entry.id).sort()).toEqual(["first", "second"]);

    item.put("wiki/a.md", "clear");
    item.state.refresh();
    await advance();
    // Changed metadata immediately withdraws the previous body's findings.
    expect(item.state.findings().findings.map(entry => entry.id)).toEqual(["second"]);
    await vi.runAllTimersAsync();
    expect(item.state.findings().findings.map(entry => entry.id)).toEqual(["second"]);

    item.remove("wiki/b.md");
    await refresh(item);
    expect(item.state.findings()).toMatchObject({ findings: [], complete: true });

    item.put("wiki/b.md", "conflicts", undefined, [finding("third", "wiki/b.md")]);
    await refresh(item);
    expect(item.state.findings().findings).toHaveLength(1);
    item.setWorkspace("/other");
    item.state.refresh();
    expect(item.state.findings()).toMatchObject({ findings: [], complete: false });
    await vi.runAllTimersAsync();
    expect(item.state.findings().findings).toEqual([]);
  });

  it("ignores findings from an obsolete classification and clears them on dispose", async () => {
    const item = fixture(), pending = deferred<WikiConsistencyClassification>();
    item.put("wiki/a.md", "conflicts", undefined, [finding("kept", "wiki/a.md")]);
    await refresh(item);
    item.put("wiki/a.md", "conflicts");
    item.classify.mockImplementationOnce(() => pending.promise);
    item.state.refresh();
    await advance(WIKI_TREE_STATUS_SETTLE_MS);
    expect(item.classify).toHaveBeenCalledTimes(2);
    // Reusing the same project identity must not resurrect the obsolete result.
    item.setWorkspace("/other");
    await refresh(item);
    item.setWorkspace("/project"); item.put("wiki/a.md", "clear");
    await refresh(item);
    pending.resolve({ status: "conflicts", findings: [finding("late", "wiki/a.md")] });
    await vi.runAllTimersAsync();
    expect(item.state.findings().findings).toEqual([]);
    expect(item.state.summary("")).toMatchObject({ status: "clear" });

    item.put("wiki/a.md", "conflicts", undefined, [finding("again", "wiki/a.md")]);
    await refresh(item);
    expect(item.state.findings().findings).toHaveLength(1);
    item.state.dispose();
    expect(item.state.findings()).toMatchObject({ findings: [], complete: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
