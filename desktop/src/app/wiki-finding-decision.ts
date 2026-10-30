import {
  decideWikiFinding, wikiDecisionInput, type WikiFindingDecisionInput,
} from "../../../acp/src/knowledge/finding-decision";
import type { WikiFinding } from "../lib/wiki-conflicts-index";

export {
  decideWikiFinding, wikiDecisionInput,
  type DecideWikiFindingOptions, type WikiFindingDecisionInput, type WikiFindingDecisionOutcome,
} from "../../../acp/src/knowledge/finding-decision";

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
