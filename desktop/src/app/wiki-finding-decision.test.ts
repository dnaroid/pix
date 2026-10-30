import { describe, expect, it, vi } from "vitest";
import type { KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";
import { readKnowledgeReport, recordKnowledgeCheck, stripKnowledgeCheckStamp } from "../../../acp/src/knowledge/stamp";
import { mergeWikiFindings, projectWikiPageFindings, wikiFindingStatus, type WikiFinding } from "../lib/wiki-conflicts-index";
import { createWikiFindingDecider, decideWikiFinding, type WikiFindingUndoOffer } from "./wiki-finding-decision";

const date = "2026-10-30T12:00:00.000Z";
const now = () => new Date("2026-10-30T13:00:00.000Z");
const a = "wiki/a.md", b = "wiki/b.md";
const bodyA = "# A\nУ бойца 6 очков действия.\n";
const bodyB = "# B\nУ бойца 4 очка действия.\n";
const sideA = { path: a, quote: "У бойца 6 очков действия.", startLine: 2, endLine: 2 };
const sideB = { path: b, quote: "У бойца 4 очка действия.", startLine: 2, endLine: 2 };

async function hash(content: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function report(path: string, body: string, draft = sideA, existing = sideB): Promise<string> {
  const result: KnowledgeCheckResult = {
    status: "conflicts", path, documentHash: await hash(body), modelRef: "test/judge", reportLanguage: "ru", checkedSources: 1,
    conflicts: [{ draft, existing, explanation: "Разные значения." }], notices: [],
  };
  return recordKnowledgeCheck(body, result, date);
}

async function project(files: Map<string, string>): Promise<WikiFinding> {
  const pages = [];
  for (const [path, content] of files) pages.push(await projectWikiPageFindings((await readKnowledgeReport(content))!, path));
  return mergeWikiFindings(pages).findings[0]!;
}

function store(files: Map<string, string>, fail = new Set<string>()) {
  return {
    read: vi.fn(async (path: string) => files.get(path)!),
    write: vi.fn(async (path: string, content: string, expected: string) => {
      if (fail.has(path) || files.get(path) !== expected) return false;
      files.set(path, content);
      return true;
    }),
  };
}

describe("Wiki finding decisions", () => {
  it("writes one verdict into every report of the pair without changing page bodies", async () => {
    const files = new Map([[a, await report(a, bodyA)], [b, await report(b, bodyB, sideB, sideA)]]);
    const finding = await project(files);
    expect(finding.reportPaths).toEqual([a, b]);
    const io = store(files);
    await decideWikiFinding(finding, { verdict: "false-positive", note: "  Разные режимы.  " }, { ...io, now });
    expect(io.write).toHaveBeenCalledTimes(2);
    expect(stripKnowledgeCheckStamp(files.get(a)!)).toBe(bodyA);
    const decided = await project(files);
    expect(decided.decision).toEqual({ findingId: finding.id, verdict: "false-positive", note: "Разные режимы.", at: now().toISOString() });
    expect(decided.decisionPartial).toBe(false);
    expect(wikiFindingStatus(decided)).toBe("decided");

    await decideWikiFinding(decided, null, { ...io, now });
    const cleared = await project(files);
    expect(cleared.decision).toBeUndefined();
    expect(wikiFindingStatus(cleared)).toBe("open");
  });

  it("keeps successful writes and reports a partial decision when one compare-and-swap fails", async () => {
    const files = new Map([[a, await report(a, bodyA)], [b, await report(b, bodyB, sideB, sideA)]]);
    const finding = await project(files);
    const io = store(files, new Set([b]));
    await expect(decideWikiFinding(finding, { verdict: "deferred" }, { ...io, now })).rejects.toThrow(/частично.*wiki\/b\.md/u);
    const partial = await project(files);
    expect(partial.decision?.verdict).toBe("deferred");
    expect(partial.decisionPartial).toBe(true);

    // Retrying completes the remaining report.
    await decideWikiFinding(partial, { verdict: "deferred" }, { ...store(files), now });
    expect((await project(files)).decisionPartial).toBe(false);
  });

  it("retrying a partially failed clear clears the remaining report instead of restoring the verdict", async () => {
    const files = new Map([[a, await report(a, bodyA)], [b, await report(b, bodyB, sideB, sideA)]]);
    await decideWikiFinding(await project(files), { verdict: "deferred" }, { ...store(files), now });
    const decided = await project(files);
    await expect(decideWikiFinding(decided, null, { ...store(files, new Set([b])), now })).rejects.toThrow(/частично/u);
    const partial = await project(files);
    expect(partial.decisionPartial).toBe(true);
    expect(partial.decision?.verdict).toBe("deferred");
    // The tab retries the attempted operation (null), not the surviving verdict.
    await decideWikiFinding(partial, null, { ...store(files), now });
    const cleared = await project(files);
    expect(cleared.decision).toBeUndefined();
    expect(cleared.decisionPartial).toBe(false);
  });

  it("aborts without writing once the owner is no longer current", async () => {
    const files = new Map([[a, await report(a, bodyA)]]);
    const finding = await project(files);
    const controller = new AbortController();
    const io = store(files);
    const read = vi.fn(async (path: string) => { controller.abort(); return files.get(path)!; });
    await expect(decideWikiFinding(finding, { verdict: "deferred" }, { read, write: io.write, signal: controller.signal, now }))
      .rejects.toThrow();
    expect(io.write).not.toHaveBeenCalled();
  });

  it("offers an undo that restores the previous decision with its original timestamp", async () => {
    const files = new Map([[a, await report(a, bodyA)], [b, await report(b, bodyB, sideB, sideA)]]);
    await decideWikiFinding(await project(files), { verdict: "side-a" }, { ...store(files), now: () => new Date("2026-10-30T12:30:00.000Z") });
    const before = await project(files);
    const offers: WikiFindingUndoOffer[] = [];
    const refresh = vi.fn(), reportError = vi.fn();
    const decider = createWikiFindingDecider({
      read: async path => files.get(path)!,
      writer: () => ({ isCurrent: () => true, write: store(files).write }),
      refresh, reportError, offerUndo: offer => offers.push(offer),
    });
    expect(await decider.decide(before, { verdict: "deferred" })).toBe(true);
    expect((await project(files)).decision?.verdict).toBe("deferred");
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ key: `wiki-decision:${before.id}`, decision: { verdict: "deferred" } });
    expect(await offers[0]!.undo()).toBe(true);
    expect((await project(files)).decision).toEqual(before.decision);
    expect(reportError).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("offers no undo and writes nothing once the project changed", async () => {
    const files = new Map([[a, await report(a, bodyA)]]);
    const finding = await project(files);
    let current = true;
    const io = store(files);
    const offerUndo = vi.fn(), reportError = vi.fn();
    const decider = createWikiFindingDecider({
      read: async path => { current = false; return files.get(path)!; },
      writer: () => ({ isCurrent: () => current, write: io.write }),
      refresh: vi.fn(), reportError, offerUndo,
    });
    expect(await decider.decide(finding, { verdict: "deferred" })).toBe(false);
    expect(io.write).not.toHaveBeenCalled();
    expect(offerUndo).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("keeps a fix verdict pending until a later check, then reopens or drops it", async () => {
    const files = new Map([[a, await report(a, bodyA)], [b, await report(b, bodyB, sideB, sideA)]]);
    await decideWikiFinding(await project(files), { verdict: "side-a" }, { ...store(files), now });
    const pending = await project(files);
    expect(wikiFindingStatus(pending)).toBe("fix-pending");
    expect(pending.reopened).toBeUndefined();

    // A later check that still reports the finding carries the verdict and reopens it.
    const later = "2026-10-30T14:00:00.000Z";
    const result = (await readKnowledgeReport(files.get(a)!))!.result;
    files.set(a, await recordKnowledgeCheck(bodyA, result, later, files.get(a)!));
    const reopened = await project(files);
    expect(reopened.decision?.verdict).toBe("side-a");
    expect(reopened.reopened).toBe(true);
    expect(reopened.decisionPartial).toBe(false);
    expect(wikiFindingStatus(reopened)).toBe("open");

    // Choosing the verdict again makes it pending until the next check.
    await decideWikiFinding(reopened, { verdict: "side-a" }, { ...store(files), now: () => new Date("2026-10-30T15:00:00.000Z") });
    expect(wikiFindingStatus(await project(files))).toBe("fix-pending");

    // A clean recheck of both pages replaces the reports with success stamps: the finding and its decision are gone.
    const clear = async (path: string, body: string) => recordKnowledgeCheck(body, {
      ...result, path, documentHash: await hash(body), status: "clear", conflicts: [],
    }, "2026-10-30T16:00:00.000Z", files.get(path)!);
    files.set(a, await clear(a, bodyA));
    files.set(b, await clear(b, bodyB));
    for (const content of files.values()) expect(await readKnowledgeReport(content)).toBeUndefined();
  });

  it("refuses when no report contains the finding any longer", async () => {
    const files = new Map([[a, await report(a, bodyA)]]);
    const finding = await project(files);
    files.set(a, bodyA);
    const io = store(files);
    await expect(decideWikiFinding(finding, { verdict: "side-a" }, { ...io, now })).rejects.toThrow(/Ни один отчёт/u);
    expect(io.write).not.toHaveBeenCalled();
  });
});
