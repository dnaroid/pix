import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { KnowledgeCitation } from "../knowledge/contract.js";
import { wikiFindingStatus, type WikiFinding, type WikiFindingFilter, type WikiFindingStatus } from "../knowledge/findings.js";
import { initializedProjectWiki, scanWikiFindings } from "../knowledge/wiki-findings-scan.js";

/**
 * Agent tool over saved Wiki contradiction reports. It is active only for runs
 * whose project has an initialized Wiki; activation is re-evaluated every run.
 */

export const WIKI_CONFLICTS_TOOL = "wiki_conflicts";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;
const MAX_QUOTE_CHARS = 600;
const STATUSES = ["open", "fix-pending", "decided", "stale", "all"] as const;
const KINDS = ["conflict", "uncertainty", "internal"] as const;

export interface WikiConflictsParams {
  readonly status?: (typeof STATUSES)[number];
  readonly kind?: (typeof KINDS)[number];
  readonly path?: string;
  readonly limit?: number;
}

export function parseWikiConflictsParams(value: unknown): { filter: WikiFindingFilter; limit: number } {
  const params = (value ?? {}) as Record<string, unknown>;
  if (typeof params !== "object" || Array.isArray(params)) throw new Error("wiki_conflicts expects an object.");
  const status = params.status ?? "open";
  if (!STATUSES.includes(status as never)) throw new Error(`status must be one of ${STATUSES.join(", ")}.`);
  if (params.kind !== undefined && !KINDS.includes(params.kind as never)) throw new Error(`kind must be one of ${KINDS.join(", ")}.`);
  if (params.path !== undefined && typeof params.path !== "string") throw new Error("path must be a project-relative string.");
  const branch = typeof params.path === "string" ? params.path.trim().replaceAll("\\", "/").replace(/^\.\//u, "") : "";
  const limit = params.limit === undefined ? DEFAULT_LIMIT : Number(params.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be an integer 1..${MAX_LIMIT}.`);
  return {
    filter: {
      ...(status !== "all" ? { status: status as WikiFindingStatus } : {}),
      ...(params.kind !== undefined ? { kind: params.kind as NonNullable<WikiFindingFilter["kind"]> } : {}),
      ...(branch ? { branch } : {}),
    },
    limit,
  };
}

function side(citation: KnowledgeCitation) {
  const quote = citation.quote.length > MAX_QUOTE_CHARS ? `${citation.quote.slice(0, MAX_QUOTE_CHARS)}…` : citation.quote;
  return { path: citation.path, lines: `${citation.startLine}-${citation.endLine}`, quote };
}

export function compactWikiFinding(finding: WikiFinding) {
  return {
    id: finding.id,
    kind: finding.kind,
    status: wikiFindingStatus(finding),
    ...(finding.internal ? { internal: true } : {}),
    a: side(finding.draft),
    b: side(finding.existing),
    explanation: finding.explanation,
    checkedAt: finding.checkedAt,
    reportPaths: finding.reportPaths,
    ...(finding.decision ? { decision: {
      verdict: finding.decision.verdict, at: finding.decision.at,
      ...(finding.decision.note ? { note: finding.decision.note } : {}),
      ...(finding.decision.taskId ? { taskId: finding.decision.taskId } : {}),
    } } : {}),
    ...(finding.reopened ? { reopened: true } : {}),
  };
}

async function wikiReady(cwd: string): Promise<boolean> {
  try { return !!await initializedProjectWiki(cwd); } catch { return false; }
}

export default function wikiConflictsExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: WIKI_CONFLICTS_TOOL,
    label: "Wiki conflicts",
    description: "Read-only list of contradictions and uncertainties found by Pix Wiki consistency checks, from reports saved in project Wiki pages. Returns findings with both quoted sides (a = reporting page, b = compared source; path, lines, quote), explanation, status (open, fix-pending = fix verdict awaiting recheck, decided = false positive/deferred, stale = no longer in a current report) and any user decision, plus totals. Does not run a new check or modify files.",
    promptSnippet: "Use wiki_conflicts to see known contradictions in the project Wiki before editing or reconciling documentation.",
    promptGuidelines: [
      "wiki_conflicts reflects only saved check reports; a fix is confirmed only after the page is rechecked in Pix. Never edit the `<!-- pix:wiki-report ... -->` or `<!-- pix:wiki-check ... -->` metadata lines in Wiki pages.",
    ],
    defaultActive: false,
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...STATUSES], description: "Default open (includes fix-pending). all returns every status." },
        kind: { type: "string", enum: [...KINDS], description: "conflict, uncertainty, or internal (both sides on one page)." },
        path: { type: "string", maxLength: 1024, description: "Project-relative Wiki folder or page prefix; matches either side." },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, description: `Maximum findings returned (default ${DEFAULT_LIMIT}).` },
      },
      additionalProperties: false,
    },
    async execute(_id, params, signal, _update, ctx) {
      try {
        const { filter, limit } = parseWikiConflictsParams(params);
        const wiki = await initializedProjectWiki(ctx.cwd);
        if (!wiki) throw new Error("The project Wiki is not initialized.");
        const scan = await scanWikiFindings(wiki, filter, signal);
        const response = {
          wiki: wiki.path,
          summary: scan.summary,
          matched: scan.findings.length,
          findings: scan.findings.slice(0, limit).map(compactWikiFinding),
          ...(scan.findings.length > limit ? { limited: true } : {}),
          ...(scan.truncated ? { truncated: true } : {}),
          scannedPages: scan.scannedPages,
          ...(scan.skippedPages ? { skippedPages: scan.skippedPages } : {}),
        };
        return { content: [{ type: "text" as const, text: JSON.stringify(response) }], details: response };
      } catch (error) {
        const message = signal?.aborted ? "wiki_conflicts cancelled." : error instanceof Error ? error.message : "wiki_conflicts failed.";
        return { content: [{ type: "text" as const, text: message }], isError: true, details: { error: message } };
      }
    },
  });

  // Re-evaluated every run: the Wiki can be initialized or removed while a session is open.
  pi.on("before_agent_start", async (event) => {
    const ready = await wikiReady(event.systemPromptOptions.cwd);
    const active = pi.getActiveTools();
    const has = active.includes(WIKI_CONFLICTS_TOOL);
    if (ready && !has) pi.setActiveTools([...active, WIKI_CONFLICTS_TOOL]);
    else if (!ready && has) pi.setActiveTools(active.filter(name => name !== WIKI_CONFLICTS_TOOL));
  });
}
