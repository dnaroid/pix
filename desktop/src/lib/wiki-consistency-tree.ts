import { readKnowledgeCheckStamp, readKnowledgeReport } from "../../../acp/src/knowledge/stamp";
import { projectWikiPageFindings, type WikiPageFinding } from "./wiki-conflicts-index";

export type WikiConsistencyStatus = "clear" | "conflicts" | "unknown";

export interface WikiConsistencySummary {
  readonly status: WikiConsistencyStatus;
  readonly documents: number;
  readonly clear: number;
  readonly conflicts: number;
  readonly unknown: number;
  /**
   * Pages whose saved conflicts were all accepted (false positive) or deferred.
   * Display-only: it never changes `status`; the tree shows a neutral icon.
   */
  readonly accepted: number;
  readonly complete: boolean;
}

interface Counts { documents: number; clear: number; conflicts: number; unknown: number; accepted: number; }
interface FileState { readonly status: WikiConsistencyStatus; readonly accepted: boolean; }

const emptyCounts = (): Counts => ({ documents: 0, clear: 0, conflicts: 0, unknown: 0, accepted: 0 });

function pagePath(path: string): boolean {
  return /\.(?:md|markdown)$/iu.test(path) && !/[\\\u0000-\u001f\u007f:]/u.test(path)
    && path.split("/").every(part => !!part && !part.startsWith("."));
}

function summarize(counts: Counts, complete: boolean): WikiConsistencySummary {
  const status = counts.conflicts > 0 ? "conflicts"
    : complete && counts.documents > 0 && counts.clear === counts.documents ? "clear" : "unknown";
  return { ...counts, status, complete };
}

/** Counts include every discovered Markdown page, independently of tree expansion. */
export function createWikiConsistencyIndex() {
  const files = new Map<string, FileState>();
  const folders = new Map<string, Counts>();

  function updateAncestors(path: string, previous: FileState | undefined, next: FileState | undefined): void {
    let separator = path.lastIndexOf("/");
    while (true) {
      const directory = separator < 0 ? "" : path.slice(0, separator);
      const counts = folders.get(directory) ?? emptyCounts();
      if (previous !== undefined) { counts[previous.status]--; counts.documents--; if (previous.accepted) counts.accepted--; }
      if (next !== undefined) { counts[next.status]++; counts.documents++; if (next.accepted) counts.accepted++; }
      if (counts.documents > 0) folders.set(directory, counts);
      else folders.delete(directory);
      if (separator < 0) break;
      separator = path.lastIndexOf("/", separator - 1);
    }
  }

  return {
    set(path: string, status: WikiConsistencyStatus, accepted = false): boolean {
      if (!pagePath(path)) return false;
      const previous = files.get(path);
      // An accepted page is never red; the flag only qualifies a non-conflict status.
      const next: FileState = { status, accepted: accepted && status !== "conflicts" };
      if (previous?.status === next.status && previous.accepted === next.accepted) return false;
      files.set(path, next);
      updateAncestors(path, previous, next);
      return true;
    },
    delete(path: string): boolean {
      const previous = files.get(path);
      if (previous === undefined) return false;
      files.delete(path);
      updateAncestors(path, previous, undefined);
      return true;
    },
    clear(): void { files.clear(); folders.clear(); },
    summary(path: string, complete: boolean): WikiConsistencySummary {
      const file = files.get(path);
      if (file !== undefined) {
        const counts = emptyCounts();
        counts.documents = 1; counts[file.status] = 1; counts.accepted = file.accepted ? 1 : 0;
        // A verified file's own status does not await discovery of unrelated folders.
        return summarize(counts, true);
      }
      return summarize(folders.get(path) ?? emptyCounts(), complete);
    },
  };
}

export interface WikiConsistencyClassification {
  readonly status: WikiConsistencyStatus;
  /** Bounded citations from the saved report, including stale reports; never the document body. */
  readonly findings: readonly WikiPageFinding[];
  /** Present (true) when the page has conflicts and every one is false-positive or deferred. */
  readonly accepted?: true;
}

/** Reuse the same bounded metadata validators as the report and green-file UI. */
export async function classifyWikiConsistency(content: string, projectPath: string): Promise<WikiConsistencyClassification> {
  const report = await readKnowledgeReport(content);
  const findings = report ? await projectWikiPageFindings(report, projectPath) : [];
  // Conflicts accepted as false positives or deferred no longer turn the page red.
  const conflicts = findings.filter(finding => finding.kind === "conflict");
  const undecided = conflicts.some(finding =>
    finding.decision?.verdict !== "false-positive" && finding.decision?.verdict !== "deferred");
  if (report?.current && report.result.path === projectPath && report.result.status === "conflicts"
    && report.result.conflicts.length > 0 && undecided
    && report.result.conflicts.every(finding => finding.draft.path === projectPath)) return { status: "conflicts", findings };
  const status = await readKnowledgeCheckStamp(content) ? "clear" : "unknown";
  // Only a current report of this page can mark it accepted; stale decisions stay neutral without an icon.
  const accepted = !!report?.current && report.result.path === projectPath && conflicts.length > 0 && !undecided;
  return { status, findings, ...(accepted ? { accepted: true as const } : {}) };
}

export async function savedWikiConsistencyStatus(content: string, projectPath: string): Promise<WikiConsistencyStatus> {
  return (await classifyWikiConsistency(content, projectPath)).status;
}

/** Color is accompanied by an accessible description and the recursive page counts. */
export function wikiConsistencyDescription(summary: WikiConsistencySummary, kind: "file" | "directory"): string {
  if (kind === "file") {
    if (summary.status === "conflicts") return "В сохранённой версии найдены противоречия.";
    if (summary.accepted) return "Все найденные противоречия признаны ложными или отложены; исправлять их сейчас не требуется.";
    if (summary.status === "clear") return "Сохранённая версия прошла последнюю проверку на противоречия.";
    return "Нет актуальной успешной проверки: документ не проверен, изменён или проверка неполная.";
  }
  const counts = `Документов: ${summary.documents}; зелёных: ${summary.clear}; с противоречиями: ${summary.conflicts}; без актуальной успешной проверки: ${summary.unknown}.`
    + (summary.accepted ? ` Противоречия признаны допустимыми или отложены: ${summary.accepted}.` : "");
  if (summary.status === "conflicts") return `Внутри есть документы с противоречиями. ${counts}${summary.complete ? "" : " Обход ещё не завершён."}`;
  if (!summary.complete) return `Состояние документов обновляется. ${counts}`;
  if (!summary.documents) return "Внутри нет документов Markdown для проверки.";
  if (summary.status === "clear") return `Все документы внутри рекурсивно зелёные. ${counts}`;
  return `Внутри есть документы без актуальной успешной проверки. ${counts}`;
}
