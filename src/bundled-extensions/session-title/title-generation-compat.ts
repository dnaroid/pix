import type { Api, Model } from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { SessionTitleConfig } from "./config.js";
import {
	buildTitlePrompt,
	parseTitleModelRef,
	sanitizeSessionTitle,
	TITLE_SYSTEM_PROMPT,
	titleResponseText,
} from "./title-generation.js";

type TitleModelRegistry = {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getApiKeyAndHeaders(model: Model<Api>): Promise<
		| { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
		| { ok: false; error: string }
	>;
};

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

	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false) {
		onWarning?.(auth.error);
		return undefined;
	}

	const response = await complete(
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
			...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
			...(auth.headers === undefined ? {} : { headers: auth.headers }),
			...(auth.env === undefined ? {} : { env: auth.env }),
			cacheRetention: "none",
			maxRetries: config.maxRetries,
			maxTokens: config.maxTokens,
			signal,
			timeoutMs: config.timeoutMs,
		},
	);

	return sanitizeSessionTitle(titleResponseText(response), config.maxTitleChars);
}
