import { classifyShellCommand } from "../shell-command-policy.js";
import type { ToolRecord } from "./state.js";

export function normalizeContinuityToolName(name: string): string {
	return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export const SHELL_TOOLS = new Set(["bash", "shell", "powershell", "exec", "execute"]);
export const MUTATION_TOOLS = new Set(["apply_patch", "write", "edit", "ast_apply", "patch"]);
const OBSERVATION_TOOLS = new Set([
	"read", "grep", "glob", "find", "ls", "ast_grep", "project_search", "web_search", "web_fetch",
]);

/** Only proven observations may be discarded without a replacement fact. */
export function toolNeedsContinuity(record: ToolRecord): boolean {
	const name = normalizeContinuityToolName(record.toolName);
	if (name === "compress" || OBSERVATION_TOOLS.has(name)) return false;
	// Runtime state is recoverable; summaries carry conclusions, not each update.
	if (name === "todo") return false;
	if (["subagents", "async_subagents"].includes(name) && ["status", "wait", "result"].includes(String(record.inputArgs.action))) return false;
	if (SHELL_TOOLS.has(name)) return classifyShellCommand(record.inputArgs).kind !== "inspection";
	if (name === "session") return record.inputArgs.action === "name" && typeof record.inputArgs.name === "string";
	if (name === "project_tasks") return !["list", "get"].includes(String(record.inputArgs.op));
	// Unknown extensions can send, delete or incur costs. Never assume read-only.
	return true;
}
