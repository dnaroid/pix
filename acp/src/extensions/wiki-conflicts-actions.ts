import type { KnowledgeCitation, KnowledgeCheckResult } from "../knowledge/contract.js";
import { KNOWLEDGE_FINDING_VERDICTS, knowledgeFindingSides, type KnowledgeFindingVerdict } from "../knowledge/decisions.js";
import { decideWikiFinding } from "../knowledge/finding-decision.js";
import { wikiFindingStatus, type WikiFinding, type WikiFindingFilter, type WikiFindingStatus } from "../knowledge/findings.js";
import { recordKnowledgeCheck, stripKnowledgeCheckStamp } from "../knowledge/stamp.js";
import { scanWikiFindings, type InitializedProjectWiki } from "../knowledge/wiki-findings-scan.js";
import { projectMarkdownPath, readProjectPage, writeProjectPageIfUnchanged } from "../knowledge/wiki-page-files.js";

/** Actions of the `wiki_conflicts` tool: list saved findings, record a verdict, recheck one page. */

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 200;
export const MAX_IDS = 50;
export const MIN_ID_PREFIX = 8;
const MAX_QUOTE_CHARS = 600;
const MAX_NOTE_CHARS = 1_000;
export const ACTIONS = ["list", "decide", "recheck"] as const;
export const STATUSES = ["open", "fix-pending", "decided", "stale", "all"] as const;
export const KINDS = ["conflict", "uncertainty", "internal"] as const;
export const DECIDE_VERDICTS = [...KNOWLEDGE_FINDING_VERDICTS, "clear"] as const;
/** Env var with the bundled pi-tools-suite path used by `recheck` (set by the ACP host). */
export const WIKI_CHECK_TOOLS_SUITE_ENV = "PIX_WIKI_CHECK_TOOLS_SUITE_EXTENSION";

export type WikiConflictsRequest =
  | { readonly action: "list"; readonly filter: WikiFindingFilter; readonly ids?: readonly string[]; readonly limit: number }
  | { readonly action: "decide"; readonly id: string; readonly verdict: KnowledgeFindingVerdict | "clear"; readonly note?: string }
  | { readonly action: "recheck"; readonly path: string };

const FIELDS: Record<(typeof ACTIONS)[number], readonly string[]> = {
  list: ["action", "status", "kind", "path", "ids", "limit"],
  decide: ["action", "id", "verdict", "note"],
  recheck: ["action", "path"],
};

function findingId(value: unknown, field: string): string {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${MIN_ID_PREFIX},64}$`, "u").test(value.trim().toLowerCase())) {
    throw new Error(`${field} must be a finding id or its hex prefix of at least ${MIN_ID_PREFIX} characters.`);
  }
  return value.trim().toLowerCase();
}

export function parseWikiConflictsParams(value: unknown): WikiConflictsRequest {
  if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("wiki_conflicts expects an object.");
  }
  const params = (value ?? {}) as Record<string, unknown>;
  const action = params.action ?? "list";
  if (!ACTIONS.includes(action as never)) throw new Error(`action must be one of ${ACTIONS.join(", ")}.`);
  const allowed = FIELDS[action as (typeof ACTIONS)[number]];
  const extra = Object.keys(params).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(`${extra.join(", ")} not supported for action ${String(action)}.`);

  if (action === "decide") {
    const id = findingId(params.id, "id");
    if (!DECIDE_VERDICTS.includes(params.verdict as never)) throw new Error(`verdict must be one of ${DECIDE_VERDICTS.join(", ")}.`);
    const verdict = params.verdict as KnowledgeFindingVerdict | "clear";
    if (params.note !== undefined && typeof params.note !== "string") throw new Error("note must be a string.");
    const note = typeof params.note === "string" ? params.note.trim() : "";
    if (note.length > MAX_NOTE_CHARS) throw new Error(`note must be at most ${MAX_NOTE_CHARS} characters.`);
    if (verdict === "clear" && note) throw new Error("note is not used with verdict clear.");
    if (verdict === "false-positive" && !note) throw new Error("verdict false-positive requires a note with the rationale.");
    return { action, id, verdict, ...(note ? { note } : {}) };
  }
  if (action === "recheck") {
    if (typeof params.path !== "string" || !params.path.trim()) throw new Error("recheck requires path of a Wiki page.");
    return { action, path: params.path };
  }

  const status = params.status ?? "open";
  if (!STATUSES.includes(status as never)) throw new Error(`status must be one of ${STATUSES.join(", ")}.`);
  if (params.kind !== undefined && !KINDS.includes(params.kind as never)) throw new Error(`kind must be one of ${KINDS.join(", ")}.`);
  if (params.path !== undefined && typeof params.path !== "string") throw new Error("path must be a project-relative string.");
  const branch = typeof params.path === "string" ? params.path.trim().replaceAll("\\", "/").replace(/^\.\//u, "") : "";
  const limit = params.limit === undefined ? DEFAULT_LIMIT : Number(params.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`limit must be an integer 1..${MAX_LIMIT}.`);
  let ids: string[] | undefined;
  if (params.ids !== undefined) {
    if (!Array.isArray(params.ids) || !params.ids.length || params.ids.length > MAX_IDS) {
      throw new Error(`ids must be a non-empty array of at most ${MAX_IDS} finding ids.`);
    }
    ids = params.ids.map(item => findingId(item, "ids"));
  }
  return {
    action: "list",
    filter: {
      // Explicit ids look up findings regardless of status unless one is given.
      ...(status !== "all" && !(ids && params.status === undefined) ? { status: status as WikiFindingStatus } : {}),
      ...(params.kind !== undefined ? { kind: params.kind as NonNullable<WikiFindingFilter["kind"]> } : {}),
      ...(branch ? { branch } : {}),
    },
    ...(ids ? { ids } : {}),
    limit,
  };
}

const squash = (text: string) => text.replace(/\s+/gu, " ").trim();

/** Current page bodies (metadata stripped) cached per call; undefined when unreadable. */
function bodyReader(wiki: InitializedProjectWiki, signal?: AbortSignal) {
  const cache = new Map<string, Promise<string | undefined>>();
  return (path: string) => {
    let body = cache.get(path);
    if (!body) {
      body = (async () => {
        try {
          const safe = projectMarkdownPath(path, wiki, false);
          return squash(stripKnowledgeCheckStamp(await readProjectPage(wiki, safe, signal)));
        } catch (error) {
          if (signal?.aborted) throw error;
          return undefined;
        }
      })();
      cache.set(path, body);
    }
    return body;
  };
}

function side(citation: KnowledgeCitation) {
  const quote = citation.quote.length > MAX_QUOTE_CHARS ? `${citation.quote.slice(0, MAX_QUOTE_CHARS)}…` : citation.quote;
  return { path: citation.path, lines: `${citation.startLine}-${citation.endLine}`, quote };
}

/**
 * `a`/`b` follow the canonical side order, so verdict `side-a` means side `a`.
 * `quoteChanged` lists sides whose quote no longer occurs in the current page.
 */
export async function compactWikiFinding(finding: WikiFinding, body?: (path: string) => Promise<string | undefined>) {
  const [a, b] = knowledgeFindingSides(finding.draft, finding.existing);
  const changed: ("a" | "b")[] = [];
  if (body) {
    for (const [name, citation] of [["a", a], ["b", b]] as const) {
      const text = await body(citation.path);
      if (text === undefined || !text.includes(squash(citation.quote))) changed.push(name);
    }
  }
  return {
    id: finding.id,
    kind: finding.kind,
    status: wikiFindingStatus(finding),
    ...(finding.internal ? { internal: true } : {}),
    a: side(a),
    b: side(b),
    ...(changed.length ? { quoteChanged: changed } : {}),
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

const matchesIds = (finding: WikiFinding, ids: readonly string[]) => ids.some(id => finding.id.startsWith(id));

export async function listWikiConflicts(wiki: InitializedProjectWiki, request: Extract<WikiConflictsRequest, { action: "list" }>,
  signal?: AbortSignal) {
  const scan = await scanWikiFindings(wiki, request.filter, signal);
  const matched = request.ids ? scan.findings.filter(finding => matchesIds(finding, request.ids!)) : scan.findings;
  const body = bodyReader(wiki, signal);
  const findings = [];
  for (const finding of matched.slice(0, request.limit)) findings.push(await compactWikiFinding(finding, body));
  return {
    wiki: wiki.path,
    summary: scan.summary,
    matched: matched.length,
    findings,
    ...(matched.length > request.limit ? { limited: true } : {}),
    ...(scan.truncated ? { truncated: true } : {}),
    scannedPages: scan.scannedPages,
    ...(scan.skippedPages ? { skippedPages: scan.skippedPages } : {}),
  };
}

export async function decideWikiConflict(wiki: InitializedProjectWiki, request: Extract<WikiConflictsRequest, { action: "decide" }>,
  signal?: AbortSignal) {
  const scan = await scanWikiFindings(wiki, {}, signal);
  const candidates = scan.findings.filter(finding => finding.id.startsWith(request.id));
  if (!candidates.length) throw new Error(`No saved Wiki finding matches id ${request.id}.`);
  if (candidates.length > 1) throw new Error(`Id prefix ${request.id} is ambiguous (${candidates.length} findings); pass more characters.`);
  const finding = candidates[0]!;
  const previousTask = finding.decision?.verdict === "deferred" ? finding.decision.taskId : undefined;
  const decision = request.verdict === "clear" ? null : {
    verdict: request.verdict,
    ...(request.note ? { note: request.note } : {}),
    // A linked task stays attached while the finding remains deferred.
    ...(request.verdict === "deferred" && previousTask ? { taskId: previousTask } : {}),
  };
  const outcome = await decideWikiFinding(finding, decision, {
    signal: signal ?? new AbortController().signal,
    read: (path, owned) => readProjectPage(wiki, projectMarkdownPath(path, wiki, true), owned),
    write: (path, content, expected) => writeProjectPageIfUnchanged(wiki, projectMarkdownPath(path, wiki, true), content, expected),
  });
  const after = (await scanWikiFindings(wiki, {}, signal)).findings.find(item => item.id === finding.id);
  return {
    id: finding.id,
    verdict: request.verdict,
    written: outcome.written,
    ...(after ? { finding: await compactWikiFinding(after, bodyReader(wiki, signal)) } : {}),
  };
}

export type WikiPageCheck = (request: { cwd: string; path: string; content: string }, signal: AbortSignal) => Promise<KnowledgeCheckResult>;

/** Default checker: the same judge, model preferences and native search as Desktop's explicit check. */
export async function defaultWikiPageCheck(): Promise<WikiPageCheck> {
  const { KnowledgeCheckService } = await import("../knowledge/service.js");
  const bundled = process.env[WIKI_CHECK_TOOLS_SUITE_ENV]?.trim();
  const service = new KnowledgeCheckService(bundled ? { bundledExtensionPath: bundled } : {});
  return (request, signal) => service.check(request, signal);
}

export async function recheckWikiPage(wiki: InitializedProjectWiki, request: Extract<WikiConflictsRequest, { action: "recheck" }>,
  check: WikiPageCheck, signal: AbortSignal) {
  const path = projectMarkdownPath(request.path, wiki, true);
  const content = await readProjectPage(wiki, path, signal);
  const result = await check({ cwd: wiki.root, path, content }, signal);
  signal.throwIfAborted();
  const next = await recordKnowledgeCheck(content, result, new Date(), content);
  const saved = next === content || await writeProjectPageIfUnchanged(wiki, path, next, content);
  const page = saved ? (await scanWikiFindings(wiki, { branch: path }, signal)).findings
    .filter(finding => finding.reportPaths.includes(path)) : [];
  const body = bodyReader(wiki, signal);
  const findings = [];
  for (const finding of page.slice(0, DEFAULT_LIMIT)) findings.push(await compactWikiFinding(finding, body));
  return {
    path,
    status: result.status,
    saved,
    ...(saved ? {} : { notice: "The page changed during the check; the report was not saved. Recheck again." }),
    conflicts: result.conflicts.length,
    uncertainties: result.uncertainties?.length ?? 0,
    checkedSources: result.checkedSources,
    modelRef: result.modelRef,
    ...(result.notices.length ? { notices: result.notices } : {}),
    ...(saved ? { findings, ...(page.length > DEFAULT_LIMIT ? { limited: true } : {}) } : {}),
  };
}
