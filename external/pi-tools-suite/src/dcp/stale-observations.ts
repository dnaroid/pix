import type { DcpConfig } from "./config.js";
import type { DcpState, ToolRecord } from "./state.js";
import { repeatableObservationKey } from "./protected-continuity.js";

const READ_TOOLS = new Set(["read", "read_file", "view", "cat"]);
const MUTATION_TOOLS = new Set(["write", "edit", "apply_patch", "patch", "ast_apply"]);

function normalizeToolName(name: string | undefined): string {
  return (name ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function argPath(record: ToolRecord): string | undefined {
  const args = record.inputArgs ?? {};
  for (const key of ["path", "file_path", "filePath", "file"]) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim().replace(/\\/g, "/");
  }
  return undefined;
}

function mutatedPaths(record: ToolRecord): string[] {
  const paths = new Set<string>();
  const direct = argPath(record);
  if (direct) paths.add(direct);
  const details = record.outputDetails;
  const changed = details && typeof details === "object" && !Array.isArray(details)
    ? (details as Record<string, unknown>).changedFiles
    : undefined;
  if (Array.isArray(changed)) {
    for (const file of changed) if (typeof file === "string" && file.trim()) paths.add(file.trim().replace(/\\/g, "/"));
  }
  return [...paths];
}

function samePath(left: string, right: string): boolean {
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/**
 * Tool results in the current projection whose content is provably stale:
 * a side-effect-free observation (file read, read-only inspection, test/build
 * run) that a later identical call re-observed, or a file read whose file a
 * later successful write/edit changed. Order is the projection order, not
 * timestamps. Returns toolCallId → human-readable reason.
 */
export function staleObservationReasons(
  messages: any[],
  state: DcpState,
  config: DcpConfig,
): Map<string, string> {
  const results: Array<{ toolCallId: string; record: ToolRecord }> = [];
  for (const message of messages) {
    if (message?.role !== "toolResult" && message?.role !== "bashExecution") continue;
    if (typeof message.toolCallId !== "string") continue;
    const record = state.toolCalls.get(message.toolCallId);
    if (record) results.push({ toolCallId: message.toolCallId, record });
  }

  const stale = new Map<string, string>();
  const laterKeys = new Set<string>();
  const laterMutations: string[] = [];
  for (let index = results.length - 1; index >= 0; index--) {
    const { toolCallId, record } = results[index]!;
    const name = normalizeToolName(record.toolName);
    const readPath = READ_TOOLS.has(name) ? argPath(record) : undefined;
    const key = readPath ? record.inputFingerprint : repeatableObservationKey(record, config);
    if (key && laterKeys.has(key)) {
      stale.set(toolCallId, "superseded by a later identical call");
    } else if (readPath && laterMutations.some((path) => samePath(path, readPath))) {
      stale.set(toolCallId, "file changed later by a write/edit");
    }
    if (key) laterKeys.add(key);
    if (MUTATION_TOOLS.has(name) && !record.isError) laterMutations.push(...mutatedPaths(record));
  }
  return stale;
}
