import type { KnowledgeReportLanguage } from "../../../acp/src/knowledge/contract";
import { knowledgeFindingSides, type KnowledgeFindingVerdict } from "../../../acp/src/knowledge/decisions";
import type { KnowledgeCitation } from "../../../acp/src/knowledge/contract";
import type { WikiFinding, WikiFindingSummary } from "../lib/wiki-conflicts-index";

/** Tab chrome follows the saved reports' language; English is the neutral fallback. */
export function wikiConflictsText(language?: KnowledgeReportLanguage) {
  const ru = language === "ru";
  return {
    heading: ru ? "Противоречия Wiki" : "Wiki Conflicts",
    inboxLabel: ru ? "Находки" : "Findings",
    summary: (summary: WikiFindingSummary) => ru
      ? `Противоречий: ${summary.conflicts} · неопределённостей: ${summary.uncertainties} · ждут исправления: ${summary.fixPending} · решено: ${summary.decided} · устаревших: ${summary.stale}`
      : `Conflicts: ${summary.conflicts} · uncertainties: ${summary.uncertainties} · awaiting fix: ${summary.fixPending} · decided: ${summary.decided} · stale: ${summary.stale}`,
    kindLabel: ru ? "Вид" : "Kind",
    kindAll: ru ? "Все" : "All",
    kindConflict: ru ? "Противоречия" : "Conflicts",
    kindUncertainty: ru ? "Неопределённости" : "Uncertainties",
    kindInternal: ru ? "Внутри страницы" : "Within a page",
    statusLabel: ru ? "Статус" : "Status",
    statusOpen: ru ? "Актуальные" : "Current",
    statusFixPending: ru ? "Ждут исправления" : "Awaiting fix",
    statusDecided: ru ? "Решённые" : "Decided",
    statusStale: ru ? "Устаревшие" : "Stale",
    statusAll: ru ? "Все" : "All",
    groupLabel: ru ? "Группировка" : "Group by",
    groupPair: ru ? "Пара документов" : "Document pair",
    groupPage: ru ? "Страница" : "Page",
    branchLabel: ru ? "Ветка" : "Branch",
    clearBranch: ru ? "Сбросить ветку" : "Clear branch",
    truncated: ru ? "Показаны первые 2 000 находок." : "Showing the first 2,000 findings.",
    noWiki: ru ? "Wiki для этого проекта не настроена." : "This project has no Wiki configured.",
    scanning: ru ? "Сохранённые отчёты Wiki ещё читаются…" : "Reading saved Wiki reports…",
    emptyComplete: ru ? "В сохранённых отчётах нет находок." : "Saved reports contain no findings.",
    emptyCoverage: ru
      ? "Учитываются только страницы, которые уже проверялись. Непроверенные страницы могут содержать противоречия."
      : "Only pages that have been checked are included. Unchecked pages may still contain contradictions.",
    emptyIncomplete: ru
      ? "Часть Wiki пока не прочитана, поэтому список может быть неполным."
      : "Part of the Wiki has not been read yet, so this list may be incomplete.",
    emptyFiltered: ru ? "Нет находок для выбранных фильтров." : "No findings match the selected filters.",
    selectFinding: ru ? "Выберите находку в списке «Conflicts» панели Wiki." : "Select a finding in the Wiki panel Conflicts list.",
    previous: ru ? "Предыдущая находка" : "Previous finding",
    next: ru ? "Следующая находка" : "Next finding",
    showList: ru ? "Показать список" : "Show list",
    position: (index: number, total: number) => ru ? `${index} из ${total}` : `${index} of ${total}`,
    conflict: ru ? "Противоречие" : "Conflict",
    uncertainty: ru ? "Неопределённость" : "Uncertainty",
    internal: ru ? "внутри страницы" : "within a page",
    stale: ru ? "Устаревший отчёт" : "Stale report",
    staleHelp: ru
      ? "Ни один актуальный отчёт больше не содержит эту находку: страница изменилась после проверки."
      : "No current report still contains this finding: the page changed after it was checked.",
    textChanged: ru ? "Текст изменился" : "Text changed",
    textChangedHelp: ru
      ? "Цитата из отчёта больше не найдена однозначно. Перепроверьте страницу, чтобы обновить находку."
      : "A report quotation can no longer be located unambiguously. Recheck the page to refresh the finding.",
    draftLabel: ru ? "Проверенная страница" : "Checked page",
    sourceLabel: ru ? "Источник" : "Source",
    sameDocumentLabel: ru ? "Та же страница" : "Same page",
    sectionLabel: ru ? "Раздел" : "Section",
    loading: ru ? "Чтение файла…" : "Reading file…",
    readFailed: ru ? "Не удалось прочитать файл" : "Could not read the file",
    contextTruncated: ru ? "Контекст сокращён." : "Context shortened.",
    savedQuote: ru ? "Цитата из отчёта" : "Report quotation",
    openSource: ru ? "Открыть в Preview" : "Open in Preview",
    recheck: ru ? "Перепроверить" : "Recheck",
    rechecking: ru ? "Проверяется…" : "Checking…",
    recheckHelp: ru
      ? "Ставит обычную проверку страниц из отчётов в очередь Wiki. Вызывает модель."
      : "Queues an ordinary check of the reporting pages. This calls the model.",
    resolve: ru ? "Разрулить в новой сессии" : "Resolve in new session",
    resolving: ru ? "Запуск сессии…" : "Starting session…",
    resolveHelp: ru
      ? "Открывает новый чат и поручает агенту разобрать только эту находку по актуальному отчёту страницы."
      : "Opens a new chat asking the agent to resolve only this finding using the page's current report.",
    decisionLabel: ru ? "Решение" : "Decision",
    verdictSide: (name: string) => ru ? `Права: ${name}` : `${name} is right`,
    verdictDifferentScope: ru ? "Разные области" : "Different scope",
    verdictFalsePositive: ru ? "Ложная тревога" : "False positive",
    verdictDeferred: ru ? "Отложить" : "Defer",
    verdictHelp: {
      side: ru ? "Эта сторона авторитетна; другую нужно исправить. Находка остаётся открытой до исправления."
        : "This side is authoritative; the other needs a fix. The finding stays open until fixed.",
      differentScope: ru ? "Утверждения относятся к разным областям; нужно уточнить scope. Находка остаётся открытой."
        : "The claims cover different scopes; clarify them. The finding stays open.",
      falsePositive: ru ? "Не противоречие. Требуется комментарий; находка уходит из открытых."
        : "Not a contradiction. A note is required; the finding leaves the open list.",
      deferred: ru ? "Нужно решение владельца; находка уходит из открытых, но остаётся видимой."
        : "Needs an owner decision; the finding leaves the open list but stays visible.",
    },
    notePlaceholder: ru ? "Почему это не противоречие?" : "Why is this not a contradiction?",
    noteLabel: ru ? "Обоснование" : "Rationale",
    noteOptionalPlaceholder: ru ? "Необязательно: почему выбрано это решение" : "Optional: why this decision",
    noteRequired: ru ? "Для «Ложной тревоги» обоснование обязательно." : "A false positive needs a rationale.",
    saveDecision: ru ? "Сохранить" : "Save",
    cancel: ru ? "Отмена" : "Cancel",
    editSide: ru ? "Править" : "Edit",
    editSideHelp: ru ? "Исправить этот фрагмент прямо здесь. После сохранения отчёт станет устаревшим до перепроверки."
      : "Fix this fragment here. After saving, the report is stale until the page is rechecked.",
    editLabel: ru ? "Текст фрагмента" : "Fragment text",
    saveEdit: ru ? "Сохранить правку" : "Save edit",
    savingEdit: ru ? "Сохраняю…" : "Saving…",
    editHint: ru ? "⌘↵ — сохранить, Esc — отмена" : "⌘↵ — save, Esc — cancel",
    createTask: ru ? "Создать задачу" : "Create task",
    creatingTask: ru ? "Создаю задачу…" : "Creating task…",
    createTaskHelp: ru ? "Создать задачу проекта с обеими цитатами и связать её с отложенной находкой."
      : "Create a project task with both quotations and link it to this deferred finding.",
    openTask: ru ? "Открыть задачу" : "Open task",
    clearDecision: ru ? "Снять решение" : "Clear decision",
    deciding: ru ? "Сохранение решения…" : "Saving decision…",
    decisionPartial: ru ? "Решение сохранено частично: отчёты расходятся." : "Decision saved partially: reports disagree.",
    retryDecision: ru ? "Повторить запись" : "Retry write",
    decisionHotkeys: ru ? "1–5 — решения" : "1–5 — decisions",
    fixPending: ru ? "Ждёт исправления" : "Awaiting fix",
    fixPendingHelp: ru ? "После правки перепроверьте страницу: если противоречие исчезнет, находка закроется."
      : "Recheck the page after the fix: the finding closes once the contradiction is gone.",
    reopened: ru ? "Перепроверка всё ещё находит противоречие" : "Recheck still finds the contradiction",
    reopenedHelp: ru ? "Проверка после решения снова нашла находку. Исправьте текст или выберите решение заново."
      : "A check after the decision found it again. Fix the text or choose a decision again.",
    decidedChip: ru ? "Решено" : "Decided",
    decisionSaved: (label: string) => ru ? `Решение сохранено: ${label}` : `Decision saved: ${label}`,
    decisionCleared: ru ? "Решение снято" : "Decision cleared",
    undo: ru ? "Отменить" : "Undo",
    checkedAt: ru ? "Проверено" : "Checked",
    createdAt: ru ? "Создан" : "Created",
    changedAt: ru ? "Изменён" : "Changed",
    quoteChangedAt: ru ? "Цитата изменена" : "Quote changed",
    fileModifiedAt: ru ? "Файл изменён" : "File modified",
    notCommitted: ru ? "не закоммичено" : "not committed",
    notCommittedHelp: ru ? "Есть незакоммиченные правки; показано время изменения файла на диске."
      : "There are uncommitted edits; the file-system modification time is shown.",
    newerSide: ru ? "Новее" : "Newer",
    newerSideHelp: ru ? "Цитата на этой стороне изменялась позже." : "The quoted text on this side changed more recently.",
    model: ru ? "Модель" : "Model",
    reports: ru ? "В отчётах" : "Reported by",
    keyboardHint: ru ? "j/k или ↑/↓ — находки, [ и ] — группы, Space — в корзину" : "j/k or ↑/↓ — findings, [ and ] — groups, Space — basket",
    basketAdd: ru ? "В корзину" : "Add to basket",
    basketRemove: ru ? "Убрать из корзины" : "Remove from basket",
    basketToggleHelp: ru
      ? "Корзина собирает находки для одной агентской сессии."
      : "The basket collects findings for one agent session.",
    basketFull: ru ? "Корзина заполнена" : "Basket is full",
    basketSummary: (findings: number, pages: number) => ru
      ? `Корзина: ${findings} ${plural(findings, "находка", "находки", "находок")} · ${pages} ${plural(pages, "страница", "страницы", "страниц")}`
      : `Basket: ${findings} finding${findings === 1 ? "" : "s"} · ${pages} page${pages === 1 ? "" : "s"}`,
    basketResolve: ru ? "Разрулить в новой сессии" : "Resolve in new session",
    basketResolveHelp: ru
      ? "Открывает новый чат и передаёт агенту все находки корзины вместе с вашими решениями."
      : "Opens a new chat handing all basket findings and your decisions to the agent.",
    basketClear: ru ? "Очистить" : "Clear",
    basketSkipped: (count: number) => ru
      ? `Пропущено находок без актуального отчёта: ${count}. Они остались в корзине.`
      : `Skipped ${count} finding${count === 1 ? "" : "s"} without a current report; they stay in the basket.`,
  };
}

export type WikiConflictsText = ReturnType<typeof wikiConflictsText>;

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Russian plural form for a count: one, few (2–4), many. */
function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Side verdict for one displayed column: columns show draft then existing, verdicts use canonical order. */
export function wikiColumnVerdict(finding: Pick<WikiFinding, "draft" | "existing">, column: 0 | 1): "side-a" | "side-b" {
  const citation = column === 0 ? finding.draft : finding.existing;
  return knowledgeFindingSides(finding.draft, finding.existing)[0] === citation ? "side-a" : "side-b";
}

/** Short verdict label; sides follow the canonical finding order (file name, or line within one page). */
export function wikiVerdictLabel(text: WikiConflictsText, finding: Pick<WikiFinding, "draft" | "existing" | "internal">,
  verdict: KnowledgeFindingVerdict): string {
  const side = (citation: KnowledgeCitation) => finding.internal ? `L${citation.startLine}` : fileName(citation.path);
  const [first, second] = knowledgeFindingSides(finding.draft, finding.existing);
  switch (verdict) {
    case "side-a": return text.verdictSide(side(first));
    case "side-b": return text.verdictSide(side(second));
    case "different-scope": return text.verdictDifferentScope;
    case "false-positive": return text.verdictFalsePositive;
    case "deferred": return text.verdictDeferred;
  }
}
