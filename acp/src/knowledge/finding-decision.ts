import type { KnowledgeFindingVerdict } from "./decisions.js";
import { projectWikiPageFindings, type WikiFinding } from "./findings.js";
import { readKnowledgeReport, recordKnowledgeDecision } from "./stamp.js";

/**
 * Records user/agent verdicts in every saved report containing a finding.
 * Shared by the Desktop Conflicts tab and the `wiki_conflicts` agent tool;
 * I/O is injected so callers keep their own fencing and write strategy.
 */

export interface WikiFindingDecisionInput {
  readonly verdict: KnowledgeFindingVerdict;
  readonly note?: string;
  /** Linked project task; only valid with the `deferred` verdict. */
  readonly taskId?: string;
}

/** Editable part of a saved decision (drops identity and timestamp). */
export function wikiDecisionInput(decision: Pick<WikiFindingDecisionInput, "verdict" | "note" | "taskId">): WikiFindingDecisionInput {
  return { verdict: decision.verdict, ...(decision.note ? { note: decision.note } : {}), ...(decision.taskId ? { taskId: decision.taskId } : {}) };
}

export interface DecideWikiFindingOptions {
  /** Reads the raw current project file, including hidden report metadata. */
  readonly read: (path: string, signal: AbortSignal) => Promise<string>;
  /** Compare-and-swap write; false when the file changed or the owner went away. */
  readonly write: (path: string, content: string, expectedContent: string) => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export interface WikiFindingDecisionOutcome {
  readonly written: readonly string[];
  readonly failed: readonly string[];
}

/**
 * Records (or with `null` clears) one verdict in every existing report that
 * contains the finding. No report block is created; written files are not
 * rolled back when another write fails, and the merged projection then shows
 * the decision as partially saved.
 */
export async function decideWikiFinding(finding: WikiFinding, decision: WikiFindingDecisionInput | null,
  options: DecideWikiFindingOptions): Promise<WikiFindingDecisionOutcome> {
  const signal = options.signal ?? new AbortController().signal;
  const at = (options.now?.() ?? new Date()).toISOString();
  const note = decision?.note?.trim();
  const written: string[] = [], failed: string[] = [];
  let matched = 0;
  for (const path of finding.reportPaths) {
    signal.throwIfAborted();
    try {
      const content = await options.read(path, signal);
      signal.throwIfAborted();
      const report = await readKnowledgeReport(content);
      if (!report || !(await projectWikiPageFindings(report, path)).some(item => item.id === finding.id)) continue;
      matched++;
      const next = await recordKnowledgeDecision(content, finding.id,
        decision ? { verdict: decision.verdict, ...(note ? { note } : {}), ...(decision.taskId ? { taskId: decision.taskId } : {}), at } : null);
      if (next === content) { written.push(path); continue; }
      signal.throwIfAborted();
      (await options.write(path, next, content) ? written : failed).push(path);
    } catch (error) {
      if (signal.aborted) throw error;
      failed.push(path);
    }
  }
  const russian = finding.reportLanguage === "ru";
  if (!matched && !failed.length) throw new Error(russian
    ? "Ни один отчёт больше не содержит эту находку. Перепроверьте страницу."
    : "No report contains this finding any longer. Recheck the page.");
  if (failed.length) throw new Error(russian
    ? `Решение сохранено частично: не удалось записать ${failed.join(", ")}. Повторите запись.`
    : `The decision was saved partially: could not write ${failed.join(", ")}. Try again.`);
  return { written, failed };
}
