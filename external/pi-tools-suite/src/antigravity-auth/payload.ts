import { randomUUID } from "node:crypto";
import type { AssistantMessage, Context, ImageContent, Message, SimpleStreamOptions, TextContent, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { DEFAULT_PROJECT_ID, MIN_THOUGHT_SIGNATURE_LENGTH, SKIP_THOUGHT_SIGNATURE } from "./constants";
import { getModelHeaderStyle } from "./headers";
import type { AntigravityContent, AntigravityModel, AntigravityPart, HeaderStyle } from "./types";

function sanitizeText(text: string): string {
	return text.replace(/[\uD800-\uDFFF]/g, "�");
}

function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || `tool_${randomUUID()}`;
}

function requiresToolCallId(modelId: string): boolean {
	return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	return match ? Number.parseInt(match[1], 10) >= 3 : true;
}

function isGemini3Model(modelId: string): boolean {
	return /^gemini(?:-live)?-3(?:[.-]|$)/i.test(modelId);
}

function isValidThoughtSignature(signature: unknown): signature is string {
	if (signature === SKIP_THOUGHT_SIGNATURE) return true;
	if (typeof signature !== "string" || signature.length < MIN_THOUGHT_SIGNATURE_LENGTH) return false;
	if (signature.length % 4 !== 0) return false;
	return /^[A-Za-z0-9+/]+={0,2}$/.test(signature);
}

export function partThoughtSignature(part: AntigravityPart): string | undefined {
	const signature = part.thoughtSignature ?? part.thought_signature;
	return typeof signature === "string" && signature.length > 0 ? signature : undefined;
}

function sameProviderAndModel(message: AssistantMessage, model: AntigravityModel): boolean {
	return message.provider === model.provider && message.model === model.id;
}

function replayThoughtSignature(message: AssistantMessage, model: AntigravityModel, signature: unknown): string | undefined {
	return sameProviderAndModel(message, model) && isValidThoughtSignature(signature) ? signature : undefined;
}

function replayFunctionCallThoughtSignature(message: AssistantMessage, model: AntigravityModel, actualModel: string, signature: unknown): string | undefined {
	const trustedSignature = replayThoughtSignature(message, model, signature);
	if (trustedSignature) return trustedSignature;
	// Gemini 3 rejects tool-call history when the first functionCall part has no
	// thought signature. Antigravity/opencode accepts this sentinel to bypass the
	// validator when the original signature is unavailable or untrusted.
	return isGemini3Model(actualModel) ? SKIP_THOUGHT_SIGNATURE : undefined;
}

function convertMessages(model: AntigravityModel, context: Context): AntigravityContent[] {
	const contents: AntigravityContent[] = [];
	const actualModel = resolveActualModel(model, undefined).actualModel;
	const includeIds = requiresToolCallId(actualModel);

	for (const message of context.messages as Message[]) {
		if (message.role === "user") {
			const parts = convertUserContent(message.content);
			if (parts.length > 0) contents.push({ role: "user", parts });
		} else if (message.role === "assistant") {
			const parts: AntigravityPart[] = [];
			let hasFunctionCallSignaturePart = false;
			for (const block of message.content) {
				if (block.type === "text" && block.text.trim()) {
					const thoughtSignature = replayThoughtSignature(message, model, block.textSignature);
					parts.push({
						text: sanitizeText(block.text),
						...(thoughtSignature ? { thoughtSignature } : {}),
					});
				} else if (block.type === "toolCall") {
					const thoughtSignature = hasFunctionCallSignaturePart
						? undefined
						: replayFunctionCallThoughtSignature(message, model, actualModel, block.thoughtSignature);
					hasFunctionCallSignaturePart = true;
					parts.push({
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(includeIds ? { id: normalizeToolCallId(block.id) } : {}),
						},
						...(thoughtSignature ? { thoughtSignature, thought_signature: thoughtSignature } : {}),
					});
				}
				// Deliberately omit previous thinking blocks; Antigravity/Claude is
				// sensitive to stale thought signatures across turns.
			}
			if (parts.length > 0) contents.push({ role: "model", parts });
		} else if (message.role === "toolResult") {
			appendToolResult(contents, message, model, actualModel, includeIds);
		}
	}

	// Claude models require every functionCall (tool_use) to have a matching
	// functionResponse (tool_result) in the immediately following user turn.
	// When replaying conversation history after an account switch, error, or
	// incomplete turn, orphaned functionCalls at the end (or in the middle if
	// toolResult messages were lost) cause INVALID_ARGUMENT. Patch them up by
	// injecting synthetic error responses for any unmatched functionCalls.
	repairOrphanedFunctionCalls(contents, includeIds);

	return contents;
}

/**
 * Walk the converted contents and ensure every model turn that contains
 * functionCall parts is followed by a user turn that contains a matching
 * functionResponse for each call. Missing responses get synthetic error
 * entries so Claude and other strict providers accept the history.
 *
 * The function scans forward through consecutive user turns after the model
 * turn to find matching responses (tool results may be spread across
 * multiple adjacent user entries). It then moves the matched responses into
 * the first user turn right after the model turn, before any text/image
 * content. Any still-unmatched calls get synthetic error responses inserted
 * in the same immediate position.
 */
function repairOrphanedFunctionCalls(contents: AntigravityContent[], includeIds: boolean): void {
	for (let i = 0; i < contents.length; i += 1) {
		const entry = contents[i];
		if (entry.role !== "model") continue;
		const functionCalls = entry.parts.filter((part) => part.functionCall);
		if (functionCalls.length === 0) continue;

		const userEntries: AntigravityContent[] = [];
		for (let j = i + 1; j < contents.length && contents[j].role === "user"; j += 1) {
			userEntries.push(contents[j]);
		}

		const responseCandidates = collectFunctionResponseCandidates(userEntries);
		const selectedResponses = new Set<AntigravityPart>();
		const immediateResponses: AntigravityPart[] = [];

		for (const call of functionCalls) {
			const match = takeMatchingFunctionResponse(call, responseCandidates, selectedResponses);
			if (match) {
				immediateResponses.push(match);
				continue;
			}
			immediateResponses.push(createSyntheticFunctionResponse(call, includeIds));
		}

		// Remove selected responses from wherever they originally appeared.
		// They will be reinserted into the first user turn immediately after
		// the model turn so provider-side Claude conversion sees tool_result
		// blocks before any user text from a fork/reload turn.
		for (const userEntry of userEntries) {
			userEntry.parts = userEntry.parts.filter((part) => !selectedResponses.has(part));
		}

		const next = contents[i + 1];
		if (next?.role === "user") {
			next.parts.unshift(...immediateResponses);
		} else {
			contents.splice(i + 1, 0, { role: "user", parts: immediateResponses });
		}
		removeEmptyUserEntriesAfter(contents, i + 1);
	}
}

function collectFunctionResponseCandidates(userEntries: AntigravityContent[]): AntigravityPart[] {
	return userEntries.flatMap((entry) => entry.parts.filter((part) => part.functionResponse));
}

function takeMatchingFunctionResponse(
	call: AntigravityPart,
	candidates: AntigravityPart[],
	selected: Set<AntigravityPart>,
): AntigravityPart | undefined {
	const callId = call.functionCall!.id;
	if (callId) {
		const byId = candidates.find((candidate) => !selected.has(candidate) && candidate.functionResponse?.id === callId);
		if (byId) {
			selected.add(byId);
			return byId;
		}
	}

	const callName = call.functionCall!.name;
	if (callName) {
		const byName = candidates.find((candidate) => !selected.has(candidate) && candidate.functionResponse?.name === callName);
		if (byName) {
			selected.add(byName);
			return byName;
		}
	}

	const positional = candidates.find((candidate) => !selected.has(candidate));
	if (positional) selected.add(positional);
	return positional;
}

function createSyntheticFunctionResponse(call: AntigravityPart, includeIds: boolean): AntigravityPart {
	return {
		functionResponse: {
			name: call.functionCall!.name,
			response: { error: "Tool call was not executed due to a provider error or account switch." },
			...(includeIds && call.functionCall!.id ? { id: call.functionCall!.id } : {}),
		} as any,
	};
}

function removeEmptyUserEntriesAfter(contents: AntigravityContent[], startIndex: number): void {
	for (let idx = contents.length - 1; idx > startIndex; idx -= 1) {
		if (contents[idx].role === "user" && contents[idx].parts.length === 0) contents.splice(idx, 1);
	}
}

function convertUserContent(content: string | (TextContent | ImageContent)[]): AntigravityPart[] {
	if (typeof content === "string") return content.trim() ? [{ text: sanitizeText(content) }] : [];
	return content.map((item) => {
		if (item.type === "text") return { text: sanitizeText(item.text) };
		return { inlineData: { mimeType: item.mimeType, data: item.data } };
	});
}

function formatToolResultOutput(text: string, images: ImageContent[]): string {
	if (text) return sanitizeText(text);
	if (images.length > 0) return "(see attached image)";
	return "";
}

function appendToolResult(
	contents: AntigravityContent[],
	message: ToolResultMessage,
	model: AntigravityModel,
	actualModel: string,
	includeIds: boolean,
): void {
	const text = message.content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n");
	const images = model.input.includes("image")
		? message.content.filter((item): item is ImageContent => item.type === "image")
		: [];
	const imageParts = images.map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } }));
	const output = formatToolResultOutput(text, images);
	const functionResponse: AntigravityPart = {
		functionResponse: {
			name: message.toolName,
			response: message.isError ? { error: output } : { output },
			...(includeIds ? { id: normalizeToolCallId(message.toolCallId) } : {}),
			...(images.length > 0 && supportsMultimodalFunctionResponse(actualModel) ? { parts: imageParts } : {}),
		} as any,
	};

	const last = contents[contents.length - 1];
	if (last?.role === "user" && last.parts.some((part) => part.functionResponse)) {
		last.parts.push(functionResponse);
	} else {
		contents.push({ role: "user", parts: [functionResponse] });
	}
	if (images.length > 0 && !supportsMultimodalFunctionResponse(actualModel)) {
		contents.push({ role: "user", parts: [{ text: "Tool result image:" }, ...imageParts] });
	}
}

const SCHEMA_DROP_KEYS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions",
	"additionalProperties",
	"patternProperties",
	"propertyNames",
	"unevaluatedProperties",
	"dependentRequired",
	"dependentSchemas",
	"default",
	"examples",
	"title",
]);

function cleanSchema(schema: unknown): unknown {
	if (!schema || typeof schema !== "object") return schema;
	if (Array.isArray(schema)) return schema.map(cleanSchema);
	const input = schema as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (key === "const") {
			output.enum = [value];
			continue;
		}
		if (SCHEMA_DROP_KEYS.has(key)) continue;
		output[key] = cleanSchema(value);
	}
	if (output.type === "object" && !output.properties) output.properties = {};
	return output;
}

function convertTools(tools?: Tool[]): Array<{ functionDeclarations: unknown[] }> | undefined {
	if (!tools?.length) return undefined;
	return [
		{
			functionDeclarations: tools.map((item) => ({
				name: item.name,
				description: item.description,
				parameters: cleanSchema(item.parameters),
			})),
		},
	];
}

function reasoningLevel(options?: SimpleStreamOptions): "minimal" | "low" | "medium" | "high" | undefined {
	const reasoning = options?.reasoning;
	if (!reasoning) return undefined;
	if (reasoning === "xhigh" || reasoning === "max") return "high";
	return reasoning;
}

function budgetForLevel(
	level: "minimal" | "low" | "medium" | "high",
	budgets: NonNullable<SimpleStreamOptions["thinkingBudgets"]>,
): number {
	if (level === "low" || level === "minimal") return budgets.low ?? 8192;
	if (level === "medium") return budgets.medium ?? 16384;
	return budgets.high ?? 32768;
}

function geminiProThinkingLevel(modelId: string, headerStyle: HeaderStyle, level: "minimal" | "low" | "medium" | "high"): "low" | "high" {
	if (headerStyle === "antigravity" && /^gemini-3\.1-pro/i.test(modelId)) return "low";
	if (level === "high") return "high";
	return "low";
}

function resolveActualModel(
	model: AntigravityModel,
	options?: SimpleStreamOptions,
): { actualModel: string; thinkingConfig?: Record<string, unknown> } {
	const headerStyle = getModelHeaderStyle(model);
	const requested = model.id.replace(/^antigravity-/i, "");
	const level = reasoningLevel(options) ?? "low";
	let effective = requested;
	const requestedLower = requested.toLowerCase();

	if (requestedLower.includes("gemini-3")) {
		if (headerStyle === "antigravity") {
			effective = requested.replace(/-preview-customtools$/i, "").replace(/-preview$/i, "");
		} else {
			effective = requested.replace(/-(minimal|low|medium|high)$/i, "");
			if (!/-preview($|-)/i.test(effective)) effective = `${effective}-preview`;
		}
	}

	const lower = effective.toLowerCase();

	if (/^gemini-3(?:\.\d+)?-pro/.test(lower)) {
		// Live Antigravity currently rejects gemini-3.1-pro-high with a generic
		// 400 INVALID_ARGUMENT, while gemini-3.1-pro-low works. Keep the public
		// model usable even when Pi's current/default thinking level is high.
		const thinkingLevel = geminiProThinkingLevel(lower, headerStyle, level);
		if (headerStyle === "antigravity") {
			return { actualModel: `${effective}-${thinkingLevel}`, thinkingConfig: { thinkingLevel, includeThoughts: true } };
		}
		return { actualModel: effective, thinkingConfig: { thinkingLevel, includeThoughts: true } };
	}
	if (/^gemini-3(?:\.\d+)?-flash/.test(lower)) {
		return { actualModel: effective, thinkingConfig: { thinkingLevel: level, includeThoughts: true } };
	}
	if (lower.includes("claude") && lower.includes("thinking")) {
		const budgets = options?.thinkingBudgets ?? {};
		const budget = budgetForLevel(level, budgets);
		return { actualModel: effective, thinkingConfig: { thinking_budget: budget, include_thoughts: true } };
	}
	if (lower.includes("gemini-2.5")) {
		const budgets = options?.thinkingBudgets ?? {};
		const budget = budgetForLevel(level, budgets);
		return { actualModel: effective, thinkingConfig: { thinkingBudget: budget, includeThoughts: true } };
	}
	return { actualModel: effective };
}

export function buildPayload(model: AntigravityModel, context: Context, options?: SimpleStreamOptions): Record<string, unknown> {
	const { actualModel, thinkingConfig } = resolveActualModel(model, options);
	const headerStyle = getModelHeaderStyle(model);
	const thinkingBudget = Number(thinkingConfig?.thinkingBudget ?? thinkingConfig?.thinking_budget ?? 0);
	const generationConfig: Record<string, unknown> = {
		maxOutputTokens: Math.max(options?.maxTokens ?? model.maxTokens ?? 8192, thinkingBudget + 1024),
	};
	if (typeof options?.temperature === "number") generationConfig.temperature = options.temperature;
	if (thinkingConfig) generationConfig.thinkingConfig = thinkingConfig;

	const request: Record<string, unknown> = {
		sessionId: options?.sessionId ?? randomUUID(),
		contents: convertMessages(model, context),
		generationConfig,
	};
	if (context.systemPrompt?.trim()) {
		request.systemInstruction = { role: "user", parts: [{ text: sanitizeText(context.systemPrompt) }] };
	}
	const tools = convertTools(context.tools);
	if (tools) request.tools = tools;

	const payload: Record<string, unknown> = {
		project: model.antigravityProjectId || DEFAULT_PROJECT_ID,
		model: actualModel,
		request,
	};
	if (headerStyle === "antigravity") {
		payload.requestType = "agent";
		payload.userAgent = "antigravity";
		payload.requestId = `agent-${randomUUID()}`;
	}
	return payload;
}

export function extraHeadersForPayload(payload: Record<string, unknown>): Record<string, string> {
	const model = typeof payload.model === "string" ? payload.model.toLowerCase() : "";
	if (model.includes("claude") && model.includes("thinking")) {
		return { "anthropic-beta": "interleaved-thinking-2025-05-14" };
	}
	return {};
}
