type ExtensionAPI = any;

const SILENT_PROMPT_MARKER_START = "<glm_silent_mode>";
const SILENT_PROMPT_MARKER_END = "</glm_silent_mode>";
const DISCIPLINE_PROMPT_MARKER_START = "<glm_coding_discipline>";
const DISCIPLINE_PROMPT_MARKER_END = "</glm_coding_discipline>";

const GLM_CODING_DISCIPLINE_PROMPT = `${DISCIPLINE_PROMPT_MARKER_START}
GLM coding agent discipline.

Silent mode:
While working, produce no user-visible text unless blocked by missing required user input.
Do not narrate actions, tool usage, file reads, searches, plans, reasoning, progress, or next steps.
Do not recap inspected context or summarize what you inspected.
Do not write confirmations, preambles, or transition phrases.
Keep all reasoning and task state internal.
Between tool calls, output exactly nothing.

Quality discipline:
Act like a careful senior coding agent.
Prefer correctness over speed.
Do not guess APIs, types, file paths, or behavior when they can be verified.
Before editing, inspect the minimal relevant code and confirm the actual implementation.
After editing, verify the changed path with the narrowest relevant check.

Maintain these invariants:
- preserve existing behavior unless the user asked to change it;
- make minimal, localized changes;
- respect project conventions already present in nearby code;
- handle edge cases, errors, cancellation, and async behavior;
- avoid blocking UI/event loops;
- avoid duplicate state, duplicate prompts, and repeated side effects.

When uncertain, test or inspect instead of assuming.
If blocked by missing required information, ask exactly one concise question.
${DISCIPLINE_PROMPT_MARKER_END}`;

const LEGACY_SILENT_PROMPT_BLOCK_PATTERN = new RegExp(
	`${escapeRegExp(SILENT_PROMPT_MARKER_START)}[\\s\\S]*?${escapeRegExp(SILENT_PROMPT_MARKER_END)}\\s*`,
	"g",
);

const DISCIPLINE_PROMPT_BLOCK_PATTERN = new RegExp(
	`${escapeRegExp(DISCIPLINE_PROMPT_MARKER_START)}[\\s\\S]*?${escapeRegExp(DISCIPLINE_PROMPT_MARKER_END)}\\s*`,
	"g",
);

export default function glmCodingDiscipline(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event: { systemPrompt?: string }, ctx: unknown) => {
		if (!isGlmModel(modelRefFromContext(ctx))) return undefined;
		return { systemPrompt: prependCodingDisciplinePrompt(event.systemPrompt ?? "") };
	});
}

export function prependCodingDisciplinePrompt(systemPrompt: string): string {
	const deduped = systemPrompt
		.replace(LEGACY_SILENT_PROMPT_BLOCK_PATTERN, "")
		.replace(DISCIPLINE_PROMPT_BLOCK_PATTERN, "")
		.trimStart();
	return deduped ? `${GLM_CODING_DISCIPLINE_PROMPT}\n\n${deduped}` : GLM_CODING_DISCIPLINE_PROMPT;
}

export function isGlmModel(modelRef: string | undefined): boolean {
	if (!modelRef) return false;
	return /(?:^|[/:_.-])glm(?:$|[/:_.-]|\d)/i.test(modelRef);
}

function modelRefFromContext(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	const model = (ctx as { model?: unknown }).model;
	if (!model) return undefined;
	if (typeof model === "string") return model;
	if (typeof model !== "object") return undefined;

	const candidate = model as {
		provider?: unknown;
		providerId?: unknown;
		id?: unknown;
		model?: unknown;
		modelId?: unknown;
		name?: unknown;
	};
	const provider = typeof candidate.provider === "string"
		? candidate.provider
		: typeof candidate.providerId === "string"
			? candidate.providerId
			: undefined;
	const modelId = typeof candidate.modelId === "string"
		? candidate.modelId
		: typeof candidate.id === "string"
			? candidate.id
			: typeof candidate.model === "string"
				? candidate.model
				: typeof candidate.name === "string"
					? candidate.name
					: undefined;
	if (provider && modelId) return `${provider}/${modelId}`;
	return modelId;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
