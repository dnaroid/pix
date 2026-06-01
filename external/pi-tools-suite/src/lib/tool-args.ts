export type ModelProfile = "claude" | "codex";

export function detectModelProfile(model: unknown): ModelProfile {
  if (typeof model === "string") return detectModelProfileFromText(model);
  if (!model || typeof model !== "object") return "claude";
  const record = model as Record<string, unknown>;
  const values = [record.provider, record.id, record.name]
    .filter((value): value is string => typeof value === "string")
    .join(" ");

  return detectModelProfileFromText(values);
}

function detectModelProfileFromText(value: string): ModelProfile {
  const values = value.toLowerCase();

  if (
    values.includes("codex") ||
    values.includes("gpt") ||
    /\bo\d/.test(values) ||
    values.includes("openai")
  ) {
    return "codex";
  }
  return "claude";
}

const CLAUDE_TOOL_ALIASES: Record<string, string | undefined> = {
  read: "Read",
  Read: "Read",
  edit: "Edit",
  Edit: "Edit",
  write: "Write",
  Write: "Write",
  bash: "Bash",
  Bash: "Bash",
  shell_command: "Bash",
  shell: "Bash",
  grep: "Grep",
  Grep: "Grep",
  find: "Glob",
  ls: "Glob",
  LS: "Glob",
  glob: "Glob",
  Glob: "Glob",
};

const CODEX_TOOL_ALIASES: Record<string, string | undefined> = {
  read: "read",
  Read: "read",
  bash: "shell",
  Bash: "shell",
  shell_command: "shell",
  shell: "shell",
  edit: "apply_patch",
  Edit: "apply_patch",
  write: "apply_patch",
  Write: "apply_patch",
  apply_patch: "apply_patch",
  grep: "shell",
  Grep: "shell",
  find: "shell",
  ls: "shell",
  LS: "shell",
  glob: "shell",
  Glob: "shell",
};

export function selectSuitableToolsForModel(model: unknown, tools: readonly string[]): string[] {
  const aliases = detectModelProfile(model) === "codex" ? CODEX_TOOL_ALIASES : CLAUDE_TOOL_ALIASES;
  const selected: string[] = [];
  for (const tool of tools) {
    const name = typeof tool === "string" ? tool.trim() : "";
    if (!name) continue;
    const mapped = aliases[name];
    if (mapped && !selected.includes(mapped)) selected.push(mapped);
  }
  return selected;
}

export function toReadArgs(input: { file_path?: string; path?: string; offset?: number; limit?: number }) {
  return { path: input.file_path ?? input.path ?? "", offset: input.offset, limit: input.limit };
}

export function toEditArgs(input: {
  file_path?: string;
  path?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
}) {
  return {
    path: input.file_path ?? input.path ?? "",
    edits: [{ oldText: input.old_string ?? "", newText: input.new_string ?? "" }],
  };
}

export function toWriteArgs(input: { file_path?: string; path?: string; content?: string }) {
  return { path: input.file_path ?? input.path ?? "", content: input.content ?? "" };
}

export function toGrepArgs(input: {
  pattern: string;
  path?: string;
  glob?: string;
  case_sensitive?: boolean;
  regex?: boolean;
  before_context?: number;
  after_context?: number;
  context?: number;
  limit?: number;
  max_count?: number;
}) {
  const before = input.before_context ?? 0;
  const after = input.after_context ?? 0;
  return {
    pattern: input.pattern,
    path: input.path,
    glob: input.glob,
    ignoreCase: input.case_sensitive === undefined ? undefined : !input.case_sensitive,
    literal: input.regex === undefined ? undefined : !input.regex,
    context: input.context ?? (Math.max(before, after) || undefined),
    limit: input.limit ?? input.max_count,
  };
}

export function toShellCommand(input: { command?: string }) {
  return (input.command ?? "").trim();
}

export function prepareApplyPatchArgs(args: unknown): { input: string } {
  if (typeof args === "string") return { input: args };
  if (!args || typeof args !== "object") return { input: "" };
  const record = args as Record<string, unknown>;
  const input = record.input ?? record.patch;
  return { input: typeof input === "string" ? input : "" };
}
