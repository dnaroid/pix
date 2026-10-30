import type { KnowledgeFindingVerdict } from "../../../acp/src/knowledge/decisions";
import { readKnowledgeReport, recordKnowledgeDecision } from "../../../acp/src/knowledge/stamp";
import { projectWikiPageFindings, type WikiFinding } from "../lib/wiki-conflicts-index";

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

interface DecideWikiFindingOptions {
  /** Reads the raw current project file, including hidden report metadata. */
  readonly read: (path: string, signal: AbortSignal) => Promise<string>;
  /** Compare-and-swap write; false when the file changed or the owner went away. */
  readonly write: (path: string, content: string, expectedContent: string) => Promise<boolean>;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

/** Offer to restore the previous decision; the caller shows it as a short-lived toast. */
export interface WikiFindingUndoOffer {
  readonly key: string;
  readonly finding: WikiFinding;
  readonly decision: WikiFindingDecisionInput | null;
  readonly undo: () => Promise<boolean>;
}

interface WikiFindingDeciderOptions {
  readonly read: (path: string, signal: AbortSignal) => Promise<string>;
  /** Writer fenced to the project generation current when the operation starts. */
  readonly writer: () => {
    readonly isCurrent: () => boolean;
    readonly write: (path: string, content: string, expectedContent: string) => Promise<boolean>;
  };
  readonly refresh: () => void;
  readonly reportError: (error: unknown) => void;
  readonly offerUndo?: (offer: WikiFindingUndoOffer) => void;
}

/**
 * Applies verdicts for the comparison tab. Every operation (including undo)
 * captures its own project fence; a successful change offers an undo that
 * restores the previous decision with its original timestamp, so the
 * recheck-after-decision comparison stays the same.
 */
export function createWikiFindingDecider(options: WikiFindingDeciderOptions) {
  async function apply(finding: WikiFinding, decision: WikiFindingDecisionInput | null, at?: string): Promise<boolean> {
    const writer = options.writer();
    const controller = new AbortController();
    try {
      await decideWikiFinding(finding, decision, {
        signal: controller.signal,
        read: async (path, signal) => {
          const content = await options.read(path, signal);
          if (!writer.isCurrent()) controller.abort();
          return content;
        },
        write: writer.write,
        ...(at ? { now: () => new Date(at) } : {}),
      });
      return writer.isCurrent();
    } catch (error) {
      if (writer.isCurrent()) options.reportError(error);
      return false;
    } finally {
      if (writer.isCurrent()) options.refresh();
    }
  }

  async function decide(finding: WikiFinding, decision: WikiFindingDecisionInput | null): Promise<boolean> {
    const previous = finding.decision;
    if (!(await apply(finding, decision))) return false;
    options.offerUndo?.({
      key: `wiki-decision:${finding.id}`, finding, decision,
      undo: () => apply(finding,
        previous ? wikiDecisionInput(previous) : null, previous?.at),
    });
    return true;
  }

  return { decide };
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
