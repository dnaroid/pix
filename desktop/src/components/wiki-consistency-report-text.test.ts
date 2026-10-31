import { describe, expect, it } from "vitest";
import type { KnowledgeCheckCoverage, KnowledgeCheckResult } from "../../../acp/src/knowledge/contract";
import { knowledgeCheckReportText } from "./wiki-consistency-report-text";

const result = (extra: Partial<KnowledgeCheckResult> = {}): KnowledgeCheckResult => ({
  status: "clear", path: "wiki/policy.md", documentHash: "fixture", modelRef: "fixture/judge",
  checkedSources: 1, conflicts: [], notices: [], ...extra,
});
const coverage = (extra: Partial<KnowledgeCheckCoverage> = {}): KnowledgeCheckCoverage => ({
  scope: "retrieved-passages", checkedPassages: 1, candidateSources: 1, excerptedSources: 0, limits: [], ...extra,
});

describe("Wiki consistency report language", () => {
  it("describes full and partial document-part coverage without inflating completed comparisons", () => {
    const complete = result({ reportLanguage: "ru", chunkCoverage: {
      totalChunks: 2, checkedChunks: 2, totalComparisons: 3, checkedComparisons: 3,
    } });
    expect(knowledgeCheckReportText(complete).chunkReview).toBe("Части документа: проверено 2 из 2. Сопоставления: завершено 3 из 3, включая сравнение частей между собой.");
    const partial = { ...complete, status: "incomplete" as const, chunkCoverage: {
      totalChunks: 3, checkedChunks: 2, totalComparisons: 6, checkedComparisons: 2,
    } };
    expect(knowledgeCheckReportText(partial).chunkReview).toContain("проверено 2 из 3");
    expect(knowledgeCheckReportText(partial).chunkReview).toContain("завершено 2 из 6");
    expect(knowledgeCheckReportText({ ...partial, reportLanguage: "en" }).chunkReview).toContain("2 of 6 completed");
    expect(knowledgeCheckReportText(result()).chunkReview).toBe("");
  });

  it("distinguishes retained report passages from all reviewed passages", () => {
    const value = result({ reportLanguage: "ru", coverage: coverage({ checkedPassages: 24, retainedPassages: 12 }) });
    expect(knowledgeCheckReportText(value).retainedEvidence).toBe("В отчёте сохранено 12 из 24 проверенных фрагментов.");
    expect(knowledgeCheckReportText({ ...value, reportLanguage: "en" }).retainedEvidence).toBe("This report retains 12 of the 24 reviewed passages.");
    expect(knowledgeCheckReportText(result({ coverage: coverage({ retainedPassages: 1 }) })).retainedEvidence).toBe("");
    expect(knowledgeCheckReportText(result()).retainedEvidence).toBe("");
  });

  it("keeps legacy results and initial progress in English", () => {
    const text = knowledgeCheckReportText(result({ coverage: coverage() }));
    expect(text.summary).toBe("No contradictions found in the reviewed passages");
    expect(text.reviewed).toBe("Reviewed 1 passage from 1 of 1 candidate source. Findings apply to this draft and the reviewed passages.");
    expect(text.checkAgain).toBe("Check again");
    expect(knowledgeCheckReportText(undefined, true).summary).toBe("Checking document consistency…");
  });

  it.each([
    ["clear", "Противоречий в проверенных фрагментах не найдено"],
    ["conflicts", "Найдены возможные противоречия"],
    ["incomplete", "Проверка на противоречия выполнена не полностью"],
  ] as const)("uses the returned language for a %s result and its controls", (status, summary) => {
    const text = knowledgeCheckReportText(result({ reportLanguage: "ru", status }));
    expect(text.summary).toBe(summary);
    expect(text.sectionLabel).toBe("Проверка Wiki на противоречия");
    expect(text.checkAgain).toBe("Проверить снова");
    expect(text.saveAnyway).toBe("Всё равно сохранить");
    expect(text.dismiss).toBe("Закрыть");
    expect(text.judgeLabel).toBe("Модель-судья");
    expect(text.draftLabel).toBe("Этот черновик");
    expect(text.openSource).toBe("Открыть фрагмент источника");
  });

  it("keeps progress distinct from a retained result's verdict", () => {
    const text = knowledgeCheckReportText(result({ reportLanguage: "ru", status: "conflicts" }), true);
    expect(text.summary).toBe("Проверяем документ на противоречия…");
    expect(text.cancelCheck).toBe("Отменить проверку");
  });

  it("inflects Russian passage and source counts, including teens and compound numbers", () => {
    const cases = [
      [0, "Проверено 0 фрагментов", "источников"],
      [1, "Проверен 1 фрагмент", "источника"],
      [2, "Проверено 2 фрагмента", "источников"],
      [5, "Проверено 5 фрагментов", "источников"],
      [11, "Проверено 11 фрагментов", "источников"],
      [14, "Проверено 14 фрагментов", "источников"],
      [21, "Проверен 21 фрагмент", "источника"],
      [22, "Проверено 22 фрагмента", "источников"],
      [25, "Проверено 25 фрагментов", "источников"],
      [101, "Проверен 101 фрагмент", "источника"],
      [111, "Проверено 111 фрагментов", "источников"],
    ] as const;
    for (const [count, expected, sourceForm] of cases) {
      const text = knowledgeCheckReportText(result({ reportLanguage: "ru", checkedSources: count,
        coverage: coverage({ checkedPassages: count, candidateSources: 200, excerptedSources: count }) }));
      expect(text.reviewed).toBe(`${expected} из ${count} ${sourceForm} (всего кандидатов: 200). Выводы относятся к этому черновику и проверенным фрагментам.`);
      expect(text.selection).toBe(count ? `фрагменты из ${count} ${sourceForm}` : "");
    }
  });

  it("combines coverage limits once and describes excerpts in the selected language", () => {
    const value = result({ reportLanguage: "ru", checkedSources: 12, coverage: coverage({
      checkedPassages: 12, candidateSources: 48, excerptedSources: 9,
      limits: ["query-sampling", "candidate-limit", "source-limit", "passage-limit", "context-limit"],
    }) });
    const russian = knowledgeCheckReportText(value);
    expect(russian.selection).toBe("выбраны отдельные разделы черновика; ограничена выборка источников; фрагменты из 9 источников; сокращён дополнительный контекст");
    const english = knowledgeCheckReportText({ ...value, reportLanguage: "en" });
    expect(english.reviewed).toBe("Reviewed 12 passages from 12 of 48 candidate sources. Findings apply to this draft and the reviewed passages.");
    expect(english.selection).toBe("sampled draft sections; limited source selection; excerpts from 9 sources; shortened background context");
  });

  it("supports results without detailed coverage without inventing a scope", () => {
    const russian = knowledgeCheckReportText(result({ reportLanguage: "ru", checkedSources: 2 }));
    expect(russian.reviewed).toBe("Проверено 2 источника. Выводы относятся к этому черновику и проверенным материалам.");
    expect(russian.selection).toBe("");
    expect(knowledgeCheckReportText(result({ checkedSources: 2 })).reviewed).toBe("Reviewed 2 sources. Findings apply to this draft and the reviewed material.");
    expect(knowledgeCheckReportText().reviewed).toBe("");
  });

  it("describes passage limits even when no source excerpt count is available", () => {
    const value = result({ coverage: coverage({ limits: ["passage-limit"] }) });
    expect(knowledgeCheckReportText(value).selection).toBe("selected excerpts");
    expect(knowledgeCheckReportText({ ...value, reportLanguage: "ru" }).selection).toBe("выбраны отдельные фрагменты");
  });

  it("keeps grounded findings and diagnostic counts separate", () => {
    const claim = {
      draft: { path: "wiki/policy.md", quote: "Never", startLine: 2, endLine: 2 },
      existing: { path: "wiki/guide.md", quote: "Always", startLine: 8, endLine: 8 },
      explanation: "The same rule has opposite requirements.",
    };
    const value = result({ status: "conflicts", conflicts: [claim], uncertainties: [claim, claim], notices: ["Search was partial."] });
    expect(knowledgeCheckReportText(value).counts).toBe("Conflicts: 1 · Uncertainties: 2 · Notices: 1");
    expect(knowledgeCheckReportText({ ...value, reportLanguage: "ru" }).counts).toBe("Противоречия: 1 · Неопределённости: 2 · Замечания: 1");
    expect(knowledgeCheckReportText(result({ notices: ["Legacy uncertainty without citations"] })).counts).toBe("Conflicts: 0 · Uncertainties: 0 · Notices: 1");
    expect(knowledgeCheckReportText(result()).counts).toBe("Conflicts: 0 · Uncertainties: 0");
    expect(knowledgeCheckReportText().counts).toBe("");
  });

  it("localizes all report disclosures and the explicit resolution action", () => {
    const text = knowledgeCheckReportText(result({ reportLanguage: "ru" }));
    expect(text.collapseReport).toBe("Свернуть отчёт");
    expect(text.expandReport).toBe("Развернуть отчёт");
    expect(text.resolveInSession).toBe("Разрулить в новой сессии");
    expect(text.resolving).toBe("Создаём сессию…");
    expect(text.uncertaintiesLabel).toBe("Что нужно уточнить");
    expect(text.noticesLabel).toBe("Замечания проверки");
    expect(text.sourcesLabel).toBe("Проверенные фрагменты");
    expect(text.sourcesUnavailable).toContain("Запустите проверку снова");
    expect(text.staleSummary).toBe("Сохранённый отчёт устарел");
    expect(text.staleReport).toContain("прежней версии");
    expect(text.resolveStale).toContain("Повторите проверку");
  });

  it("attributes stale findings to the checked snapshot instead of the current draft", () => {
    const value = result({ reportLanguage: "ru", coverage: coverage() });
    const russian = knowledgeCheckReportText(value, false, false, true);
    expect(russian.reviewed).toContain("Выводы относятся к сохранённой версии документа");
    expect(russian.reviewed).not.toContain("этому черновику");
    expect(russian.draftLabel).toBe("Версия на момент проверки");
    const english = knowledgeCheckReportText({ ...value, reportLanguage: "en" }, false, false, true);
    expect(english.reviewed).toContain("Findings apply to the saved document version");
    expect(english.draftLabel).toBe("Document at check time");
  });
});
