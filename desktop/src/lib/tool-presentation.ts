import type { ToolItem } from "./transcript";

export type ToolTone = "agent" | "context" | "execute" | "inspect" | "interact" | "mutation" | "neutral" | "search";

export interface ToolPresentation {
  readonly name: string;
  readonly args: string;
  readonly tone: ToolTone;
}

type ToolHeaderSource = Pick<ToolItem, "kind" | "name" | "rawInput" | "title" | "skillName">;
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
  const name = toolPresentationName(tool);
  return {
    name,
    args: tool.skillName ?? (headerArgs(name, tool.rawInput) || argsFromTitle(tool.title, name)),
    tone: toolTone(name, tool.kind, tool.rawInput),
  };
}

export function toolGroupPresentationNames(tools: readonly ToolHeaderSource[]): string {
  return [...new Set(tools.map(toolPresentationName))].join(", ");
}

/** True only for Desktop one-shot user bash rows (`!`), not ordinary model bash tools. */
export function isUserBashTool(tool: ToolHeaderSource): boolean {
  if (normalizedName(tool.name ?? tool.title.split(/[\s:]/u)[0] ?? "") !== "bash") return false;
  const args = asRecord(tool.rawInput);
  return typeof args?.excludeFromContext === "boolean";
}

export function toolTone(toolName: string, toolKind?: string, rawInput?: unknown): ToolTone {
  const name = normalizedName(toolName);
  const kind = normalizedName(toolKind ?? "");
  if (name === "skill") return "context";
  if (name === "repo_knowledge") {
    const input = asRecord(rawInput);
    const action = input ? stringValue(input, ["action"]) : undefined;
    if (action && ["record", "verify", "relate", "remove"].includes(action)) return "mutation";
    if (action === "search") return "search";
    return "inspect";
  }
  if (
    ["apply_patch", "edit", "multiedit", "write", "ast_apply", "create_file", "update_file", "delete_file", "remove_file", "move_file", "rename_file"].includes(name)
    || ["edit", "mutation", "write"].includes(kind)
  ) return "mutation";
  if (["bash", "shell", "shell_command", "exec", "execute", "run_command"].includes(name) || kind === "execute") return "execute";
  if (
    (name.startsWith("ast_") && name !== "ast_apply")
    || ["web_search", "grep", "find", "glob", "search", "repo_search"].includes(name)
    || kind === "search"
  ) return "search";
  if (
    ["read", "read_file", "ls", "list", "cat", "open", "stat", "web_fetch", "architecture", "structure", "ast", "explain", "deps", "read_output"].includes(name)
    || name.startsWith("repo_")
    || ["read", "fetch"].includes(kind)
  ) return "inspect";
  if (["question"].includes(name)) return "interact";
  if (["compress", "todo", "get_plan", "update_plan", "project", "projects", "skill", "skills"].includes(name)) return "context";
  if (["subagent", "subagents", "agent", "agents", "task"].includes(name)) return "agent";
  return "neutral";
}

export function toolPresentationName(tool: Pick<ToolItem, "kind" | "name" | "title" | "skillName">): string {
  if (tool.skillName) return "skill";
  const explicit = typeof tool.name === "string" ? tool.name.trim() : "";
  if (explicit) return normalizedName(explicit);

  const titleName = tool.title.trim().match(/^([^\s:]+)/u)?.[1];
  if (titleName) return normalizedName(titleName);
  if (tool.kind && tool.kind !== "other") return normalizedName(tool.kind);
  return "tool";
}

/** Classify TUI-equivalent reads of SKILL.md once, at ingestion time. */
export function skillReadName(toolName: string | undefined, rawInput: unknown, location?: string, title?: string): string | undefined {
  const leaf = normalizedName(toolName ?? "");
  const record = asRecord(rawInput);
  let path: string | undefined;
  if (leaf === "read") {
    for (const [key, value] of Object.entries(record ?? {})) {
      if (/(?:path|file|target|url|uri|glob|cwd|workdir|directory|dir)s?$/i.test(key)) {
        path = findSkillPath(value);
        if (path) break;
      }
    }
    // Deferred history deliberately omits rawInput until expansion. Its lightweight
    // tool call still carries the ACP location and human-readable read title.
    path ??= findSkillPath(location) ?? findSkillPath(title?.match(/^Read\s+(.+)$/iu)?.[1]);
  } else if (["bash", "shell", "shell_command"].includes(leaf)) {
    if (!record) return undefined;
    const command = stringValue(record, ["command", "cmd", "script"])?.replace(/\s+/g, " ").trim() ?? "";
    if (/(?:^|[\s'"`=:[\/])SKILL\.md(?:$|[\s'"`;|&)>),:])/i.test(command)) {
      if (/(?:^|[;&|()\s])(?:cat|bat|batcat|less|more|head|tail|sed|awk|grep|rg|ripgrep|nl|wc|file)\b/i.test(command)
        && !/(?:>\s*|>>\s*|tee\b[^\n;&|]*|sed\b[^\n;&|]*\s-i(?:\b|[A-Za-z]))[^\n;&|]*SKILL\.md/i.test(command)) {
        path = /(?:^|[\s'"`=:[(])([^\s'"`;|&)>),]+SKILL\.md)(?=$|[\s'"`;|&)>),:])/i.exec(command)?.[1] ?? "SKILL.md";
      }
    }
  }
  if (!path) return undefined;
  const parts = path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean);
  const cwd = leaf === "read" || !record ? undefined : stringValue(record, ["cwd", "workdir"]);
  return (parts.at(-1)?.toLowerCase() === "skill.md" ? parts.at(-2) : undefined)
    ?? cwd?.replace(/\\/g, "/").replace(/\/+$/, "").split("/").filter(Boolean).at(-1)
    ?? "skill";
}

function findSkillPath(value: unknown): string | undefined {
  if (typeof value === "string") return /(?:^|[\\/])SKILL\.md$/i.test(value.trim()) ? value.trim() : undefined;
  if (Array.isArray(value)) return value.map(findSkillPath).find(Boolean);
  if (value && typeof value === "object") return Object.values(value).map(findSkillPath).find(Boolean);
  return undefined;
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
    case "edit":
    case "multiedit": {
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
