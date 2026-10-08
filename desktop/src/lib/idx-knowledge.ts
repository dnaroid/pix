import type { IdxCommandResult } from "./idx";

export type IdxKnowledgeStatus = "clean" | "dirty" | "error";
export interface IdxKnowledgeRow {
  readonly path: string;
  readonly status: IdxKnowledgeStatus;
  readonly reasons: readonly string[];
  readonly changedPaths: readonly string[];
}
export interface IdxKnowledgeReport {
  readonly status: IdxKnowledgeStatus;
  readonly specs: readonly IdxKnowledgeRow[];
  readonly warnings: readonly string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function status(value: unknown): value is IdxKnowledgeStatus {
  return value === "clean" || value === "dirty" || value === "error";
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Accept complete structured error reports too, but never infer clean from failed/partial output. */
export function parseIdxKnowledgeReport(result: IdxCommandResult): IdxKnowledgeReport {
  if (result.truncated) throw new Error("Knowledge details exceed the output limit; the file list is incomplete.");
  let value: unknown;
  try { value = JSON.parse(result.stdout); } catch {
    throw new Error(`Knowledge details unavailable. Update IDX to a version supporting knowledge status --json.${result.stderr.trim() ? ` ${result.stderr.trim().slice(0, 500)}` : ""}`);
  }
  if (!record(value) || !status(value.status) || !record(value.counts)
    || !strings(value.warnings) || !Array.isArray(value.specs)
    || !value.specs.every((row) => record(row) && typeof row.path === "string"
      && row.path.length > 0 && status(row.status) && strings(row.reasons) && strings(row.changedPaths))) {
    throw new Error("IDX returned invalid knowledge details; the file list cannot be confirmed.");
  }
  const specs = value.specs as unknown as IdxKnowledgeRow[];
  const counts = { clean: 0, dirty: 0, error: 0 };
  for (const row of specs) counts[row.status]++;
  let expectedStatus: IdxKnowledgeStatus = "clean";
  if (counts.error || value.warnings.length) expectedStatus = "error";
  else if (counts.dirty) expectedStatus = "dirty";
  const reportedCounts = value.counts;
  const countsMatch = Object.entries(counts).every(([key, count]) => reportedCounts[key] === count);
  const uniquePaths = new Set(specs.map((row) => row.path)).size === specs.length;
  if (value.status !== expectedStatus || !countsMatch || !uniquePaths
    || result.exitCode !== (value.status === "error" ? 2 : 0)) {
    throw new Error("Knowledge check failed or returned inconsistent details; a complete file list cannot be confirmed.");
  }
  return { status: value.status, specs, warnings: value.warnings };
}

export function idxKnowledgeReason(reason: string): string {
  switch (reason) {
    case "never-reviewed": return "Not reviewed yet";
    case "content-changed": return "Spec or declared dependencies changed since review";
    case "no-declarations": return "No Implementation/Tests dependencies declared";
    default: return reason;
  }
}
