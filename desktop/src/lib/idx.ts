import type { ProjectFileLineRange } from "./project-files";

export type IdxMaintenanceKind =
  | "init"
  | "index"
  | "full-index"
  | "dry-run"
  | "doctor"
  | "wiki-audit"
  | "wiki-discover"
  | "wiki-catalog";

export type IdxOperationStatus = "running" | "succeeded" | "failed" | "cancelled" | "timed-out";
export type IdxSearchMode = "hybrid" | "semantic" | "lexical" | "symbol";
export type IdxQueryKind = "code" | "knowledge" | "context";
export type IdxInspectCommand = "architecture" | "structure" | "ast" | "explain" | "deps";

export interface IdxParsedStatus {
  readonly state?: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly raw: string;
}

export interface IdxOverview {
  readonly available: boolean;
  readonly executable?: string;
  readonly version?: string;
  readonly initialized: boolean;
  readonly indexStatus?: IdxParsedStatus;
  readonly wikiStatus?: IdxParsedStatus;
  readonly rawStatus: string;
  readonly errors: readonly string[];
}

export interface IdxCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  readonly truncated: boolean;
}

export interface IdxOperationSnapshot {
  readonly id: string;
  readonly windowLabel: string;
  readonly workspace: string;
  readonly kind: IdxMaintenanceKind;
  readonly command: string;
  readonly status: IdxOperationStatus;
  readonly output: string;
  readonly startedAtMs: number;
  readonly finishedAtMs?: number;
  readonly exitCode?: number;
}

export interface IdxOperationOutputEvent {
  readonly operationId: string;
  readonly stream: "stdout" | "stderr";
  readonly chunk: string;
}

export interface IdxOperationExitEvent {
  readonly operationId: string;
  readonly status: IdxOperationStatus;
  readonly exitCode?: number;
}

export interface IdxKnowledgeIssue {
  readonly status: string;
  readonly path: string;
  readonly detail: string;
}

export interface IdxKnowledgeCandidate {
  readonly score?: number;
  readonly kind: string;
  readonly path: string;
  readonly known?: string;
  readonly title?: string;
  readonly signals?: string;
}

export type IdxOutputSegment =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "file";
      readonly text: string;
      readonly path: string;
      readonly range?: ProjectFileLineRange;
    };

export const IDX_OPERATION_OUTPUT_EVENT = "idx://operation-output";
export const IDX_OPERATION_EXIT_EVENT = "idx://operation-exit";

const IDX_FILE_REFERENCE = /(^|[\s([{"'`=])((?:\.{1,2}\/)?(?:[A-Za-z0-9_@+.-]+\/)*[A-Za-z0-9_@+.-]+\.[A-Za-z0-9_+-]+)(?::([1-9][0-9]*)(?:-([1-9][0-9]*))?)?/gu;

export function idxCombinedOutput(result: IdxCommandResult | undefined): string {
  if (!result) return "";
  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trimEnd();
  if (!stdout) return stderr;
  if (!stderr) return stdout;
  return `${stdout}\n${stderr}`;
}

/** Split IDX output into ordinary text and project-file candidates. Candidates are validated by the UI before becoming links. */
export function idxOutputSegments(output: string): IdxOutputSegment[] {
  if (!output) return [];
  const segments: IdxOutputSegment[] = [];
  let cursor = 0;

  IDX_FILE_REFERENCE.lastIndex = 0;
  for (let match = IDX_FILE_REFERENCE.exec(output); match; match = IDX_FILE_REFERENCE.exec(output)) {
    const prefix = match[1] ?? "";
    const displayPath = match[2];
    if (!displayPath) continue;
    const referenceStart = match.index + prefix.length;
    if (referenceStart > cursor) segments.push({ kind: "text", text: output.slice(cursor, referenceStart) });

    const rawStart = match[3] ? Number(match[3]) : undefined;
    const rawEnd = match[4] ? Number(match[4]) : rawStart;
    const path = displayPath.startsWith("./") ? displayPath.slice(2) : displayPath;
    const text = output.slice(referenceStart, IDX_FILE_REFERENCE.lastIndex);
    const range = rawStart && rawEnd
      ? { startLine: Math.min(rawStart, rawEnd), endLine: Math.max(rawStart, rawEnd) }
      : undefined;
    segments.push({ kind: "file", text, path, ...(range ? { range } : {}) });
    cursor = IDX_FILE_REFERENCE.lastIndex;
  }

  if (cursor < output.length) segments.push({ kind: "text", text: output.slice(cursor) });
  return segments.length > 0 ? segments : [{ kind: "text", text: output }];
}

export function idxField(status: IdxParsedStatus | undefined, key: string): string | undefined {
  const value = status?.fields[key]?.trim();
  return value || undefined;
}

export function idxNumericField(status: IdxParsedStatus | undefined, key: string): number | undefined {
  const value = idxField(status, key);
  if (!value) return undefined;
  const match = /^([0-9][0-9,]*)/u.exec(value);
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1].replace(/,/gu, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function idxCurrentPrimaryCount(status: IdxParsedStatus | undefined): number | undefined {
  const value = idxField(status, "primarySpecs");
  if (!value) return undefined;
  const match = /\(([0-9][0-9,]*)\s+current\/proposed\)/iu.exec(value);
  if (!match?.[1]) return undefined;
  const parsed = Number(match[1].replace(/,/gu, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function idxArchivedPrimaryCount(status: IdxParsedStatus | undefined): number | undefined {
  const total = idxNumericField(status, "primarySpecs");
  const current = idxCurrentPrimaryCount(status);
  if (total === undefined || current === undefined) return undefined;
  return Math.max(0, total - current);
}

/** Whether the current/proposed knowledge set needs semantic maintenance. Unresolved path refs alone are informational. */
export function idxKnowledgeNeedsAttention(status: IdxParsedStatus | undefined): boolean {
  if (!status) return false;
  const current = idxCurrentPrimaryCount(status);
  const fresh = idxNumericField(status, "fresh");
  return (current !== undefined && fresh !== undefined && fresh < current)
    || (idxNumericField(status, "needsReview") ?? 0) > 0
    || (idxNumericField(status, "unverified") ?? 0) > 0
    || (idxNumericField(status, "newChangedCandidates") ?? 0) > 0
    || (idxNumericField(status, "uncoveredActiveAsIs") ?? 0) > 0;
}

export function idxKnowledgeIssues(status: IdxParsedStatus | undefined): IdxKnowledgeIssue[] {
  if (!status) return [];
  const issues: IdxKnowledgeIssue[] = [];
  for (const rawLine of status.raw.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = /^(\S+)\s+([^\s]+)\s+—\s+(.+)$/u.exec(line);
    if (!match?.[1] || !match[2] || !match[3]) continue;
    if (!match[2].includes("/") && !/\.(?:md|mdx|txt|rst)$/iu.test(match[2])) continue;
    issues.push({ status: match[1], path: match[2], detail: match[3] });
  }
  return issues;
}

export function idxKnowledgeCandidates(output: string): IdxKnowledgeCandidate[] {
  const candidates: IdxKnowledgeCandidate[] = [];
  let current: IdxKnowledgeCandidate | undefined;
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const header = /^score=\s*([0-9]+)\s+(\S+)\s+(\S+)(?:\s+known=(\S+))?$/u.exec(line);
    if (header?.[2] && header[3]) {
      current = {
        score: header[1] ? Number(header[1]) : undefined,
        kind: header[2],
        path: header[3],
        ...(header[4] ? { known: header[4] } : {}),
      };
      candidates.push(current);
      continue;
    }
    if (!current) continue;
    const title = /^title:\s*(.+)$/u.exec(line)?.[1];
    const signals = /^signals:\s*(.+)$/u.exec(line)?.[1];
    if (title) current = replaceCandidate(candidates, current, { title });
    else if (signals) current = replaceCandidate(candidates, current, { signals });
  }
  return candidates;
}

function replaceCandidate(
  candidates: IdxKnowledgeCandidate[],
  current: IdxKnowledgeCandidate,
  patch: Partial<IdxKnowledgeCandidate>,
): IdxKnowledgeCandidate {
  const next = { ...current, ...patch };
  const index = candidates.lastIndexOf(current);
  if (index >= 0) candidates[index] = next;
  return next;
}

export function appendIdxLog(current: string, chunk: string, maxChars = 256_000): string {
  const combined = `${current}${chunk}`;
  return combined.length <= maxChars ? combined : combined.slice(combined.length - maxChars);
}

/** Merge a backend refresh without discarding a newer event already applied in the UI. */
export function reconcileIdxOperationSnapshot(
  current: IdxOperationSnapshot,
  refreshed: IdxOperationSnapshot,
): IdxOperationSnapshot {
  const keepCurrentCompletion = current.status !== "running" && refreshed.status === "running";
  const statusSource = keepCurrentCompletion ? current : refreshed;
  return {
    ...refreshed,
    status: statusSource.status,
    output: current.output.length > refreshed.output.length ? current.output : refreshed.output,
    ...(statusSource.finishedAtMs === undefined ? {} : { finishedAtMs: statusSource.finishedAtMs }),
    ...(statusSource.exitCode === undefined ? {} : { exitCode: statusSource.exitCode }),
  };
}

export function idxOperationLabel(kind: IdxMaintenanceKind): string {
  switch (kind) {
    case "init": return "Initialize";
    case "index": return "Update index";
    case "full-index": return "Full reindex";
    case "dry-run": return "Dry run";
    case "doctor": return "Doctor";
    case "wiki-audit": return "Knowledge audit";
    case "wiki-discover": return "Discover knowledge";
    case "wiki-catalog": return "Knowledge catalog";
  }
}

export function idxOperationStatusLabel(operation: Pick<IdxOperationSnapshot, "status" | "exitCode">): string {
  if (operation.status === "running") return "Running";
  if (operation.status === "succeeded") return "Completed";
  if (operation.status === "cancelled") return "Stopped";
  if (operation.status === "timed-out") return "Timed out";
  return operation.exitCode === undefined ? "Failed" : `Failed · ${operation.exitCode}`;
}

export function idxOperationTone(status: IdxOperationStatus): "success" | "error" | "warning" | "info" {
  if (status === "succeeded") return "success";
  if (status === "failed" || status === "timed-out") return "error";
  if (status === "cancelled") return "warning";
  return "info";
}
