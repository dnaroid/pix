import { describe, expect, it } from "vitest";
import type { KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";
import {
  KNOWLEDGE_REPORT_PREFIX, preserveKnowledgeReport, recordKnowledgeAutoCheckAttempt, recordKnowledgeCheck, recordKnowledgeDecision,
} from "../../../acp/src/knowledge/stamp";
import { classifyWikiConsistency, createWikiConsistencyIndex, savedWikiConsistencyStatus, wikiConsistencyDescription } from "./wiki-consistency-tree";

const date = "2026-10-30T12:00:00.000Z";
const path = "wiki/rules.md";
const body = "# Правила\nУ бойца 6 очков действия.\n";

async function hash(content: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function result(content = body, status: KnowledgeCheckResult["status"] = "conflicts"): Promise<KnowledgeCheckResult> {
  return {
    status, path, documentHash: await hash(content), modelRef: "test/judge", reportLanguage: "ru", checkedSources: 1,
    conflicts: status === "conflicts" ? [{
      draft: { path, quote: "У бойца 6 очков действия.", startLine: 2, endLine: 2 },
      existing: { path: "wiki/combat.md", quote: "У бойца 4 очка действия.", startLine: 3, endLine: 3 },
      explanation: "Для одного режима указаны разные значения очков действия.",
    }] : [],
    notices: status === "incomplete" ? ["Не хватает контекста для окончательного вывода."] : [],
  };
}

function rawReport(content: string, value: unknown): string {
  return KNOWLEDGE_REPORT_PREFIX + JSON.stringify({ version: 1, checkedAt: date, result: value }) + " -->\n" + content;
}

describe("recursive Wiki consistency counts", () => {
  it("includes nested pages and section indexes without needing expanded rows", () => {
    const index = createWikiConsistencyIndex();
    index.set("index.md", "clear");
    index.set("combat/index.md", "clear");
    index.set("combat/cover/rules.markdown", "clear");
    expect(index.summary("", true)).toEqual({ status: "clear", documents: 3, clear: 3, conflicts: 0, unknown: 0, accepted: 0, complete: true });
    expect(index.summary("combat", true)).toMatchObject({ status: "clear", documents: 2 });
    expect(index.summary("combat/cover", true)).toMatchObject({ status: "clear", documents: 1 });
  });

  it("propagates one nested conflict to every ancestor while siblings retain their own status", () => {
    const index = createWikiConsistencyIndex();
    index.set("combat/cover/rules.md", "clear");
    index.set("combat/cover/exceptions.md", "conflicts");
    index.set("world/rules.md", "clear");
    index.set("combat/pending.md", "unknown");
    for (const directory of ["", "combat", "combat/cover"]) expect(index.summary(directory, true).status).toBe("conflicts");
    expect(index.summary("", false)).toMatchObject({ status: "conflicts", documents: 4, clear: 2, conflicts: 1, unknown: 1, complete: false });
    expect(index.summary("world", true).status).toBe("clear");
    expect(index.summary("world/rules.md", false)).toMatchObject({ status: "clear", documents: 1, complete: true });
  });

  it("withholds green from incomplete recursive inventories and non-green page mixtures", () => {
    const index = createWikiConsistencyIndex();
    index.set("combat/known.md", "clear");
    expect(index.summary("combat", false)).toMatchObject({ status: "unknown", documents: 1, clear: 1, complete: false });
    index.set("combat/new.md", "unknown");
    expect(index.summary("combat", true)).toMatchObject({ status: "unknown", documents: 2, clear: 1, unknown: 1 });
    index.set("combat/new.md", "clear");
    expect(index.summary("combat", true).status).toBe("clear");
  });

  it("invalidates changed pages and updates only their ancestors without accumulating duplicate counts", () => {
    const index = createWikiConsistencyIndex();
    index.set("combat/a.md", "clear");
    index.set("world/b.md", "clear");
    const previous = index.summary("", true);
    expect(index.set("combat/a.md", "clear")).toBe(false);
    expect(index.set("combat/a.md", "unknown")).toBe(true);
    expect(index.summary("", true)).toMatchObject({ status: "unknown", documents: 2, clear: 1, unknown: 1 });
    expect(index.summary("combat", true).status).toBe("unknown");
    expect(index.summary("world", true)).toMatchObject({ status: "clear", documents: 1 });
    expect(previous).toMatchObject({ status: "clear", documents: 2, clear: 2 });
    index.set("combat/a.md", "conflicts");
    index.set("combat/a.md", "clear");
    expect(index.summary("", true)).toEqual(previous);
  });

  it("removes deleted and renamed files from old ancestors and leaves empty directories neutral", () => {
    const index = createWikiConsistencyIndex();
    index.set("old/deep/conflict.md", "conflicts");
    index.set("old/clear.md", "clear");
    expect(index.delete("old/deep/conflict.md")).toBe(true);
    expect(index.delete("old/deep/conflict.md")).toBe(false);
    expect(index.summary("old", true)).toMatchObject({ status: "clear", documents: 1, conflicts: 0 });
    expect(index.summary("old/deep", true)).toMatchObject({ status: "unknown", documents: 0 });
    index.set("new/conflict.md", "unknown");
    expect(index.summary("", true)).toMatchObject({ status: "unknown", documents: 2, clear: 1, unknown: 1 });
    index.delete("old/clear.md");
    index.delete("new/conflict.md");
    expect(index.summary("", true)).toEqual({ status: "unknown", documents: 0, clear: 0, conflicts: 0, unknown: 0, accepted: 0, complete: true });
  });

  it("ignores assets and invalid paths, and resets every previous project count", () => {
    const index = createWikiConsistencyIndex();
    for (const path of ["images/cover.png", "", "/absolute.md", "../escape.md", "bad//page.md", "bad\\page.md",
      ".draft.md", ".private/page.md", "section/.draft.md", "section/.private/page.md"]) {
      expect(index.set(path, "clear")).toBe(false);
    }
    expect(index.summary("", true).documents).toBe(0);
    index.set("Правила.MD", "conflicts");
    expect(index.summary("", true).conflicts).toBe(1);
    index.clear();
    expect(index.summary("", false)).toMatchObject({ status: "unknown", documents: 0, complete: false });
    expect(index.summary("Правила.MD", true).documents).toBe(0);
  });

  it("keeps counts correct for a large inventory when one deep branch changes", () => {
    const index = createWikiConsistencyIndex();
    for (let section = 0; section < 100; section++) {
      for (let page = 0; page < 100; page++) index.set(`section-${section}/deep/page-${page}.md`, "clear");
    }
    index.set("section-42/deep/page-13.md", "conflicts");
    expect(index.summary("", true)).toMatchObject({ status: "conflicts", documents: 10_000, clear: 9_999, conflicts: 1 });
    expect(index.summary("section-42", true)).toMatchObject({ status: "conflicts", documents: 100, clear: 99, conflicts: 1 });
    expect(index.summary("section-41", true)).toMatchObject({ status: "clear", documents: 100, clear: 100 });
    index.delete("section-42/deep/page-13.md");
    expect(index.summary("", true)).toMatchObject({ status: "clear", documents: 9_999, conflicts: 0 });
  });
});

describe("accepted pages", () => {
  it("counts accepted pages per folder without changing the status, and never for a red page", () => {
    const index = createWikiConsistencyIndex();
    index.set("combat/a.md", "unknown", true);
    index.set("combat/b.md", "clear");
    expect(index.summary("combat/a.md", true)).toMatchObject({ status: "unknown", accepted: 1 });
    expect(index.summary("", true)).toMatchObject({ status: "unknown", documents: 2, accepted: 1 });
    expect(index.set("combat/a.md", "unknown", true)).toBe(false);
    index.set("combat/a.md", "unknown");
    expect(index.summary("combat", true).accepted).toBe(0);
    index.set("combat/a.md", "conflicts", true);
    expect(index.summary("combat", true)).toMatchObject({ status: "conflicts", accepted: 0 });
    index.set("combat/a.md", "clear", true);
    index.delete("combat/a.md");
    expect(index.summary("", true).accepted).toBe(0);
    expect(wikiConsistencyDescription(index.summary("combat/b.md", true), "file")).not.toContain("признаны");
    const accepted = { status: "unknown", documents: 1, clear: 0, conflicts: 0, unknown: 1, accepted: 1, complete: true } as const;
    expect(wikiConsistencyDescription(accepted, "file")).toContain("признаны ложными или отложены");
    expect(wikiConsistencyDescription({ ...accepted, documents: 2, unknown: 2 }, "directory")).toContain("отложены: 1");
  });
});

describe("saved Wiki colors", () => {
  it("accepts a hash-matching green stamp and invalidates it after a body edit", async () => {
    const text = "\uFEFF---\r\nstatus: active\r\n---\r\n# Правила\r\nИсходное правило.\r\n";
    const saved = await recordKnowledgeCheck(text, await result(text, "clear"), date);
    expect(await savedWikiConsistencyStatus(saved, path)).toBe("clear");
    expect(await savedWikiConsistencyStatus(saved.replace("Исходное", "Изменённое"), path)).toBe("unknown");
  });

  it("accepts a current grounded conflict report and retains red with an automatic pass checkpoint", async () => {
    const saved = await recordKnowledgeCheck(body, await result(), date);
    expect(await savedWikiConsistencyStatus(saved, path)).toBe("conflicts");
    const marked = await recordKnowledgeAutoCheckAttempt(saved, "10000000-0000-4000-8000-000000000001", await hash(body), date);
    expect(await savedWikiConsistencyStatus(marked, path)).toBe("conflicts");
  });

  it("makes stale and renamed conflict reports neutral, including citations for a different draft", async () => {
    const finding = await result();
    const saved = await recordKnowledgeCheck(body, finding, date);
    const edited = await preserveKnowledgeReport(body.replace("6 очков", "7 очков"), saved);
    expect(await savedWikiConsistencyStatus(edited, path)).toBe("unknown");
    expect(await savedWikiConsistencyStatus(saved, "wiki/renamed.md")).toBe("unknown");
    const otherDraft = { ...finding, conflicts: finding.conflicts.map(conflict => ({ ...conflict, draft: { ...conflict.draft, path: "wiki/other.md" } })) };
    expect(await savedWikiConsistencyStatus(rawReport(body, otherDraft), path)).toBe("unknown");
  });

  it("projects findings of current and stale reports without changing the color", async () => {
    const saved = await recordKnowledgeCheck(body, await result(), date);
    const current = await classifyWikiConsistency(saved, path);
    expect(current.status).toBe("conflicts");
    expect(current.findings).toHaveLength(1);
    expect(current.findings[0]).toMatchObject({ kind: "conflict", current: true, reportPath: path });
    const edited = await preserveKnowledgeReport(body.replace("6 очков", "7 очков"), saved);
    const stale = await classifyWikiConsistency(edited, path);
    expect(stale.status).toBe("unknown");
    expect(stale.findings).toHaveLength(1);
    expect(stale.findings[0]).toMatchObject({ current: false });
    expect((await classifyWikiConsistency(saved, "wiki/renamed.md")).findings).toEqual([]);
    const clear = await recordKnowledgeCheck(body, await result(body, "clear"), date);
    expect(await classifyWikiConsistency(clear, path)).toEqual({ status: "clear", findings: [] });
  });

  it("stops coloring a page red once every conflict is accepted or deferred, but not for fix verdicts", async () => {
    const saved = await recordKnowledgeCheck(body, await result(), date);
    const [finding] = (await classifyWikiConsistency(saved, path)).findings;
    const at = "2026-10-30T13:00:00.000Z";
    const fix = await recordKnowledgeDecision(saved, finding!.id, { verdict: "side-a", at });
    expect(await savedWikiConsistencyStatus(fix, path)).toBe("conflicts");
    const accepted = await recordKnowledgeDecision(saved, finding!.id, { verdict: "false-positive", note: "Разные режимы.", at });
    const classified = await classifyWikiConsistency(accepted, path);
    expect(classified.status).toBe("unknown");
    expect(classified.findings[0]?.decision?.verdict).toBe("false-positive");
    expect(classified.accepted).toBe(true);
    expect((await classifyWikiConsistency(fix, path)).accepted).toBeUndefined();
    expect((await classifyWikiConsistency(saved, path)).accepted).toBeUndefined();
    const deferred = await recordKnowledgeDecision(saved, finding!.id, { verdict: "deferred", at });
    expect(await savedWikiConsistencyStatus(deferred, path)).toBe("unknown");
    expect((await classifyWikiConsistency(deferred, path)).accepted).toBe(true);
    // A stale report keeps its decisions but no longer marks the page accepted.
    const edited = await preserveKnowledgeReport(body.replace("6 очков", "7 очков"), deferred);
    expect((await classifyWikiConsistency(edited, path)).accepted).toBeUndefined();
  });

  it("keeps incomplete, attempted and unreviewed versions neutral", async () => {
    const incomplete = await recordKnowledgeCheck(body, await result(body, "incomplete"), date);
    const attempted = await recordKnowledgeAutoCheckAttempt(body, "10000000-0000-4000-8000-000000000001", await hash(body), date);
    for (const content of [body, incomplete, attempted]) expect(await savedWikiConsistencyStatus(content, path)).toBe("unknown");
  });

  it("rejects malformed, duplicate and unsupported reports instead of propagating a red color", async () => {
    const finding = await result();
    const valid = rawReport(body, finding);
    const line = valid.slice(0, valid.indexOf("\n") + 1);
    const invalid = [
      KNOWLEDGE_REPORT_PREFIX + "broken -->\n" + body,
      line + valid,
      valid.replace('"version":1', '"version":2'),
      rawReport(body, { ...finding, conflicts: [] }),
      rawReport(body, { ...finding, documentHash: "0".repeat(64) }),
      rawReport(body, { ...finding, conflicts: finding.conflicts.map(conflict => ({ ...conflict, existing: { ...conflict.existing, quote: "" } })) }),
    ];
    for (const content of invalid) expect(await savedWikiConsistencyStatus(content, path)).toBe("unknown");
  });
});

describe("Wiki color descriptions", () => {
  it("explains colors and recursive counts without claiming success before discovery finishes", () => {
    const index = createWikiConsistencyIndex();
    index.set("section/a.md", "clear");
    const pending = wikiConsistencyDescription(index.summary("section", false), "directory");
    expect(pending).toContain("обновляется");
    expect(pending).not.toContain("Все документы");
    expect(wikiConsistencyDescription(index.summary("section", true), "directory")).toContain("Все документы внутри рекурсивно зелёные");
    index.set("section/b.md", "conflicts");
    const red = wikiConsistencyDescription(index.summary("section", false), "directory");
    expect(red).toContain("Документов: 2; зелёных: 1; с противоречиями: 1");
    expect(red).toContain("Обход ещё не завершён");
    expect(wikiConsistencyDescription(index.summary("empty", true), "directory")).toContain("нет документов Markdown");
    expect(wikiConsistencyDescription(index.summary("section/a.md", false), "file")).toContain("Сохранённая версия прошла");
    expect(wikiConsistencyDescription(index.summary("section/b.md", true), "file")).toContain("найдены противоречия");
  });
});
