/**
 * Deliberately tiny, auditable bridge from Pix-owned prompt text to external
 * model hosts. This is NOT a Pi system-prompt builder: no session hooks,
 * provider payloads, project AGENTS/skills, prompts or user config text.
 *
 * Exporting a section is an explicit opt-in. New Pix modules and prompt hooks
 * do not automatically become host instructions.
 */
import type { ModelProfile } from "../lib/tool-args.js";
import { agentStrategyPrompt } from "../async-subagents/core/agent-strategy.js";
import { TODO_TOOL_DESCRIPTION, astGrepToolDescriptions } from "../tool-descriptions.js";

export type HeadlessInstructionId = "todo" | "ast_grep" | "subagents";
export interface HeadlessInstructionSection {
	id: HeadlessInstructionId;
	text: string;
}

// These exact, maintained todo rules work with standalone MCP todo storage.
// Deliberately omit Pi /todos slash commands, Pi JSONL/session persistence,
// prompt injection hooks and automatically continuing parent turns.
const TODO_GUIDELINE_PREFIXES = [
	"Use `todo` for complex work",
	"For multi-step implementation/debugging plans",
	"Resync before continuing",
	"Update todos when starting",
	"Keep partial/failed/blocked work",
	"Before a final response",
	"Keep subjects short",
] as const;

/** Only exposed tools from the GPT/Codex headless profile can contribute. */
export function headlessPromptInstructions(
	activeTools: readonly string[],
	profile: ModelProfile,
	env: NodeJS.ProcessEnv = process.env,
	readOnly = false,
): HeadlessInstructionSection[] {
	if (profile !== "codex") return [];
	const names = new Set(activeTools);
	const sections: HeadlessInstructionSection[] = [];
	// The original todo rules tell the parent to mutate tasks; do not export
	// them to a client that can only list/get/export existing tasks.
	if (names.has("todo") && !readOnly) {
		const guidelines = TODO_GUIDELINE_PREFIXES
			.map((prefix) => TODO_TOOL_DESCRIPTION.promptGuidelines?.find((rule) => rule.startsWith(prefix)))
			.filter((rule): rule is string => typeof rule === "string");
		const text = [TODO_TOOL_DESCRIPTION.promptSnippet, ...guidelines].filter(Boolean).join("\n");
		if (text) sections.push({ id: "todo", text });
	}
	if (names.has("ast_grep")) {
		const guidance = astGrepToolDescriptions(1_000, "2 MB").astGrep.promptGuidelines?.[0];
		if (guidance) sections.push({ id: "ast_grep", text: guidance });
	}
	if (names.has("subagents") && !readOnly) {
		// Respect the suite's strategy-off switch, but never inject DCP advice
		// into an external parent that has no context-pruning event lifecycle.
		const strategy = agentStrategyPrompt({
			modelRef: "openai/gpt-6", customPrompt: false, omitDcpGuidance: true, env,
		});
		if (strategy) sections.push({ id: "subagents", text: strategy });
	}
	return sections;
}
