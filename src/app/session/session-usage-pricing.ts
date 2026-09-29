import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";

// Claude Code aliases do not persist the underlying model version. These are
// the subscription bridge's current defaults; historical alias usage is only
// an API-equivalent estimate, never a reconstructed subscription bill.
const CLAUDE_CODE_ALIASES: Readonly<Record<string, string>> = {
	opus: "claude-opus-5-5",
	sonnet: "claude-sonnet-5",
	fable: "claude-fable-5-1",
	haiku: "claude-haiku-4-5",
};
const ORIGINAL_MODELS = new Map<string, Model<"anthropic-messages">>(
	Object.values(ANTHROPIC_MODELS).map((model) => [model.id, model]),
);

export function estimateClaudeCodeCost(
	provider: string | undefined,
	model: string | undefined,
	tokens: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">,
	cacheWrite1h: number,
): number | undefined {
	if (provider !== "pi-claude-code-provider" || !model) return undefined;
	const id = Object.hasOwn(CLAUDE_CODE_ALIASES, model) ? CLAUDE_CODE_ALIASES[model]! : model;
	const original = ORIGINAL_MODELS.get(id);
	if (!original || tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) return undefined;
	const usage: Usage = {
		...tokens,
		cacheWrite1h: Math.min(cacheWrite1h, tokens.cacheWrite),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	return calculateCost(original, usage).total;
}
