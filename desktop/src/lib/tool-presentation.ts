import type { ToolItem } from "./transcript";

export type ToolTone = "accent" | "info" | "muted" | "mutation" | "search" | "success" | "title" | "warning";

export interface ToolPresentation {
  readonly name: string;
  readonly args: string;
  readonly tone: ToolTone;
}

type ToolHeaderSource = Pick<ToolItem, "kind" | "name" | "rawInput" | "title">;
type PlainRecord = Record<string, unknown>;

const SEARCH_KEYS = [
  "pattern",
  "path",
  "glob",
  "type",
  "output_mode",
  "output_line_limit",
  "case_sensitive",
  "regex",
  "multiline",
  "-n",
  "context",
  "head_limit",
  "max_results",
] as const;

const REPO_KEYS = ["target", "path", "args", "maxLines", "maxBytes"] as const;

export function toolPresentation(tool: ToolHeaderSource): ToolPresentation {
  const name = displayName(tool);
  return {
    name,
    args: headerArgs(name, tool.rawInput) || argsFromTitle(tool.title, name),
    tone: toolTone(name),
  };
}

export function toolTone(toolName: string): ToolTone {
  const name = normalizedName(toolName);
  if (["apply_patch", "edit", "write", "ast_apply"].includes(name)) return "mutation";
  if (["bash", "shell", "shell_command"].includes(name) || name.startsWith("repo_")) return "warning";
  if (["read", "ls"].includes(name)) return "success";
  if (
    name.startsWith("ast_")
    || ["web_search", "web_fetch", "grep", "find", "glob", "skill"].includes(name)
  ) return "search";
  if (name === "compress") return "info";
  if (["question", "todo"].includes(name)) return "accent";
  if (name === "subagents") return "muted";
  return "title";
}

function displayName(tool: ToolHeaderSource): string {
  const explicit = typeof tool.name === "string" ? tool.name.trim() : "";
  if (explicit) return normalizedName(explicit);

  const titleName = tool.title.trim().match(/^([^\s:]+)/u)?.[1];
  if (titleName) return normalizedName(titleName);
  if (tool.kind && tool.kind !== "other") return normalizedName(tool.kind);
  return "tool";
}

function normalizedName(name: string): string {
  const leaf = name.split(/[.:/]/u).filter(Boolean).at(-1) ?? name;
  return leaf.trim().toLowerCase() || "tool";
}

function headerArgs(name: string, rawInput: unknown): string {
  const args = asRecord(rawInput);
  if (!args) return typeof rawInput === "string" ? oneLine(rawInput) : "";

  switch (name) {
    case "read": {
      const path = stringValue(args, ["path", "file_path", "filePath", "file", "target"]);
      if (!path) break;
      const offset = numberValue(args, ["offset"]);
      const limit = numberValue(args, ["limit"]);
      return `${path}${offset == null ? "" : `:${offset}${limit == null ? "" : `+${limit}`}`}`;
    }
    case "write":
    case "edit": {
      const path = stringValue(args, ["path", "file_path", "filePath"]);
      if (path) return path;
      break;
    }
    case "apply_patch": {
      const patch = stringValue(args, ["input", "patch"]);
      return summarizePatch(patch) || stringValue(args, ["path", "file_path", "filePath"]) || "patch";
    }
    case "bash":
    case "shell":
    case "shell_command": {
      const command = stringValue(args, ["command", "cmd", "script"]);
      if (command) return oneLine(command);
      break;
    }
    case "web_search": {
      const query = stringValue(args, ["query"]);
      if (query) return query;
      break;
    }
    case "web_fetch": {
      const url = stringValue(args, ["url"]);
      if (url) return url;
      break;
    }
    case "todo": {
      const parts = [stringValue(args, ["action"]), stringValue(args, ["subject"])].filter(isString);
      if (parts.length > 0) return parts.join(" · ");
      break;
    }
    case "question": {
      const questions = Array.isArray(args.questions) ? args.questions.filter(asRecord) : undefined;
      if (questions) {
        const labels = questions
          .map((question) => stringValue(question, ["label", "id"]))
          .filter(isString);
        const count = `${questions.length} question${questions.length === 1 ? "" : "s"}`;
        return labels.length > 0
          ? `${count} · ${labels.slice(0, 3).join(", ")}${labels.length > 3 ? ", …" : ""}`
          : count;
      }
      break;
    }
    case "subagents": {
      const action = stringValue(args, ["action"]);
      const taskCount = Array.isArray(args.tasks) ? args.tasks.length : undefined;
      const parts = [
        action,
        taskCount == null ? undefined : `${taskCount} task${taskCount === 1 ? "" : "s"}`,
      ].filter(isString);
      if (parts.length > 0) return parts.join(" · ");
      break;
    }
  }

  if (name.startsWith("repo_")) return formatArgsInline(args, REPO_KEYS);
  if (["grep", "find", "glob", "rg"].includes(name)) return formatArgsInline(args, SEARCH_KEYS);
  if (name.startsWith("ast_")) {
    const pattern = stringValue(args, ["pattern", "target", "command"]);
    if (pattern) return oneLine(pattern);
  }
  return formatArgsInline(args);
}

function argsFromTitle(title: string, name: string): string {
  const trimmed = title.trim();
  if (!trimmed) return "";
  const prefix = new RegExp(`^${escapeRegExp(name)}(?:\\s*:\\s*|\\s+)`, "iu");
  if (prefix.test(trimmed)) return trimmed.replace(prefix, "").trim();
  return trimmed.localeCompare(name, undefined, { sensitivity: "accent" }) === 0 ? "" : trimmed;
}

function formatArgsInline(args: PlainRecord, preferredKeys?: readonly string[]): string {
  const entries = Object.entries(args).filter(([, value]) => value !== undefined);
  if (preferredKeys?.length) {
    const order = new Map(preferredKeys.map((key, index) => [key, index]));
    entries.sort(([left], [right]) => (order.get(left) ?? Number.MAX_SAFE_INTEGER) - (order.get(right) ?? Number.MAX_SAFE_INTEGER));
  }
  return entries.map(([key, value]) => `${key}: ${formatInlineValue(value)}`).join(" · ");
}

function formatInlineValue(value: unknown): string {
  if (value == null) return String(value);
  if (["number", "boolean", "bigint"].includes(typeof value)) return String(value);
  if (typeof value === "string") return oneLine(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const preview = value.slice(0, 3).map(formatInlineValue).join(", ");
    return value.length > 3 ? `[${preview}, +${value.length - 3}]` : `[${preview}]`;
  }
  const record = asRecord(value);
  if (!record) return String(value);
  const keys = Object.keys(record);
  return keys.length === 0 ? "{}" : `{${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ", …" : ""}}`;
}

function summarizePatch(patch: string | undefined): string | undefined {
  if (!patch) return undefined;
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    const match = /^(?:\*\*\* (?:Update|Add|Delete) File:\s*|Index:\s+|---\s+(?:a\/)?|\+\+\+\s+(?:b\/)?|diff --git a\/)(.+?)(?:\s|$)/u.exec(line.trim());
    const file = match?.[1]?.trim();
    if (file && !file.startsWith("/dev/null")) files.add(file.replace(/^[ab]\//u, ""));
  }
  if (files.size === 0) return undefined;
  const list = [...files];
  const shown = list.slice(0, 3).join(", ");
  return list.length > 3 ? `${shown}, +${list.length - 3}` : shown;
}

function stringValue(record: PlainRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function numberValue(record: PlainRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function asRecord(value: unknown): PlainRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as PlainRecord : undefined;
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}
