import { toolPresentationName } from "./tool-presentation";
import type { ToolItem } from "./transcript";

type InputSource = Pick<ToolItem, "kind" | "name" | "title" | "rawInput">;

const INPUT_TOOLS = new Set([
  "codemode", "shell", "bash", "shell_command", "exec", "execute", "run_command",
  "ast_grep", "ast_apply", "subagents", "brainstorm", "web_search", "question",
]);

/** Selection stays cheap for closed rows; formatting happens only on expansion. */
export function hasToolInput(tool: InputSource): boolean {
  const name = toolPresentationName(tool);
  return tool.rawInput != null && (INPUT_TOOLS.has(name) || name.startsWith("repo_"));
}

/** Label fields without JSON string escaping, preserving full multiline prompts. */
export function toolInputText(tool: InputSource): string | undefined {
  if (!hasToolInput(tool)) return undefined;
  return formatValue(tool.rawInput);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value.map((item, index) => `[${index + 1}]\n${formatValue(item)}`).join("\n\n");
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).map(([key, field]) => {
      const text = formatValue(field);
      return `${key}:${text.includes("\n") || typeof field === "object" ? "\n" : " "}${text}`;
    }).join("\n\n") || "{}";
  }
  return String(value);
}
