import { randomUUID } from "node:crypto";
import { calculateCost, createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type SimpleStreamOptions, type ToolCall } from "@earendil-works/pi-ai";
import { ALL_ACCOUNTS_EXHAUSTED_MARKER, API_ID, ENDPOINT_PROD, PROVIDER_ID, STREAM_ENDPOINTS } from "./constants";
import { clampAccountIndex, decodeApiKey, getPiAuthPath, getStoredAccounts, readJsonFile } from "./auth-store";
import { getAntigravityHeaders, getModelHeaderStyle } from "./headers";
import { refreshNextFailoverCredential, refreshStoredAntigravityCredential } from "./oauth";
import { buildPayload, extraHeadersForPayload, partThoughtSignature } from "./payload";
import { emitAntigravityStatus } from "./status";
import type { AntigravityChunk, AntigravityModel, PiAuthData } from "./types";

function baseUsage(): NonNullable<AssistantMessage["usage"]> {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function mapStopReason(reason?: string): "stop" | "length" | "error" {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

function isFailoverCandidate(status: number | undefined, body: string): boolean {
	if (isLimitFailoverCandidate(status, body)) return true;
	const lower = body.toLowerCase();
	if (lower.includes("model_capacity_exhausted") || lower.includes("server busy") || lower.includes("overloaded") || lower.includes("capacity")) {
		return true;
	}
	return [500, 502, 503, 504].includes(status ?? 0) && (lower.includes("unavailable") || lower.includes("try again") || lower.includes("busy"));
}

function isLimitFailoverCandidate(status: number | undefined, body: string): boolean {
	if (status === 429) return true;
	const lower = body.toLowerCase();
	return lower.includes("quota_exhausted")
		|| lower.includes("quota exhausted")
		|| lower.includes("quota exceeded")
		|| lower.includes("resource_exhausted")
		|| lower.includes("resource exhausted")
		|| lower.includes("rate limit")
		|| lower.includes("rate_limit");
}

function shouldTryNextEndpoint(status: number | undefined, body: string): boolean {
	if (isFailoverCandidate(status, body)) return false;
	return [404, 500, 502, 503, 504].includes(status ?? 0);
}

async function sendAntigravityRequest(
	payload: Record<string, unknown>,
	apiKey: string,
	requestHeaders: Record<string, string>,
	model: AntigravityModel,
	options?: SimpleStreamOptions,
): Promise<{ response: Response; lastError: string }> {
	let response: Response | undefined;
	let lastError = "";
	const headerStyle = getModelHeaderStyle(model);
	const endpoints = headerStyle === "gemini-cli" ? [ENDPOINT_PROD] : STREAM_ENDPOINTS;
	for (const endpoint of endpoints) {
		response = await fetch(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
			method: "POST",
			signal: options?.signal,
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				...getAntigravityHeaders(headerStyle),
				...requestHeaders,
				...(options?.headers ?? {}),
			},
			body: JSON.stringify(payload),
		});
		await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers.entries()) }, model);
		if (response.ok) break;
		lastError = await response.text().catch(() => response?.statusText ?? "");
		if (!shouldTryNextEndpoint(response.status, lastError)) break;
	}
	if (!response) throw new Error("Antigravity request failed: no response");
	return { response, lastError };
}

function updateUsage(output: AssistantMessage, model: AntigravityModel, metadata: NonNullable<AntigravityChunk["response"]>["usageMetadata"]): void {
	if (!metadata) return;
	const cacheRead = metadata.cachedContentTokenCount ?? 0;
	output.usage = {
		input: Math.max(0, (metadata.promptTokenCount ?? 0) - cacheRead),
		output: (metadata.candidatesTokenCount ?? 0) + (metadata.thoughtsTokenCount ?? 0),
		cacheRead,
		cacheWrite: 0,
		totalTokens: metadata.totalTokenCount ?? 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	calculateCost(model, output.usage);
}

async function resolveAntigravityApiKey(optionsApiKey?: string): Promise<{ auth: PiAuthData; apiKey: string }> {
	const auth = await readJsonFile<PiAuthData>(getPiAuthPath(), {});
	const storedCredential = auth[PROVIDER_ID];

	const storedApiKey = storedCredential?.type === "oauth" && storedCredential.access && (storedCredential.expires ?? 0) > Date.now()
		? storedCredential.access
		: undefined;
	const apiKey = storedApiKey ?? optionsApiKey;
	if (apiKey) return { auth, apiKey };

	if (storedCredential?.type === "oauth") {
		const refreshed = await refreshStoredAntigravityCredential();
		if (refreshed?.apiKey) return { auth: await readJsonFile<PiAuthData>(getPiAuthPath(), {}), apiKey: refreshed.apiKey };
	}

	throw new Error(`No Antigravity OAuth account found in Pi auth: ${getPiAuthPath()}.`);
}

export function streamAntigravity(model: AntigravityModel, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: API_ID,
			provider: model.provider,
			model: model.id,
			usage: baseUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let openTextIndex: number | undefined;
		let openThinkingIndex: number | undefined;
		const closeOpenText = () => {
			if (openTextIndex === undefined) return;
			const block = output.content[openTextIndex];
			if (block?.type === "text") stream.push({ type: "text_end", contentIndex: openTextIndex, content: block.text, partial: output });
			openTextIndex = undefined;
		};
		const closeOpenThinking = () => {
			if (openThinkingIndex === undefined) return;
			const block = output.content[openThinkingIndex];
			if (block?.type === "thinking") stream.push({ type: "thinking_end", contentIndex: openThinkingIndex, content: block.thinking, partial: output });
			openThinkingIndex = undefined;
		};

		try {
			const attemptedAccountIndices = new Set<number>();
			const { auth, apiKey } = await resolveAntigravityApiKey(options?.apiKey);
			const decodedApiKey = decodeApiKey(apiKey);
			const authAccounts = getStoredAccounts(auth[PROVIDER_ID]);
			if (authAccounts.length > 0) attemptedAccountIndices.add(clampAccountIndex(auth[PROVIDER_ID]?.activeIndex, authAccounts.length));

			let payload = buildPayload(model, context, options);
			if (decodedApiKey.projectId) payload.project = decodedApiKey.projectId;
			const replacedPayload = await options?.onPayload?.(payload, model);
			if (replacedPayload !== undefined) payload = replacedPayload as Record<string, unknown>;

			stream.push({ type: "start", partial: output });
			const requestHeaders = extraHeadersForPayload(payload);
			let requestApiKey = decodedApiKey.access;
			let response: Response | undefined;
			let lastError = "";
			let allAccountsExhausted = false;
			while (true) {
				const result = await sendAntigravityRequest(payload, requestApiKey, requestHeaders, model, options);
				response = result.response;
				lastError = result.lastError;
				if (response.ok) break;
				if (!isFailoverCandidate(response.status, lastError) || options?.signal?.aborted) break;
				const nextCredential = await refreshNextFailoverCredential(attemptedAccountIndices);
				if (!nextCredential) {
					allAccountsExhausted = isLimitFailoverCandidate(response.status, lastError);
					break;
				}
				const decodedNext = decodeApiKey(nextCredential.apiKey);
				requestApiKey = decodedNext.access;
				payload = { ...payload, project: decodedNext.projectId || nextCredential.projectId };
				emitAntigravityStatus({
					kind: "switch",
					email: nextCredential.email,
					accountIndex: nextCredential.accountIndex,
					accountCount: nextCredential.accountCount,
					projectId: decodedNext.projectId || nextCredential.projectId,
					status: response.status,
				});
			}
			if (!response?.ok) {
				const status = response?.status ?? "no response";
				if (allAccountsExhausted) {
					throw new Error(`${ALL_ACCOUNTS_EXHAUSTED_MARKER} model=${model.id} status=${status}: all configured Antigravity accounts are exhausted for this model: ${lastError}`);
				}
				throw new Error(`Antigravity request failed (${status}): ${lastError}`);
			}
			if (!response.body) throw new Error("Antigravity response did not include a stream body");

			for await (const chunk of readSse(response.body, options?.signal)) {
				if (chunk.error) throw new Error(chunk.error.message ?? JSON.stringify(chunk.error));
				const inner = chunk.response;
				if (!inner) continue;
				output.responseId ||= inner.responseId;
				output.responseModel ||= inner.modelVersion;
				updateUsage(output, model, inner.usageMetadata);
				const candidate = inner.candidates?.[0];
				const parts = candidate?.content?.parts ?? [];
				for (const part of parts) {
					const thoughtSignature = partThoughtSignature(part);
					if (typeof part.text === "string") {
						if (part.thought === true) {
							closeOpenText();
							if (openThinkingIndex === undefined) {
								output.content.push({ type: "thinking", thinking: "", thinkingSignature: thoughtSignature });
								openThinkingIndex = output.content.length - 1;
								stream.push({ type: "thinking_start", contentIndex: openThinkingIndex, partial: output });
							}
							const block = output.content[openThinkingIndex];
							if (block?.type === "thinking") {
								block.thinking += part.text;
								block.thinkingSignature ||= thoughtSignature;
								stream.push({ type: "thinking_delta", contentIndex: openThinkingIndex, delta: part.text, partial: output });
							}
						} else {
							closeOpenThinking();
							if (openTextIndex === undefined) {
								output.content.push({ type: "text", text: "", textSignature: thoughtSignature });
								openTextIndex = output.content.length - 1;
								stream.push({ type: "text_start", contentIndex: openTextIndex, partial: output });
							}
							const block = output.content[openTextIndex];
							if (block?.type === "text") {
								block.text += part.text;
								block.textSignature ||= thoughtSignature;
								stream.push({ type: "text_delta", contentIndex: openTextIndex, delta: part.text, partial: output });
							}
						}
					}
					if (part.functionCall) {
						closeOpenText();
						closeOpenThinking();
						const toolCall: ToolCall = {
							type: "toolCall",
							id: part.functionCall.id || `${part.functionCall.name ?? "tool"}_${randomUUID()}`,
							name: part.functionCall.name ?? "",
							arguments: part.functionCall.args ?? {},
							...(thoughtSignature ? { thoughtSignature } : {}),
						};
						output.content.push(toolCall);
						const contentIndex = output.content.length - 1;
						stream.push({ type: "toolcall_start", contentIndex, partial: output });
						stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: output });
						stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
					}
				}
				if (candidate?.finishReason) output.stopReason = mapStopReason(candidate.finishReason);
				if (output.content.some((block) => block.type === "toolCall")) output.stopReason = "toolUse";
			}
			closeOpenText();
			closeOpenThinking();
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "error" || output.stopReason === "aborted") throw new Error("Antigravity stopped with an error finish reason");
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			closeOpenText();
			closeOpenThinking();
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
}

async function* readSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<AntigravityChunk> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.match(/\r?\n\r?\n/);
			while (boundary?.index !== undefined) {
				const raw = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary[0].length);
				const data = raw
					.split(/\r?\n/)
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trim())
					.join("\n");
				if (!data || data === "[DONE]") continue;
				yield JSON.parse(data) as AntigravityChunk;
				boundary = buffer.match(/\r?\n\r?\n/);
			}
		}
		buffer += decoder.decode();
		for (const line of buffer.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (data && data !== "[DONE]") yield JSON.parse(data) as AntigravityChunk;
		}
	} finally {
		reader.releaseLock();
	}
}
