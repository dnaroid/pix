import { describe, expect, it, vi } from "vitest";
import type { KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";
import { readKnowledgeReport, recordKnowledgeCheck } from "../../../acp/src/knowledge/stamp";
import type { KnowledgeBatchResolutionRequest, KnowledgeResolutionRequest } from "../lib/knowledge-resolution";
import { projectWikiPageFindings, type WikiFinding } from "../lib/wiki-conflicts-index";
import { resolveWikiFinding, resolveWikiFindings } from "./wiki-finding-resolution";

const date = "2026-10-30T12:00:00.000Z";
const path = "wiki/rules.md";
const body = "# Правила\nУ бойца 6 очков действия.\n";

async function hash(content: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function result(content = body): Promise<KnowledgeCheckResult> {
  return {
    status: "conflicts", path, documentHash: await hash(content), modelRef: "test/judge", reportLanguage: "ru", checkedSources: 1,
    conflicts: [{
      draft: { path, quote: "У бойца 6 очков действия.", startLine: 2, endLine: 2 },
      existing: { path: "wiki/combat.md", quote: "У бойца 4 очка действия.", startLine: 3, endLine: 3 },
      explanation: "Для одного режима указаны разные значения очков действия.",
    }],
    notices: [],
  };
}

async function finding(saved: string, reportPaths = [path]): Promise<WikiFinding> {
  const report = (await readKnowledgeReport(saved))!;
  const [page] = await projectWikiPageFindings(report, path);
  return { ...page!, reportPath: path, checkedAt: date, current: true, modelRef: "test/judge", reportLanguage: "ru",
    reportPaths, stale: false, decisionPartial: false };
}

describe("resolving one Wiki finding in a new session", () => {
  it("hands off the saved page with only the focused finding", async () => {
    const saved = await recordKnowledgeCheck(body, await result(), date);
    const start = vi.fn<(request: KnowledgeResolutionRequest) => void>();
    const item = await finding(saved);
    await resolveWikiFinding(item, { workspace: "/project", read: async () => saved, start });
    expect(start).toHaveBeenCalledOnce();
    const request = start.mock.calls[0]![0];
    expect(request).toMatchObject({ workspace: "/project", content: saved, saved: true,
      focus: { kind: item.kind, draft: item.draft, existing: item.existing, explanation: item.explanation } });
  });

  it("skips reports that no longer match their page and refuses when none is current", async () => {
    const saved = await recordKnowledgeCheck(body, await result(), date);
    const item = await finding(saved, [path, "wiki/other.md"]);
    const edited = saved.replace("6 очков", "5 очков");
    const start = vi.fn();
    const read = vi.fn(async (target: string) => target === path ? edited : "# Другое\n");
    await expect(resolveWikiFinding(item, { workspace: "/project", read, start }))
      .rejects.toThrow(/Ни один актуальный отчёт/u);
    expect(read).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
  });
});

describe("resolving a basket of Wiki findings in one session", () => {
  it("hands off current findings with their verdicts and skips findings without a current report", async () => {
    const saved = await recordKnowledgeCheck(body, await result(), date);
    const item = await finding(saved);
    const decision = { findingId: item.id, verdict: "side-b" as const, at: date };
    const decided = { ...item, decision };
    const gone = { ...item, id: "0".repeat(64), reportPath: "wiki/gone.md", reportPaths: ["wiki/gone.md"] };
    const start = vi.fn<(request: KnowledgeBatchResolutionRequest) => void>();
    const read = vi.fn(async (target: string) => target === path ? saved : "# Нет отчёта\n");
    const outcome = await resolveWikiFindings([decided, gone], { workspace: "/project", read, start });
    expect(outcome).toEqual({ sent: [item.id], skipped: [gone.id] });
    expect(start).toHaveBeenCalledOnce();
    const request = start.mock.calls[0]![0];
    expect(request.workspace).toBe("/project");
    expect(request.language).toBe("ru");
    expect(request.items).toHaveLength(1);
    expect(request.items[0]).toMatchObject({
      target: { path, contentHash: (await result()).documentHash },
      finding: { kind: item.kind, draft: item.draft, existing: item.existing, explanation: item.explanation },
    });
  });

  it("takes the verdict from the current report, not the cached projection", async () => {
    const saved = await recordKnowledgeCheck(body, await result(), date);
    const item = await finding(saved);
    const start = vi.fn<(request: KnowledgeBatchResolutionRequest) => void>();
    await resolveWikiFindings([{ ...item, decision: { findingId: item.id, verdict: "side-a", at: date } }],
      { workspace: "/project", read: async () => saved, start });
    expect(start.mock.calls[0]![0].items[0]).not.toHaveProperty("decision");
  });

  it("refuses when no basket finding has a current report", async () => {
    const saved = await recordKnowledgeCheck(body, await result(), date);
    const item = await finding(saved);
    const start = vi.fn();
    await expect(resolveWikiFindings([item], { workspace: "/project", read: async () => saved.replace("6 очков", "5 очков"), start }))
      .rejects.toThrow(/находки из корзины/u);
    expect(start).not.toHaveBeenCalled();
  });
});
