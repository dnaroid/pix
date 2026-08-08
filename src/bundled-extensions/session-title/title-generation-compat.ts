import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { SessionTitleConfig } from "./config.js";
import {
	buildTitlePrompt,
	parseTitleModelRef,
	sanitizeSessionTitle,
	TITLE_SYSTEM_PROMPT,
	titleResponseText,
} from "./title-generation.js";

type TitleModelRegistry = Pick<ModelRegistry, "complete" | "find">;

/** Extension-side title generation through Pi's public ModelRegistry facade. */
export async function generateSessionTitle(
	input: string,
	modelRegistry: TitleModelRegistry,
	config: SessionTitleConfig,
	modelRef: string,
	signal: AbortSignal,
	onWarning?: (message: string) => void,
): Promise<string | undefined> {
	const parsedModel = parseTitleModelRef(modelRef);
	if (!parsedModel) {
		onWarning?.(`Invalid session-title model: ${modelRef}`);
		return undefined;
	}

	const model = modelRegistry.find(parsedModel.provider, parsedModel.modelId);
	if (!model) {
		onWarning?.(`Session-title model not found: ${modelRef}`);
		return undefined;
	}

	const response = await modelRegistry.complete(
		model,
		{
			systemPrompt: TITLE_SYSTEM_PROMPT,
			messages: [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildTitlePrompt(input, config.maxTitleChars) }],
					timestamp: Date.now(),
				},
			],
		},
		{
			cacheRetention: "none",
			maxRetries: config.maxRetries,
			maxTokens: config.maxTokens,
			signal,
			timeoutMs: config.timeoutMs,
		},
	);

	return sanitizeSessionTitle(titleResponseText(response), config.maxTitleChars);
}
