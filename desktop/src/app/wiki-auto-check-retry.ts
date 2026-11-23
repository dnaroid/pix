import { reportMessage, type KnowledgeReportMessage } from "../../../acp/src/knowledge/report-language";
import type { ProjectKnowledgeJob } from "./project-knowledge-queue.svelte";

/** Pauses before re-sending a version whose check failed for a likely transient reason. */
export const WIKI_AUTO_CHECK_TRANSIENT_RETRY_MS = [60_000, 300_000] as const;
/** One later retry of any other incomplete version (for example an unverifiable quotation). */
export const WIKI_AUTO_CHECK_INCOMPLETE_RETRY_MS = 600_000;

/** In-memory retry budget of one logical body version within the current pass. */
export interface WikiAutoCheckRetry {
  readonly hash: string;
  readonly transient: number;
  readonly incomplete: boolean;
  /** Due time of the scheduled retry; undefined once it has been queued. */
  at?: number;
}

// Application-owned notices whose cause is a race or malformed model output,
// not the document itself. Exact localized strings, never free-text matching.
const localized = (keys: readonly KnowledgeReportMessage[]) =>
  keys.flatMap(key => [reportMessage("en", key), reportMessage("ru", key)]);
const TRANSIENT_NOTICES = new Set(localized([
  "corpusChanged", "corpusChangedRetrieval", "documentChanged", "inventoryIncomplete",
  "responseEmpty", "responseJson", "responseSchema",
]));
// Source races arrive wrapped by sourceInvalid(): "<prefix><path>. <reason>".
const TRANSIENT_SOURCE_REASONS = localized([
  "sourceChangedOpening", "sourcePathChanged", "sourceChangedReading", "sourceDisappeared",
]).map(reason => ". " + reason);
const transientNotice = (notice: string) => TRANSIENT_NOTICES.has(notice)
  || TRANSIENT_SOURCE_REASONS.some(reason => notice.endsWith(reason));

type RetryCause = "transient" | "incomplete";

export function wikiAutoCheckRetryCause(job: ProjectKnowledgeJob): RetryCause | undefined {
  if (job.state === "failed") return "transient";
  const result = job.result;
  if (job.state !== "completed" || result?.status !== "incomplete") return undefined;
  // Grounded uncertainties without diagnostics need a human decision; a rerun cannot help.
  if ((result.uncertainties?.length ?? 0) > 0 && result.notices.length === 0) return undefined;
  return result.notices.some(transientNotice) ? "transient" : "incomplete";
}

/** Next retry of this version, or undefined when its budget is spent or a rerun is pointless. */
export function planWikiAutoCheckRetry(previous: WikiAutoCheckRetry | undefined, job: ProjectKnowledgeJob,
  hash: string, now: number): WikiAutoCheckRetry | undefined {
  const cause = wikiAutoCheckRetryCause(job);
  if (!cause) return undefined;
  const budget = previous?.hash === hash ? previous : { hash, transient: 0, incomplete: false };
  if (cause === "transient" && budget.transient < WIKI_AUTO_CHECK_TRANSIENT_RETRY_MS.length) {
    return { hash, transient: budget.transient + 1, incomplete: budget.incomplete,
      at: now + WIKI_AUTO_CHECK_TRANSIENT_RETRY_MS[budget.transient]! };
  }
  if (job.state === "completed" && !budget.incomplete) {
    return { hash, transient: budget.transient, incomplete: true, at: now + WIKI_AUTO_CHECK_INCOMPLETE_RETRY_MS };
  }
  return undefined;
}
