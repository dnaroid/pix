import { describe, expect, it, vi } from "vitest";
import type { KnowledgeCitation } from "../../../acp/src/knowledge/contract";
import type { WikiFinding } from "../lib/wiki-conflicts-index";
import type { WikiFileDates, WikiFileDatesRequest } from "../lib/wiki-file-dates";
import { createWikiConflictCompare } from "./wiki-conflict-compare.svelte";

const citation = (path: string, quote: string, startLine = 1, endLine = startLine): KnowledgeCitation => ({ path, quote, startLine, endLine });
const finding = (id: string, extra: Partial<WikiFinding> = {}): WikiFinding => ({
  id, kind: "conflict", internal: false,
  draft: citation("wiki/a.md", "Claim A."), existing: citation("wiki/b.md", "Claim B.", 3),
  explanation: "Rules differ.", reportPath: "wiki/a.md", checkedAt: "2026-10-30T00:00:00.000Z",
  current: true, modelRef: "test/judge", reportPaths: ["wiki/a.md"], stale: false, decisionPartial: false, ...extra,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe("Wiki conflict comparison reads", () => {
  it("drops late responses after fast switching and aborts the superseded read", async () => {
    const reads = new Map<string, { pending: ReturnType<typeof deferred<string>>; signal: AbortSignal }>();
    const read = vi.fn((path: string, signal: AbortSignal) => {
      const pending = deferred<string>();
      reads.set(path, { pending, signal });
      return pending.promise;
    });
    const compare = createWikiConflictCompare({ read, reportError: vi.fn() });
    compare.select(finding("first"));
    compare.select(finding("second", { draft: citation("wiki/c.md", "Claim C."), existing: citation("wiki/d.md", "Claim D.") }));
    expect(reads.get("wiki/a.md")!.signal.aborted).toBe(true);
    expect(reads.get("wiki/c.md")!.signal.aborted).toBe(false);
    reads.get("wiki/c.md")!.pending.resolve("Claim C.");
    reads.get("wiki/d.md")!.pending.resolve("changed");
    reads.get("wiki/a.md")!.pending.resolve("Claim A.");
    reads.get("wiki/b.md")!.pending.resolve("Claim B.");
    await flush();
    const draft = compare.draft;
    expect(draft.state === "ready" && draft.context.status === "matched" && draft.context.quote).toBe("Claim C.");
    expect(compare.existing).toEqual({ state: "ready", context: { status: "missing" } });
  });

  it("reads a shared path once for an internal finding and reports one failure", async () => {
    const reportError = vi.fn();
    const read = vi.fn(async () => { throw new Error("denied"); });
    const compare = createWikiConflictCompare({ read, reportError });
    compare.select(finding("internal", { internal: true, existing: citation("wiki/a.md", "Claim A2.") }));
    await flush();
    expect(read).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledOnce();
    expect(compare.draft).toEqual({ state: "error", message: "denied" });
    expect(compare.existing).toEqual({ state: "error", message: "denied" });
  });

  it("keeps ready context while re-reading the same finding and publishes nothing after dispose", async () => {
    let content = "Claim A.\nClaim B.";
    const read = vi.fn(async () => content);
    const compare = createWikiConflictCompare({ read, reportError: vi.fn() });
    compare.select(finding("same"));
    await flush();
    expect(compare.draft.state).toBe("ready");
    compare.select(finding("same"));
    expect(compare.draft.state).toBe("ready");
    compare.dispose();
    content = "changed";
    await flush();
    expect(compare.draft).toMatchObject({ state: "ready", context: { status: "matched" } });
    compare.select(finding("other"));
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("does not read escaping or non-Markdown citation paths", async () => {
    const read = vi.fn(async () => "");
    const compare = createWikiConflictCompare({ read, reportError: vi.fn() });
    compare.select(finding("bad", { draft: citation("../secret.md", "x"), existing: citation("wiki/b.txt", "y") }));
    await flush();
    expect(read).not.toHaveBeenCalled();
    expect(compare.draft).toEqual({ state: "ready", context: { status: "invalid" } });
    expect(compare.existing).toEqual({ state: "ready", context: { status: "invalid" } });
  });

  it("loads side dates after the read, with raw quote lines, and drops dates of a superseded finding", async () => {
    const pending = new Map<string, ReturnType<typeof deferred<WikiFileDates | null>>>();
    const dates = vi.fn((request: WikiFileDatesRequest) => {
      const result = deferred<WikiFileDates | null>();
      pending.set(request.path, result);
      return result.promise;
    });
    const read = vi.fn(async (path: string) => path === "wiki/a.md" ? "Intro.\n\nClaim A." : "Claim B.");
    const compare = createWikiConflictCompare({ read, reportError: vi.fn(), dates });
    compare.select(finding("first"));
    await flush();
    expect(dates).toHaveBeenCalledWith({ path: "wiki/a.md", lines: { startLine: 3, endLine: 3 } }, expect.any(AbortSignal));
    expect(compare.draftDates).toBeNull();
    const known: WikiFileDates = { createdAt: 1, committedAt: 2, modifiedAt: 3, uncommitted: false, linesCommittedAt: 2, linesUncommitted: false, tracked: true };
    pending.get("wiki/a.md")!.resolve(known);
    await flush();
    expect(compare.draftDates).toEqual(known);
    compare.select(finding("second", { existing: citation("wiki/c.md", "Claim C.") }));
    expect(compare.draftDates).toBeNull();
    pending.get("wiki/b.md")!.resolve(known);
    await flush();
    expect(compare.existingDates).toBeNull();
  });

  it("treats a failing dates loader as unknown dates, not a comparison error", async () => {
    const reportError = vi.fn();
    const compare = createWikiConflictCompare({ read: async () => "Claim A.\nClaim B.", reportError, dates: async () => { throw new Error("git"); } });
    compare.select(finding("dates"));
    await flush();
    expect(compare.draft).toMatchObject({ state: "ready", context: { status: "matched" } });
    expect(compare.draftDates).toBeNull();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("exposes the raw quote block of a matched side and reloads the same finding", async () => {
    let content = "Intro.\n\nClaim A.";
    const read = vi.fn(async (path: string) => path === "wiki/a.md" ? content : "Claim B.");
    const compare = createWikiConflictCompare({ read, reportError: vi.fn() });
    compare.select(finding("edit"));
    await flush();
    expect(compare.draft).toMatchObject({ state: "ready", block: { startLine: 3, endLine: 3, text: "Claim A." } });
    content = "Intro.\n\nClaim A.\nMore.";
    compare.reload();
    expect(compare.draft.state).toBe("ready");
    await flush();
    expect(read).toHaveBeenCalledTimes(4);
    expect(compare.draft).toMatchObject({ block: { startLine: 3, endLine: 4, text: "Claim A.\nMore." } });
    compare.dispose();
    compare.reload();
    expect(read).toHaveBeenCalledTimes(4);
  });
});
