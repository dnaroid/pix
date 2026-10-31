import type { KnowledgeCheckResult, KnowledgeCitation } from "./contract.js";

/**
 * User verdicts on individual findings of a saved Wiki report. They are display
 * state only: the judge never receives them as suppression hints.
 */

export type KnowledgeFindingKind = "conflict" | "uncertainty";

/** `side-a`/`side-b` refer to the canonical side order of {@link knowledgeFindingSides}. */
export const KNOWLEDGE_FINDING_VERDICTS = ["side-a", "side-b", "different-scope", "false-positive", "deferred"] as const;
export type KnowledgeFindingVerdict = typeof KNOWLEDGE_FINDING_VERDICTS[number];

export interface KnowledgeFindingDecision {
  readonly findingId: string;
  readonly verdict: KnowledgeFindingVerdict;
  /** Required for `false-positive`; optional otherwise. */
  readonly note?: string;
  /** Project task created for a `deferred` finding by the explicit «Create task» action. */
  readonly taskId?: string;
  readonly at: string;
}

export const MAX_KNOWLEDGE_DECISION_NOTE_CHARS = 1_000;
export const MAX_KNOWLEDGE_DECISIONS = 500;

const DECISION_KEYS = ["findingId", "verdict", "note", "taskId", "at"];
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export function canonicalKnowledgeDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

export function isKnowledgeFindingDecision(value: unknown): value is KnowledgeFindingDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const decision = value as Record<string, unknown>;
  if (Object.keys(decision).some(key => !DECISION_KEYS.includes(key))) return false;
  if (typeof decision.findingId !== "string" || !/^[0-9a-f]{64}$/u.test(decision.findingId)) return false;
  if (!KNOWLEDGE_FINDING_VERDICTS.includes(decision.verdict as KnowledgeFindingVerdict)) return false;
  if (!canonicalKnowledgeDate(decision.at)) return false;
  if ("note" in decision) {
    if (typeof decision.note !== "string" || !decision.note.trim() || decision.note !== decision.note.trim()
      || decision.note.length > MAX_KNOWLEDGE_DECISION_NOTE_CHARS) return false;
  }
  if ("taskId" in decision && (decision.verdict !== "deferred" || typeof decision.taskId !== "string"
    || !TASK_ID.test(decision.taskId))) return false;
  return decision.verdict !== "false-positive" || typeof decision.note === "string";
}

/** Decisions are unique per finding and bounded. */
export function isKnowledgeDecisionList(value: unknown): value is readonly KnowledgeFindingDecision[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_KNOWLEDGE_DECISIONS) return false;
  const ids = new Set<string>();
  for (const item of value) {
    if (!isKnowledgeFindingDecision(item) || ids.has(item.findingId)) return false;
    ids.add(item.findingId);
  }
  return true;
}

const normalizedQuote = (quote: string) => quote.replace(/\r\n?/gu, "\n");

function compareSide(left: readonly [string, string], right: readonly [string, string]): number {
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0;
}

/** Orders the two sides independently of which page reported the finding. */
export function knowledgeFindingSides(first: KnowledgeCitation, second: KnowledgeCitation): readonly [KnowledgeCitation, KnowledgeCitation] {
  return compareSide([first.path, normalizedQuote(first.quote)], [second.path, normalizedQuote(second.quote)]) <= 0
    ? [first, second] : [second, first];
}

async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Stable identity: independent of line numbers, model output order and the reporting page. */
export async function knowledgeFindingId(kind: KnowledgeFindingKind, first: KnowledgeCitation, second: KnowledgeCitation): Promise<string> {
  const [a, b] = knowledgeFindingSides(first, second);
  return sha256(JSON.stringify([kind, [[a.path, normalizedQuote(a.quote)], [b.path, normalizedQuote(b.quote)]]]));
}

/** Every finding id of a report, including findings whose draft side is another page. */
export async function knowledgeResultFindingIds(result: KnowledgeCheckResult): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const item of result.conflicts) ids.add(await knowledgeFindingId("conflict", item.draft, item.existing));
  for (const item of result.uncertainties ?? []) ids.add(await knowledgeFindingId("uncertainty", item.draft, item.existing));
  return ids;
}

/** Keeps only decisions whose findings the new report still contains. */
export async function carryKnowledgeDecisions(decisions: readonly KnowledgeFindingDecision[] | undefined,
  result: KnowledgeCheckResult): Promise<KnowledgeFindingDecision[]> {
  if (!decisions?.length || result.status === "clear") return [];
  const ids = await knowledgeResultFindingIds(result);
  return decisions.filter(decision => ids.has(decision.findingId));
}
