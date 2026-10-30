import { readKnowledgeReport, type SavedKnowledgeReport } from "../../../acp/src/knowledge/stamp";
import {
  MAX_KNOWLEDGE_BATCH_FINDINGS,
  type KnowledgeBatchResolutionItem,
  type KnowledgeBatchResolutionRequest,
  type KnowledgeResolutionRequest,
} from "../lib/knowledge-resolution";
import { projectWikiPageFindings, type WikiFinding, type WikiPageFinding } from "../lib/wiki-conflicts-index";

interface ResolveWikiFindingOptions {
  readonly workspace: string;
  /** Reads the raw current project file, including hidden report metadata. */
  readonly read: (path: string, signal: AbortSignal) => Promise<string>;
  readonly start: (request: KnowledgeResolutionRequest) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

interface ResolveWikiFindingsOptions extends Omit<ResolveWikiFindingOptions, "start"> {
  readonly start: (request: KnowledgeBatchResolutionRequest) => void | Promise<void>;
}

interface CurrentFindingTarget {
  readonly path: string;
  readonly content: string;
  readonly report: SavedKnowledgeReport;
  readonly match: WikiPageFinding;
}

/**
 * Finds a reporting page whose saved report still matches its current body and
 * still contains the finding. The representative report is tried first.
 */
async function currentFindingTarget(finding: WikiFinding, read: ResolveWikiFindingOptions["read"],
  signal: AbortSignal): Promise<CurrentFindingTarget | null> {
  const paths = [finding.reportPath, ...finding.reportPaths.filter(path => path !== finding.reportPath)];
  for (const path of paths) {
    const content = await read(path, signal);
    signal.throwIfAborted();
    const report = await readKnowledgeReport(content);
    if (!report?.current) continue;
    const page = await projectWikiPageFindings(report, path);
    const match = page.find(item => item.id === finding.id);
    if (match) return { path, content, report, match };
  }
  return null;
}

const focusOf = (match: WikiPageFinding) => ({
  kind: match.kind, draft: match.draft, existing: match.existing, explanation: match.explanation,
});

const goneMessage = (ru: boolean) => ru
  ? "Ни один актуальный отчёт больше не содержит эту находку. Перепроверьте страницу."
  : "No current report contains this finding any longer. Recheck the page.";

/**
 * Starts a resolution session for one finding, bound to a reporting page whose
 * saved report still matches its current body. Stale reports are refused.
 */
export async function resolveWikiFinding(finding: WikiFinding, options: ResolveWikiFindingOptions): Promise<void> {
  const signal = options.signal ?? new AbortController().signal;
  const target = await currentFindingTarget(finding, options.read, signal);
  if (!target) throw new Error(goneMessage(finding.reportLanguage === "ru"));
  await options.start({
    workspace: options.workspace,
    result: target.report.result,
    content: target.content,
    saved: true,
    focus: focusOf(target.match),
  });
}

export interface ResolveWikiFindingsResult {
  /** Findings handed off to the session. */
  readonly sent: readonly string[];
  /** Findings no current report contains any longer; they are not handed off. */
  readonly skipped: readonly string[];
}

/**
 * Starts one session for a basket of findings. Findings without a current report
 * are skipped rather than failing the batch; an empty result is refused.
 */
export async function resolveWikiFindings(findings: readonly WikiFinding[],
  options: ResolveWikiFindingsOptions): Promise<ResolveWikiFindingsResult> {
  const signal = options.signal ?? new AbortController().signal;
  const ru = findings.some(finding => finding.reportLanguage === "ru");
  if (findings.length > MAX_KNOWLEDGE_BATCH_FINDINGS) throw new Error(ru
    ? `В одну сессию можно передать не больше ${MAX_KNOWLEDGE_BATCH_FINDINGS} находок.`
    : `At most ${MAX_KNOWLEDGE_BATCH_FINDINGS} findings can be sent to one session.`);
  const items: KnowledgeBatchResolutionItem[] = [];
  const sent: string[] = [];
  const skipped: string[] = [];
  for (const finding of findings) {
    const target = await currentFindingTarget(finding, options.read, signal);
    if (!target) { skipped.push(finding.id); continue; }
    sent.push(finding.id);
    items.push({
      target: { path: target.path, contentHash: target.report.result.documentHash },
      finding: focusOf(target.match),
      ...(target.match.decision ? { decision: target.match.decision } : {}),
    });
  }
  if (!items.length) throw new Error(ru
    ? "Ни один актуальный отчёт больше не содержит находки из корзины. Перепроверьте страницы."
    : "No current report contains the basket findings any longer. Recheck the pages.");
  await options.start({ workspace: options.workspace, language: ru ? "ru" : findings[0]?.reportLanguage, items });
  return { sent, skipped };
}
