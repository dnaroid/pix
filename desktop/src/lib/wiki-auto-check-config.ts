import { applyEdits, getNodeValue, modify, parseTree, type Node, type ParseError } from "jsonc-parser";
import { WORKSPACE_SCHEMA_URL } from "./workspace-config-schema";

export interface WikiAutoCheckSettings {
  readonly enabled: boolean;
  /** Stable for a pass so completed non-green versions can survive a restart. */
  readonly runId?: string;
}

export interface WikiAutoCheckView {
  readonly enabled: boolean;
  readonly saving: boolean;
  readonly scanning: boolean;
  readonly completed: number;
  readonly total: number;
  readonly queued: number;
  readonly running: boolean;
  readonly error?: string;
}

export const EMPTY_WIKI_AUTO_CHECK_VIEW: WikiAutoCheckView = {
  enabled: false, saving: false, scanning: false,
  completed: 0, total: 0, queued: 0, running: false,
};

export function isWikiAutoCheckRunId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function property(node: Node, key: string): Node | undefined {
  const matches = node.children?.filter(item => item.children?.[0]?.value === key) ?? [];
  if (matches.length > 1) throw new Error(`.pi/workspace.jsonc contains duplicate ${key} settings.`);
  return matches[0]?.children?.[1];
}

/** Read only the opt-in policy; Wiki path validation remains with getProjectWikiConfig. */
export function getWikiAutoCheckSettings(source?: string): WikiAutoCheckSettings {
  if (source === undefined) return { enabled: false };
  const errors: ParseError[] = [];
  const root = parseTree(source, errors, { allowTrailingComma: true });
  if (errors.length || root?.type !== "object") {
    throw new Error(".pi/workspace.jsonc must contain a valid JSONC object.");
  }
  const wiki = property(root, "wiki");
  if (!wiki) return { enabled: false };
  if (wiki.type !== "object") throw new Error(".pi/workspace.jsonc wiki must be an object.");
  const enabledNode = property(wiki, "autoCheck");
  const runNode = property(wiki, "autoCheckRunId");
  const enabled: unknown = enabledNode && getNodeValue(enabledNode);
  const runId: unknown = runNode && getNodeValue(runNode);
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error(".pi/workspace.jsonc wiki.autoCheck must be a boolean.");
  }
  if (runId !== undefined && !isWikiAutoCheckRunId(runId)) {
    throw new Error(".pi/workspace.jsonc wiki.autoCheckRunId must be a UUID.");
  }
  return { enabled: enabled === true, ...(typeof runId === "string" ? { runId } : {}) };
}

/** One CAS edit changes both the opt-in and pass identity, preserving unrelated JSONC. */
export function editWikiAutoCheckSettings(source: string | undefined, enabled: boolean, runId?: string): string {
  getWikiAutoCheckSettings(source);
  if (typeof enabled !== "boolean") throw new Error("Wiki background checking must be enabled or disabled explicitly.");
  if (enabled && !isWikiAutoCheckRunId(runId)) throw new Error("A new Wiki background pass requires a UUID.");
  const eol = source?.includes("\r\n") ? "\r\n" : "\n";
  const indentation = source?.match(/^([ \t]+)"/mu)?.[1];
  const formattingOptions = {
    insertSpaces: !indentation?.includes("\t"),
    tabSize: indentation && !indentation.includes("\t") ? Math.max(1, indentation.length) : 2,
    eol,
  };
  let next = source ?? `{${eol}  "$schema": "${WORKSPACE_SCHEMA_URL}"${eol}}${eol}`;
  next = applyEdits(next, modify(next, ["wiki", "autoCheck"], enabled, { formattingOptions }));
  // Retain the prior pass when stopping; its in-flight request may still finish.
  if (enabled) next = applyEdits(next, modify(next, ["wiki", "autoCheckRunId"], runId, { formattingOptions }));
  return next;
}
