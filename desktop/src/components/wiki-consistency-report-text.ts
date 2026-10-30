import type { KnowledgeCheckResult, KnowledgeReportLanguage } from "../../../acp/src/knowledge/contract";

const COPY = {
  en: {
    sectionLabel: "Wiki consistency check",
    checking: "Checking document consistency…",
    queued: "Waiting for the preceding Wiki check…",
    status: {
      clear: "No contradictions found in the reviewed passages",
      conflicts: "Potential contradictions found",
      incomplete: "Consistency check is incomplete",
    },
    cancelCheck: "Cancel check",
    checkAgain: "Check again",
    saveAnyway: "Save anyway",
    dismiss: "Dismiss",
    dismissResult: "Dismiss consistency result",
    collapseReport: "Collapse consistency report",
    expandReport: "Expand consistency report",
    resolveInSession: "Resolve in a new session",
    resolving: "Starting session…",
    staleSummary: "Saved consistency report is out of date",
    staleReport: "The document has changed since this check. The findings below describe an earlier version. Check again before resolving findings for the current text.",
    resolveStale: "Run a new check before resolving findings for changed text",
    savedReportLabel: "Saved check time",
    overviewLabel: "About this check",
    documentLabel: "Document",
    scopeLabel: "Review scope",
    judgeLabel: "Judge model",
    modelUnavailable: "Not available",
    conflictsLabel: "Conflicting claims",
    uncertaintiesLabel: "Needs clarification",
    uncertaintyHelp: "These claims need an additional condition or clarification before compatibility can be decided.",
    draftLabel: "This draft",
    checkedDraftLabel: "Document at check time",
    sameDocumentLabel: "Another claim in this document",
    sourceLabel: "Existing source",
    noticesLabel: "Check notices",
    sourcesLabel: "Reviewed passages",
    sourcesUnavailable: "This older report did not retain its reviewed passages. Run the check again to inspect the evidence.",
    noSources: "No external source passages were reviewed.",
    sourceSnapshots: "These are the passages used for this report. Opening a source checks the quotation against the current file.",
    openSource: "Open source passage",
    openSourceBlocked: "Save or discard this draft before opening another source",
    sampledSections: "sampled draft sections",
    limitedSources: "limited source selection",
    selectedExcerpts: "selected excerpts",
    shortenedContext: "shortened background context",
  },
  ru: {
    sectionLabel: "Проверка Wiki на противоречия",
    checking: "Проверяем документ на противоречия…",
    queued: "Ожидаем завершения предыдущей проверки Wiki…",
    status: {
      clear: "Противоречий в проверенных фрагментах не найдено",
      conflicts: "Найдены возможные противоречия",
      incomplete: "Проверка на противоречия выполнена не полностью",
    },
    cancelCheck: "Отменить проверку",
    checkAgain: "Проверить снова",
    saveAnyway: "Всё равно сохранить",
    dismiss: "Закрыть",
    dismissResult: "Закрыть результат проверки",
    collapseReport: "Свернуть отчёт",
    expandReport: "Развернуть отчёт",
    resolveInSession: "Разрулить в новой сессии",
    resolving: "Создаём сессию…",
    staleSummary: "Сохранённый отчёт устарел",
    staleReport: "Документ изменился после проверки. Находки ниже относятся к прежней версии. Повторите проверку перед исправлением противоречий в текущем тексте.",
    resolveStale: "Повторите проверку перед исправлением изменившегося текста",
    savedReportLabel: "Дата сохранённой проверки",
    overviewLabel: "О проверке",
    documentLabel: "Документ",
    scopeLabel: "Охват проверки",
    judgeLabel: "Модель-судья",
    modelUnavailable: "Недоступна",
    conflictsLabel: "Противоречащие утверждения",
    uncertaintiesLabel: "Что нужно уточнить",
    uncertaintyHelp: "Для этих утверждений не хватает условия или контекста, чтобы решить, совместимы ли они.",
    draftLabel: "Этот черновик",
    checkedDraftLabel: "Версия на момент проверки",
    sameDocumentLabel: "Другое утверждение в этом документе",
    sourceLabel: "Существующий источник",
    noticesLabel: "Замечания проверки",
    sourcesLabel: "Проверенные фрагменты",
    sourcesUnavailable: "В этом старом отчёте проверенные фрагменты не сохранены. Запустите проверку снова, чтобы посмотреть доказательства.",
    noSources: "Фрагменты внешних источников не проверялись.",
    sourceSnapshots: "Это фрагменты, использованные в отчёте. При открытии источника цитата проверяется по текущему файлу.",
    openSource: "Открыть фрагмент источника",
    openSourceBlocked: "Сохраните или отмените изменения черновика перед открытием другого источника",
    sampledSections: "выбраны отдельные разделы черновика",
    limitedSources: "ограничена выборка источников",
    selectedExcerpts: "выбраны отдельные фрагменты",
    shortenedContext: "сокращён дополнительный контекст",
  },
} satisfies Record<KnowledgeReportLanguage, unknown>;

function russianOne(count: number): boolean {
  return count % 10 === 1 && count % 100 !== 11;
}
function russianPlural(count: number, one: string, few: string, many: string): string {
  if (russianOne(count)) return one;
  return count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? few : many;
}

/** UI copy follows the language actually used for this result, including inherited settings. */
export function knowledgeCheckReportText(result?: KnowledgeCheckResult, checking = false, queued = false, stale = false) {
  const language = result?.reportLanguage === "ru" ? "ru" : "en";
  const copy = COPY[language], coverage = result?.coverage;
  const russian = language === "ru";
  let reviewed = "";
  if (result) {
    const count = result.checkedSources;
    const scopeSubject = russian
      ? stale ? "Выводы относятся к сохранённой версии документа" : "Выводы относятся к этому черновику"
      : stale ? "Findings apply to the saved document version" : "Findings apply to this draft";
    if (coverage) {
      const passages = coverage.checkedPassages;
      reviewed = russian
        ? `${russianOne(passages) ? "Проверен" : "Проверено"} ${passages} ${russianPlural(passages, "фрагмент", "фрагмента", "фрагментов")} из ${count} ${russianOne(count) ? "источника" : "источников"} (всего кандидатов: ${coverage.candidateSources}). ${scopeSubject} и проверенным фрагментам.`
        : `Reviewed ${passages} ${passages === 1 ? "passage" : "passages"} from ${count} of ${coverage.candidateSources} candidate ${coverage.candidateSources === 1 ? "source" : "sources"}. ${scopeSubject} and the reviewed passages.`;
    } else {
      reviewed = russian
        ? `${russianOne(count) ? "Проверен" : "Проверено"} ${count} ${russianPlural(count, "источник", "источника", "источников")}. ${scopeSubject} и проверенным материалам.`
        : `Reviewed ${count} ${count === 1 ? "source" : "sources"}. ${scopeSubject} and the reviewed material.`;
    }
  }
  const excerptCount = coverage?.excerptedSources ?? 0;
  const excerpts = excerptCount > 0
    ? russian
      ? `фрагменты из ${excerptCount} ${russianOne(excerptCount) ? "источника" : "источников"}`
      : `excerpts from ${excerptCount} ${excerptCount === 1 ? "source" : "sources"}`
    : coverage?.limits.includes("passage-limit") ? copy.selectedExcerpts : "";
  const selection = coverage ? [
    coverage.limits.includes("query-sampling") ? copy.sampledSections : "",
    coverage.limits.includes("candidate-limit") || coverage.limits.includes("source-limit") ? copy.limitedSources : "",
    excerpts,
    coverage.limits.includes("context-limit") ? copy.shortenedContext : "",
  ].filter(Boolean).join("; ") : "";
  const counts = result ? [
    `${russian ? "Противоречия" : "Conflicts"}: ${result.conflicts.length}`,
    `${russian ? "Неопределённости" : "Uncertainties"}: ${result.uncertainties?.length ?? 0}`,
    result.notices.length ? `${russian ? "Замечания" : "Notices"}: ${result.notices.length}` : "",
  ].filter(Boolean).join(" · ") : "";
  return { ...copy, draftLabel: stale ? copy.checkedDraftLabel : copy.draftLabel,
    summary: queued ? copy.queued : checking ? copy.checking : copy.status[result?.status ?? "incomplete"], reviewed, selection, counts };
}
