import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeCheckResult, KnowledgeConflict } from "../../../acp/src/knowledge/contract";
import WikiConsistencyReport from "./WikiConsistencyReport.svelte";

const conflict: KnowledgeConflict = {
  draft: { path: "wiki/combat.md", quote: "Укрытие круговое.", startLine: 4, endLine: 4 },
  existing: { path: "wiki/rules.md", quote: "Укрытие действует только спереди.", startLine: 9, endLine: 10 },
  explanation: "Правила задают несовместимые направления укрытия.",
};
const uncertainty: KnowledgeConflict = {
  draft: { path: "wiki/combat.md", quote: "Старые fixtures сохранены.", startLine: 18, endLine: 18 },
  existing: { path: "wiki/migration.md", quote: "Направленные правила действуют в fixtures.", startLine: 21, endLine: 22 },
  explanation: "Нужно уточнить, относятся ли эти правила к основной игре.",
};
const report = (extra: Partial<KnowledgeCheckResult> = {}): KnowledgeCheckResult => ({
  status: "conflicts", path: "wiki/combat.md", documentHash: "a".repeat(64), modelRef: "fixture/judge", reportLanguage: "ru",
  checkedSources: 2, conflicts: [conflict], uncertainties: [uncertainty],
  reviewedSources: [conflict.existing, uncertainty.existing], notices: ["Выборка источников ограничена."],
  ...extra,
});
type Props = Parameters<typeof WikiConsistencyReport>[1];
function html(props: Partial<Props> = {}): string {
  return render(WikiConsistencyReport, { props: { result: report(), onCancel: () => {}, onSaveAnyway: () => {}, ...props } }).body;
}
function buttons(body: string): string[] { return body.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []; }
function citationButtons(body: string): string[] { return buttons(body).filter(button => button.includes('aria-label="Открыть фрагмент источника:')); }

describe("Wiki consistency report rendering", () => {
  it("renders distinct findings, diagnostics and all reviewed evidence with path and line links", () => {
    const onOpenCitation = vi.fn();
    const onResolve = vi.fn();
    const body = html({ canOpenSources: true, onOpenCitation, onResolve });
    expect(body).toContain("Противоречия: 1 · Неопределённости: 1 · Замечания: 1");
    expect(body).toContain('aria-label="Противоречащие утверждения"');
    expect(body).toContain('aria-label="Что нужно уточнить"');
    expect(body).toContain("Замечания проверки · 1");
    expect(body).toContain("Проверенные фрагменты · 2");
    for (const finding of [conflict, uncertainty]) {
      expect(body).toContain(finding.explanation);
      expect(body).toContain(finding.draft.quote);
      expect(body).toContain(finding.existing.quote);
    }
    const links = citationButtons(body);
    expect(links).toHaveLength(6);
    expect(links.some(button => button.includes("wiki/combat.md:L4"))).toBe(true);
    expect(links.some(button => button.includes("wiki/rules.md:L9–10"))).toBe(true);
    expect(links.every(button => !/\sdisabled(?:\s|=|>)/.test(button))).toBe(true);
    expect(body).toContain("Разрулить в новой сессии");
    expect(onOpenCitation).not.toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("escapes model explanations, notices and exact quotations", () => {
    const hostile = '<img src=x onerror="alert(1)"> & <script>alert(2)</script>';
    const finding = { ...conflict, explanation: hostile, draft: { ...conflict.draft, quote: hostile } };
    const body = html({ result: report({ conflicts: [finding], uncertainties: [], notices: [hostile], reviewedSources: [finding.draft] }) });
    expect(body).toContain("&lt;img");
    expect(body).toContain("&amp;");
    expect(body).toMatch(/&lt;script(?:>|&gt;)/);
    expect(body).not.toContain("<img");
    expect(body).not.toContain("<script");
  });

  it("keeps diagnostics from legacy results without inventing grounded evidence", () => {
    const body = html({ result: report({ status: "incomplete", conflicts: [], uncertainties: undefined, reviewedSources: undefined,
      notices: ["Draft and source-3 may refer to different game modes."] }) });
    expect(body).toContain("Draft and source-3 may refer to different game modes.");
    expect(body).toContain("Противоречия: 0 · Неопределённости: 0 · Замечания: 1");
    expect(body).toContain("В этом старом отчёте проверенные фрагменты не сохранены.");
    expect(body).not.toContain('aria-label="Что нужно уточнить"');
    expect(citationButtons(body)).toHaveLength(0);
  });

  it("disables all source navigation while a dirty draft is protected", () => {
    const body = html({ canOpenSources: false, onOpenCitation: vi.fn() });
    const links = citationButtons(body);
    expect(links).toHaveLength(6);
    expect(links.every(button => /\sdisabled(?:\s|=|>)/.test(button))).toBe(true);
    expect(links.every(button => button.includes("Сохраните или отмените изменения"))).toBe(true);
  });

  it("keeps the legacy source callback usable for both sides of every finding", () => {
    const body = html({ canOpenSources: true, onOpenSource: vi.fn() });
    expect(citationButtons(body)).toHaveLength(6);
    expect(citationButtons(body).some(button => button.includes("wiki/combat.md:L18"))).toBe(true);
  });

  it("uses explicit resolution actions only for completed nonclear reports", () => {
    const onResolve = vi.fn();
    const technical = report({ status: "incomplete", conflicts: [], uncertainties: [] });
    expect(html({ result: technical, onResolve })).toContain("Разрулить в новой сессии");
    expect(html({ result: technical })).not.toContain("Разрулить в новой сессии");
    expect(html({ result: report({ status: "clear", conflicts: [], uncertainties: [] }), onResolve })).not.toContain("Разрулить в новой сессии");
    const busy = buttons(html({ onResolve, resolving: true })).find(button => button.includes("Создаём сессию…"));
    expect(busy).toContain("disabled");
    expect(busy).toContain('aria-busy="true"');
    const checking = html({ checking: true, onResolve });
    expect(checking).toContain("Отменить проверку");
    expect(checking).not.toContain("data-wiki-report-body");
    expect(checking).not.toContain("Разрулить в новой сессии");
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("keeps historical evidence visible but disables resolution for a stale saved report", () => {
    const onResolve = vi.fn();
    const body = html({ stale: true, checkedAt: "2026-10-30T01:00:00.000Z", onResolve });
    expect(body).toContain("Сохранённый отчёт устарел");
    expect(body).toContain("Документ изменился после проверки");
    expect(body).toContain("2026-10-30T01:00:00.000Z");
    expect(body).toContain(conflict.draft.quote);
    expect(body).toContain(conflict.existing.quote);
    const resolve = buttons(body).find(button => button.includes("Разрулить в новой сессии"));
    expect(resolve).toMatch(/\sdisabled(?:\s|=|>)/);
    expect(resolve).toContain("Повторите проверку");
    expect(onResolve).not.toHaveBeenCalled();
  });

  it.each(["", "not-a-hash", "A".repeat(64)])("does not offer resolution without a valid checked hash: %s", documentHash => {
    const body = html({ result: report({ documentHash }), onResolve: vi.fn() });
    expect(body).not.toContain("Разрулить в новой сессии");
  });

  it("provides independent disclosure controls and a single column in the sidebar", () => {
    const body = html({ compact: true });
    const toggle = buttons(body).find(button => button.includes('aria-label="Свернуть отчёт"'));
    expect(toggle).toContain('aria-expanded="true"');
    expect(toggle).toContain("aria-controls=");
    expect(toggle).toContain("<svg");
    const sourceToggle = buttons(body).find(button => button.includes("Проверенные фрагменты · 2"));
    expect(sourceToggle).toContain('aria-expanded="false"');
    expect(sourceToggle).toContain("<svg");
    const summaries = body.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/g) ?? [];
    expect(summaries.length).toBeGreaterThan(0);
    expect(summaries.every(summary => summary.includes("<svg") && summary.includes("group-open:rotate-90"))).toBe(true);
    expect(body).not.toContain("lg:grid-cols-2");
    expect(body).not.toContain("max-h-");
  });
});
