import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseModelRef } from "./pix-settings.js";

/** Streamed output: `reset` discards text from a failed fallback candidate. */
export type AssistDelta = { readonly text: string } | { readonly reset: true };

export interface AssistModelRequest {
	readonly modelRefs: readonly string[];
	readonly systemPrompt: string;
	readonly prompt: string;
	readonly maxTokens: number;
	readonly timeoutMs: number;
	readonly signal: AbortSignal;
	readonly onDelta?: (delta: AssistDelta) => Promise<void> | void;
}

/** Runs one prompt over an ordered model chain; cancellation is terminal and never advances the chain. */
export type AssistModelRunner = (request: AssistModelRequest) => Promise<string>;

export function createAssistModelRunner(createModelRuntime: () => Promise<ModelRuntime> = () => ModelRuntime.create()): AssistModelRunner {
	let runtimePromise: Promise<ModelRuntime> | undefined;
	const getRuntime = async (): Promise<ModelRuntime> => {
		runtimePromise ??= createModelRuntime();
		try {
			return await runtimePromise;
		} catch (error) {
			runtimePromise = undefined;
			throw error;
		}
	};

	return async ({ modelRefs, systemPrompt, prompt, maxTokens: limit, timeoutMs, signal, onDelta }) => {
		if (modelRefs.length === 0) throw new Error("No assistant model is configured");
		const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
		const runtime = await getRuntime();
		let refreshed = false;
		let lastError: unknown;
		let streamed = false;

		for (const modelRef of modelRefs) {
			if (requestSignal.aborted) throw requestSignal.reason ?? new Error("Assistant request aborted");
			const parsed = parseModelRef(modelRef);
			if (!parsed) {
				lastError = new Error(`Invalid assistant model: ${modelRef}`);
				continue;
			}
			let model = runtime.getModel(parsed.provider, parsed.modelId);
			if (!model && !refreshed) {
				await runtime.refresh({ signal: requestSignal });
				refreshed = true;
				model = runtime.getModel(parsed.provider, parsed.modelId);
			}
			if (!model) {
				lastError = new Error(`Assistant model not found: ${parsed.provider}/${parsed.modelId}`);
				continue;
			}
			try {
				const maxTokens = model.maxTokens > 0 ? Math.min(model.maxTokens, limit) : limit;
				if (streamed) { await onDelta?.({ reset: true }); streamed = false; }
				let output = "";
				let streamError: string | undefined;
				const stream = runtime.streamSimple(
					{ ...model, maxTokens },
					{ systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
					{
						signal: requestSignal,
						// Like autocomplete: no reasoning unless the ref carries an explicit suffix.
						...(parsed.thinkingLevel && parsed.thinkingLevel !== "off" ? { reasoning: parsed.thinkingLevel } : {}),
						cacheRetention: "none",
						maxRetryDelayMs: 0,
						maxRetries: 0,
						maxTokens,
						timeoutMs,
					},
				);
				for await (const event of stream) {
					if (event.type === "text_delta") {
						output += event.delta;
						if (onDelta && event.delta) { streamed = true; await onDelta({ text: event.delta }); }
					}
					else if (event.type === "done" && !output) output = assistantText(event.message);
					else if (event.type === "error") streamError = event.error.errorMessage ?? event.reason;
				}
				if (streamError) throw new Error(streamError);
				const cleaned = output.replace(/\r\n/gu, "\n").trim();
				if (!cleaned) throw new Error("Assistant returned an empty answer");
				return cleaned;
			} catch (error) {
				if (requestSignal.aborted) throw requestSignal.reason ?? error;
				lastError = error;
			}
		}
		throw lastError ?? new Error("No assistant models are configured");
	};
}

function assistantText(message: unknown): string {
	if (!isRecord(message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) =>
		isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
