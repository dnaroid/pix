import type { KnowledgeCitation, KnowledgeReportLanguage } from "./contract.js";
import type { SavedKnowledgeReport } from "./stamp.js";
import { knowledgeFindingId, type KnowledgeFindingDecision } from "./decisions.js";

/**
 * Read-only projection of saved Wiki contradiction reports for the Wiki Conflicts tab.
 * It never calls a model or search and retains only bounded citations, never document bodies.
 */

export type WikiFindingKind = "conflict" | "uncertainty";

/** One finding from one page's saved report. */
export interface WikiPageFinding {
  readonly id: string;
  readonly kind: WikiFindingKind;
  /** Both quotations come from the same page. */
  readonly internal: boolean;
  /** Side from the reporting page. */
  readonly draft: KnowledgeCitation;
  /** Side from the compared source (or the same page for internal findings). */
  readonly existing: KnowledgeCitation;
  readonly explanation: string;
  readonly reportPath: string;
  readonly checkedAt: string;
  /** The saved report still matches the current page body. */
  readonly current: boolean;
  readonly modelRef: string;
  readonly reportLanguage?: KnowledgeReportLanguage;
  /** The user's verdict recorded in this page's report. */
  readonly decision?: KnowledgeFindingDecision;
}

/** A finding merged across every saved report that contains it (A↔B and B↔A are one finding). */
export interface WikiFinding extends WikiPageFinding {
  /** Sorted project paths of pages whose saved reports contain this finding. */
  readonly reportPaths: readonly string[];
  /** No current report contains the finding any longer. */
  readonly stale: boolean;
  /** Reports containing the finding disagree on its decision (a write failed part-way). */
  readonly decisionPartial: boolean;
  /** A fix verdict exists, but a current report checked after it still contains the finding. */
  readonly reopened?: boolean;
}

/**
 * `fix-pending` = a fix verdict (a side or different scope) awaits a recheck; it
 * still counts as open. `decided` = accepted as a false positive or deferred.
 */
export type WikiFindingStatus = "open" | "fix-pending" | "decided" | "stale";

export interface WikiFindingGroup {
  readonly key: string;
  readonly label: string;
  readonly findings: readonly WikiFinding[];
}

export interface WikiFindingFilter {
  readonly kind?: WikiFindingKind | "internal";
  /** `open` also matches `fix-pending`: both are unresolved. */
  readonly status?: WikiFindingStatus;
  /** Project-relative folder or file prefix; matches either side. */
  readonly branch?: string;
}

export interface WikiFindingSummary {
  readonly conflicts: number;
  readonly uncertainties: number;
  readonly internal: number;
  /** Fix verdicts awaiting a recheck; included in conflicts/uncertainties. */
  readonly fixPending: number;
  /** Accepted or deferred; excluded from conflicts/uncertainties. */
  readonly decided: number;
  readonly stale: number;
  readonly total: number;
}

export const MAX_WIKI_FINDINGS = 2_000;

/** Stable identity shared with saved decisions; see {@link knowledgeFindingId}. */
export const wikiFindingId: (kind: WikiFindingKind, first: KnowledgeCitation, second: KnowledgeCitation) => Promise<string>
  = knowledgeFindingId;

const fixVerdict = (verdict: KnowledgeFindingDecision["verdict"] | undefined) =>
  verdict === "side-a" || verdict === "side-b" || verdict === "different-scope";

export function wikiFindingStatus(finding: WikiFinding): WikiFindingStatus {
  if (finding.stale) return "stale";
  const verdict = finding.decision?.verdict;
  if (verdict === "false-positive" || verdict === "deferred") return "decided";
  return fixVerdict(verdict) && !finding.reopened ? "fix-pending" : "open";
}

function matchesStatus(finding: WikiFinding, status: WikiFindingStatus): boolean {
  const actual = wikiFindingStatus(finding);
  return actual === status || (status === "open" && actual === "fix-pending");
}

/** Projects one page's saved report; findings whose draft side belongs to another page are ignored. */
export async function projectWikiPageFindings(report: SavedKnowledgeReport, projectPath: string): Promise<WikiPageFinding[]> {
  const { result } = report;
  if (result.status === "clear" || result.path !== projectPath) return [];
  const sources: [WikiFindingKind, readonly SavedKnowledgeReport["result"]["conflicts"][number][]][] = [
    ["conflict", result.conflicts],
    ["uncertainty", result.uncertainties ?? []],
  ];
  const seen = new Set<string>();
  const decisions = new Map((report.decisions ?? []).map(decision => [decision.findingId, decision]));
  const findings: WikiPageFinding[] = [];
  for (const [kind, items] of sources) {
    for (const item of items) {
      if (item.draft.path !== projectPath) continue;
      const id = await wikiFindingId(kind, item.draft, item.existing);
      if (seen.has(id)) continue;
      seen.add(id);
      const decision = decisions.get(id);
      findings.push({
        id, kind, internal: item.existing.path === projectPath,
        draft: item.draft, existing: item.existing, explanation: item.explanation,
        reportPath: projectPath, checkedAt: report.checkedAt, current: report.current,
        modelRef: result.modelRef,
        ...(result.reportLanguage ? { reportLanguage: result.reportLanguage } : {}),
        ...(decision ? { decision } : {}),
      });
    }
  }
  return findings;
}

const pairKey = (finding: WikiPageFinding) =>
  finding.internal ? finding.draft.path : [finding.draft.path, finding.existing.path].sort().join("\u0000");

function preferred(candidate: WikiPageFinding, current: WikiPageFinding): boolean {
  if (candidate.current !== current.current) return candidate.current;
  if (candidate.checkedAt !== current.checkedAt) return candidate.checkedAt > current.checkedAt;
  return candidate.reportPath < current.reportPath;
}

function order(left: WikiFinding, right: WikiFinding): number {
  if (left.stale !== right.stale) return left.stale ? 1 : -1;
  const leftKey = pairKey(left), rightKey = pairKey(right);
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  if (left.kind !== right.kind) return left.kind === "conflict" ? -1 : 1;
  if (left.draft.startLine !== right.draft.startLine) return left.draft.startLine - right.draft.startLine;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Merges per-page projections; the newest current report supplies the displayed sides. */
export function mergeWikiFindings(
  pages: Iterable<readonly WikiPageFinding[]>,
  limit = MAX_WIKI_FINDINGS,
): { readonly findings: readonly WikiFinding[]; readonly truncated: boolean } {
  const merged = new Map<string, { representative: WikiPageFinding; paths: Set<string>; current: boolean;
    reports: WikiPageFinding[] }>();
  for (const page of pages) {
    for (const finding of page) {
      const entry = merged.get(finding.id);
      if (!entry) {
        merged.set(finding.id, { representative: finding, paths: new Set([finding.reportPath]), current: finding.current,
          reports: [finding] });
        continue;
      }
      entry.paths.add(finding.reportPath);
      entry.current ||= finding.current;
      entry.reports.push(finding);
      if (preferred(finding, entry.representative)) entry.representative = finding;
    }
  }
  const findings = [...merged.values()].map(({ representative, paths, current, reports }): WikiFinding => {
    // The newest decision wins; disagreement among reports is surfaced, never hidden.
    const decision = reports.reduce<KnowledgeFindingDecision | undefined>(
      (newest, { decision: item }) => item && (!newest || item.at > newest.at) ? item : newest, undefined);
    const { decision: _ignored, ...base } = representative;
    // A report checked after the decision without it is a newer check, not a failed write.
    const decisionPartial = !!decision && reports.some(report => !sameDecision(report.decision, decision)
      && (report.decision !== undefined || report.checkedAt <= decision.at));
    const reopened = !!decision && fixVerdict(decision.verdict)
      && reports.some(report => report.current && report.checkedAt > decision.at);
    return {
      ...base, ...(decision ? { decision } : {}), reportPaths: [...paths].sort(), stale: !current,
      decisionPartial, ...(reopened ? { reopened } : {}),
    };
  }).sort(order);
  const bound = Math.max(0, Math.floor(limit));
  return { findings: findings.slice(0, bound), truncated: findings.length > bound };
}

function sameDecision(left: KnowledgeFindingDecision | undefined, right: KnowledgeFindingDecision | undefined): boolean {
  return left === right || (!!left && !!right && left.verdict === right.verdict && left.note === right.note
    && left.taskId === right.taskId && left.at === right.at);
}

function withinBranch(path: string, branch: string): boolean {
  const prefix = branch.replace(/\/+$/u, "");
  return !prefix || path === prefix || path.startsWith(`${prefix}/`);
}

export function filterWikiFindings(findings: readonly WikiFinding[], filter: WikiFindingFilter): WikiFinding[] {
  return findings.filter(finding => {
    if (filter.kind === "internal" ? !finding.internal : filter.kind && finding.kind !== filter.kind) return false;
    if (filter.status && !matchesStatus(finding, filter.status)) return false;
    return !filter.branch || withinBranch(finding.draft.path, filter.branch) || withinBranch(finding.existing.path, filter.branch);
  });
}

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** Pair groups keep one discussion per document pair; page groups mirror per-page reports. */
export function groupWikiFindings(findings: readonly WikiFinding[], by: "pair" | "page"): WikiFindingGroup[] {
  const groups = new Map<string, { label: string; findings: WikiFinding[] }>();
  const add = (key: string, label: string, finding: WikiFinding) => {
    const group = groups.get(key) ?? { label, findings: [] };
    group.findings.push(finding);
    groups.set(key, group);
  };
  for (const finding of findings) {
    if (by === "page") {
      for (const path of finding.reportPaths) add(path, path, finding);
      continue;
    }
    const [first, second] = [finding.draft.path, finding.existing.path].sort();
    if (finding.internal) add(first!, first!, finding);
    else add(`${first}\u0000${second}`, `${fileName(first!)} ↔ ${fileName(second!)}`, finding);
  }
  return [...groups.entries()].map(([key, group]) => ({ key, label: group.label, findings: group.findings }));
}

export function summarizeWikiFindings(findings: readonly WikiFinding[]): WikiFindingSummary {
  let conflicts = 0, uncertainties = 0, internal = 0, fixPending = 0, decided = 0, stale = 0;
  for (const finding of findings) {
    const status = wikiFindingStatus(finding);
    if (status === "stale") stale++;
    else if (status === "decided") decided++;
    else {
      if (finding.kind === "conflict") conflicts++;
      else uncertainties++;
      if (status === "fix-pending") fixPending++;
    }
    if (finding.internal) internal++;
  }
  return { conflicts, uncertainties, internal, fixPending, decided, stale, total: findings.length };
}
