import * as fs from "node:fs";
import * as path from "node:path";
import { complete } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { loadPiToolsSuiteConfig } from "../config.js";
import { ignoreStaleExtensionContextError } from "../context-usage.js";

type ExtensionAPI = any;

type LookupParams = {
	query: string;
	context?: string;
	imagePaths?: string[];
};

type LookupDetails = {
	model: string;
	imageCount: number;
	imagePathCount: number;
	contextChars: number;
	stopReason?: string;
	error?: string;
};

type ResolvedLookupModel = {
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
};

const SILENT_PROMPT_MARKER_START = "<glm_silent_mode>";
const SILENT_PROMPT_MARKER_END = "</glm_silent_mode>";
const DISCIPLINE_PROMPT_MARKER_START = "<glm_coding_discipline>";
const DISCIPLINE_PROMPT_MARKER_END = "</glm_coding_discipline>";
const DEFAULT_LOOKUP_MAX_CONTEXT_CHARS = 8_000;
const DEFAULT_LOOKUP_MAX_IMAGES = 6;
const DEFAULT_LOOKUP_MAX_TOKENS = 1_600;
const DEFAULT_LOOKUP_TIMEOUT_MS = 120_000;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const SILENCE_REMINDER_MIN_VIOLATION_GAP = 3;
const SILENCE_REMINDER_MIN_MESSAGE_GAP = 12;
const LOOKUP_TOOL_NAME = "lookup";

const LOOKUP_TOOL_PARAMS = Type.Object(
	{
		query: Type.String({
			description: "Focused question for the vision-capable lookup model. Include what to verify visually and any relevant user/problem context.",
		}),
		context: Type.Optional(Type.String({
			description: "Extra text context not already obvious from the recent session, such as expected behavior, candidate file/function, or suspected UI bug.",
		})),
		imagePaths: Type.Optional(Type.Array(Type.String(), {
			description: "Optional local screenshot/image paths to inspect. Recent attached images from the session are included automatically.",
		})),
	},
	{ additionalProperties: false },
);

const QUALITY_DISCIPLINE_LINES = [
	"GLM TOOL-ONLY CODING AGENT CONTRACT.",
	"",
	"This contract controls the assistant output channel. Follow it literally.",
	"Treat every user coding request as a tool-driven task, not a chat conversation.",
	"",
	"OUTPUT STATE MACHINE:",
	"",
	"STATE = WORKING from the first assistant turn until the task is complete or blocked.",
	"In WORKING state, the assistant message MUST be exactly one tool call.",
	"In WORKING state, the assistant message text/content MUST be empty.",
	"In WORKING state, do not emit markdown, prose, acknowledgments, plans, progress, summaries, or explanations.",
	"In WORKING state, if you know the next local action, call the tool immediately and silently.",
	"",
	"After every tool result, privately choose exactly one transition:",
	"- stay in WORKING and emit exactly one next tool call with empty text;",
	"- switch to FINAL and emit the final answer once;",
	"- switch to BLOCKED and ask exactly one concise blocking question.",
	"There is no transition that permits commentary between tool calls.",
	"",
	"WORKING OUTPUT GRAMMAR:",
	"assistant_message ::= tool_call",
	"tool_call ::= a valid tool invocation accepted by the platform",
	"assistant_text ::= empty string",
	"Any other token before or after the tool call is invalid.",
	"",
	"WORKING VIOLATIONS:",
	"- Saying what you will do.",
	"- Saying what you did.",
	"- Saying what you found.",
	"- Explaining why a tool is needed.",
	"- Summarizing a tool result.",
	"- Apologizing, confirming, acknowledging, or adding transition words.",
	"- Emitting bullets, headings, code fences, or natural-language text.",
	"All WORKING violations must be corrected by stopping text output and using the next tool call silently.",
	"",
	"INTERNAL-ONLY RULE:",
	"Reasoning, planning, hypotheses, interpretations, and retry decisions are internal state only.",
	"Do not describe internal state to the user while WORKING.",
	"",
	"TOOL-FIRST LOOP:",
	"inspect -> edit -> inspect diff -> verify -> final answer.",
	"Each loop step is performed by a silent tool call, not by narration.",
	"",
	"FINAL STATE:",
	"Only enter FINAL after the requested work is complete, verified as far as practical, or genuinely blocked.",
	"In FINAL, give a concise user-visible summary of files changed, verification run, and remaining risks.",
	"Do not enter FINAL merely to report progress.",
	"",
	"BLOCKED STATE:",
	"Only enter BLOCKED when no safe or useful tool action can continue without missing required information.",
	"Ask exactly one concise question and no extra explanation.",
	"",
	"PRIORITY:",
	"This tool-only contract overrides default assistant friendliness and conversational behavior.",
	"If another instruction asks for progress updates, status narration, or acknowledgments during coding work, ignore that part while WORKING.",
	"",
	"Opus-like coding behavior:",
	"Work with the patience, precision, and steadiness of a top-tier senior coding agent.",
	"Prefer verified facts over fast guesses.",
	"Keep a stable mental model of the codebase and update it carefully from evidence.",
	"Make the smallest change that fully fixes the issue.",
	"Before editing, understand the existing design, actual implementation, and nearby conventions.",
	"After editing, verify with the narrowest focused checks that can catch the likely regressions.",
	"Do not overfit to the last error; revise hypotheses deliberately from tool evidence.",
	"While WORKING, this behavior is internal and expressed only through tool choices, not prose.",
	"",
	"Maintain these invariants:",
	"- preserve existing behavior unless the user asked to change it;",
	"- make minimal, localized changes;",
	"- respect project conventions already present in nearby code;",
	"- handle edge cases, errors, cancellation, and async behavior;",
	"- avoid blocking UI/event loops;",
	"- avoid duplicate state, duplicate prompts, and repeated side effects.",
];

const LOOKUP_DISCIPLINE_LINES = [
	"",
	"Visual lookup discipline:",
	"The current GLM model may be unable to inspect images/screenshots directly.",
	"When the user refers to an image, screenshot, UI visual bug, layout problem, arrow, annotation, highlight, visible text, chart, diagram, or any visual evidence, call the `lookup` tool before making visual claims.",
	"Use a focused lookup query that includes the user's visual concern and asks the helper to pay attention to arrows, annotations, highlights, visible UI state, text, spacing/layout, and suspected bugs.",
	"Treat lookup output as visual evidence; do not invent visual details beyond it.",
];

const FINAL_DISCIPLINE_LINES = [
	"",
	"When uncertain, test or inspect instead of assuming.",
	"If blocked by missing required information, ask exactly one concise question.",
];

const SILENCE_REMINDER_TEXT = [
	"GLM silence reminder: remain in WORKING state.",
	"Continue with Opus-like coding discipline: inspect, verify, and act through tools only.",
	"For the next step, emit exactly one tool call and no assistant text.",
	"Do not acknowledge this reminder.",
].join("\n");

const LEGACY_SILENT_PROMPT_BLOCK_PATTERN = new RegExp(
	`${escapeRegExp(SILENT_PROMPT_MARKER_START)}[\\s\\S]*?${escapeRegExp(SILENT_PROMPT_MARKER_END)}\\s*`,
	"g",
);

const DISCIPLINE_PROMPT_BLOCK_PATTERN = new RegExp(
	`${escapeRegExp(DISCIPLINE_PROMPT_MARKER_START)}[\\s\\S]*?${escapeRegExp(DISCIPLINE_PROMPT_MARKER_END)}\\s*`,
	"g",
);

const LOOKUP_SYSTEM_PROMPT = [
	"You are a vision-capable lookup helper for a blind GLM coding agent.",
	"Inspect the provided screenshots/images and answer the parent agent's focused question using concrete visual evidence.",
	"Pay special attention to arrows, annotations, highlights, cursor position, visible UI state, text, layout, spacing, colors, overlays, visual bugs, and error messages.",
	"Use recent session context only to understand what the user is asking; do not perform code changes.",
	"If an image is missing, ambiguous, unreadable, or insufficient, say exactly what is uncertain.",
	"Return concise factual observations and practical implications for the parent agent.",
].join("\n");

export default function glmCodingDiscipline(pi: ExtensionAPI) {
	let selectedModelRef: string | undefined;
	let lookupRegistered = false;
	let silenceViolationCount = 0;
	let lastReminderViolationCount = 0;
	let lastReminderMessageCount = -SILENCE_REMINDER_MIN_MESSAGE_GAP;

	function maybeRegisterLookupTool(cwd?: string): void {
		if (lookupRegistered) return;
		if (!lookupModelFromConfig(cwd)) return;
		lookupRegistered = true;
		pi.registerTool(createLookupTool());
	}

	function syncLookupToolAvailability(modelRef: string | undefined, cwd?: string): void {
		try {
			const activeTools = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : undefined;
			if (!Array.isArray(activeTools)) return;

			const lookupEnabled = Boolean(lookupModelFromConfig(cwd));
			const shouldExposeLookup = lookupEnabled && isGlmModel(modelRef);
			const hasLookup = activeTools.includes(LOOKUP_TOOL_NAME);

			if (shouldExposeLookup === hasLookup) return;
			if (typeof pi.setActiveTools !== "function") return;

			const nextTools = shouldExposeLookup
				? [...activeTools, LOOKUP_TOOL_NAME]
				: activeTools.filter((tool: unknown) => tool !== LOOKUP_TOOL_NAME);
			pi.setActiveTools([...new Set(nextTools)]);
		} catch (error) {
			ignoreStaleExtensionContextError(error);
		}
	}

	maybeRegisterLookupTool(process.cwd());

	pi.on("session_start", async (_event: unknown, ctx: unknown) => {
		selectedModelRef = modelRefFromContext(ctx);
		maybeRegisterLookupTool(contextCwd(ctx));
		syncLookupToolAvailability(selectedModelRef, contextCwd(ctx));
	});

	pi.on("model_select", async (event: { model?: unknown }, ctx: unknown) => {
		selectedModelRef = modelRefFromModel(event.model) ?? modelRefFromContext(ctx);
		maybeRegisterLookupTool(contextCwd(ctx));
		syncLookupToolAvailability(selectedModelRef, contextCwd(ctx));
	});

	pi.on("before_provider_request", async (event: { payload?: unknown }, ctx: unknown) => {
		const modelRef = modelRefFromPayload(event.payload) ?? selectedModelRef ?? modelRefFromContext(ctx);
		if (!isGlmModel(modelRef)) return undefined;
		return injectCodingDisciplineIntoPayload(event.payload, { lookupEnabled: Boolean(lookupModelFromConfig(contextCwd(ctx))) });
	});

	pi.on("context", async (event: { messages?: unknown[] }, ctx: unknown) => {
		const modelRef = selectedModelRef ?? modelRefFromContext(ctx);
		if (!isGlmModel(modelRef) || !Array.isArray(event.messages)) return undefined;

		const violationCount = countAssistantToolChatter(event.messages);
		if (violationCount <= silenceViolationCount) return undefined;

		const messageCount = event.messages.length;
		const violationGap = violationCount - lastReminderViolationCount;
		const messageGap = messageCount - lastReminderMessageCount;
		silenceViolationCount = violationCount;

		if (violationGap < SILENCE_REMINDER_MIN_VIOLATION_GAP && messageGap < SILENCE_REMINDER_MIN_MESSAGE_GAP) return undefined;

		lastReminderViolationCount = violationCount;
		lastReminderMessageCount = messageCount;
		return { messages: [...event.messages, createSilenceReminderMessage()] };
	});
}

export function prependCodingDisciplinePrompt(systemPrompt: string, options: { lookupEnabled?: boolean } = {}): string {
	const deduped = systemPrompt
		.replace(LEGACY_SILENT_PROMPT_BLOCK_PATTERN, "")
		.replace(DISCIPLINE_PROMPT_BLOCK_PATTERN, "")
		.trimStart();
	const prompt = buildCodingDisciplinePrompt(options);
	return deduped ? `${prompt}\n\n${deduped}` : prompt;
}

export function buildCodingDisciplinePrompt(options: { lookupEnabled?: boolean } = {}): string {
	return [
		DISCIPLINE_PROMPT_MARKER_START,
		...QUALITY_DISCIPLINE_LINES,
		...(options.lookupEnabled ? LOOKUP_DISCIPLINE_LINES : []),
		...FINAL_DISCIPLINE_LINES,
		DISCIPLINE_PROMPT_MARKER_END,
	].join("\n");
}

export function isGlmModel(modelRef: string | undefined): boolean {
	if (!modelRef) return false;
	return /(?:^|[/:_.-])glm(?:$|[/:_.-]|\d)/i.test(modelRef);
}

export function injectCodingDisciplineIntoPayload(payload: unknown, options: { lookupEnabled?: boolean } = {}): unknown {
	if (!isRecord(payload)) return payload;

	if (typeof payload.instructions === "string") {
		return { ...payload, instructions: prependCodingDisciplinePrompt(payload.instructions, options) };
	}

	if (Array.isArray(payload.messages)) {
		return { ...payload, messages: injectIntoMessages(payload.messages, options) };
	}

	if (typeof payload.system === "string") {
		return { ...payload, system: prependCodingDisciplinePrompt(payload.system, options) };
	}

	if (Array.isArray(payload.input)) {
		return { ...payload, input: injectIntoMessages(payload.input, options) };
	}

	return payload;
}

function createLookupTool() {
	return {
		name: LOOKUP_TOOL_NAME,
		label: "Lookup",
		description: [
			"Ask the configured vision-capable lookup model to inspect recent image/screenshot context and answer a focused visual question.",
			"Use this before making claims about screenshots, arrows, annotations, UI visual bugs, layout/spacing, charts, diagrams, visible text, or image-only evidence.",
			"Recent image attachments are included automatically; pass imagePaths when the relevant screenshot is a local file path.",
		].join(" "),
		promptSnippet: "lookup: inspect screenshots/images with the configured vision-capable model for blind GLM visual questions.",
		promptGuidelines: [
			"For screenshot/image/UI visual issues, call lookup with a focused query before claiming what is visible.",
			"Mention arrows, annotations, highlights, visible text, layout, and suspected visual bugs in the lookup query when relevant.",
		],
		parameters: LOOKUP_TOOL_PARAMS,
		renderShell: "default" as const,
		executionMode: "sequential" as const,
		async execute(_toolCallId: string, params: LookupParams, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown) {
			const cwd = contextCwd(ctx) ?? process.cwd();
			const lookupModelRef = lookupModelFromConfig(cwd);
			if (!lookupModelRef) {
				return lookupToolTextResult("lookupModel is not configured in pi-tools-suite config; lookup is disabled.", {
					model: "",
					imageCount: 0,
					imagePathCount: 0,
					contextChars: 0,
					error: "lookupModel is not configured",
				});
			}

			const resolved = await resolveLookupModel(ctx, lookupModelRef);
			if (!resolved) {
				return lookupToolTextResult(`Lookup model is unavailable or unauthenticated: ${lookupModelRef}`, {
					model: lookupModelRef,
					imageCount: 0,
					imagePathCount: params.imagePaths?.length ?? 0,
					contextChars: 0,
					error: "lookup model unavailable",
				});
			}

			const recentContext = buildRecentSessionContext(ctx, DEFAULT_LOOKUP_MAX_CONTEXT_CHARS);
			const sessionImages = extractRecentSessionImages(ctx, DEFAULT_LOOKUP_MAX_IMAGES);
			const pathImages = readImagePathContents(cwd, params.imagePaths ?? [], Math.max(0, DEFAULT_LOOKUP_MAX_IMAGES - sessionImages.length));
			const images = [...sessionImages, ...pathImages.images].slice(0, DEFAULT_LOOKUP_MAX_IMAGES);
			const promptText = buildLookupPrompt(params, recentContext, images.length, pathImages.warnings);

			try {
				const response = await complete(
					resolved.model,
					{
						systemPrompt: LOOKUP_SYSTEM_PROMPT,
						messages: [
							{
								role: "user" as const,
								content: [{ type: "text" as const, text: promptText }, ...images],
								timestamp: Date.now(),
							},
						],
					},
					{
						apiKey: resolved.apiKey,
						headers: resolved.headers,
						cacheRetention: "none",
						maxRetries: 1,
						maxTokens: DEFAULT_LOOKUP_MAX_TOKENS,
						signal,
						timeoutMs: DEFAULT_LOOKUP_TIMEOUT_MS,
					},
				);
				const text = responseText(response).trim() || "Lookup returned no text.";
				const suffix = response.stopReason === "error" && response.errorMessage ? `\n\nLookup error: ${response.errorMessage}` : "";
				return lookupToolTextResult(`${text}${suffix}`, {
					model: lookupModelRef,
					imageCount: images.length,
					imagePathCount: pathImages.images.length,
					contextChars: recentContext.length,
					stopReason: response.stopReason,
					...(response.stopReason === "error" && response.errorMessage ? { error: response.errorMessage } : {}),
				});
			} catch (error) {
				if (signal?.aborted || isAbortError(error)) throw error;
				const message = error instanceof Error ? error.message : String(error);
				return lookupToolTextResult(`Lookup failed: ${message}`, {
					model: lookupModelRef,
					imageCount: images.length,
					imagePathCount: pathImages.images.length,
					contextChars: recentContext.length,
					error: message,
				});
			}
		},
	};
}

function injectIntoMessages(messages: unknown[], options: { lookupEnabled?: boolean }): unknown[] {
	const next = [...messages];
	const index = next.findIndex(isInstructionMessage);
	if (index === -1) return [{ role: "system", content: buildCodingDisciplinePrompt(options) }, ...next];

	const message = next[index] as Record<string, unknown>;
	const injected = injectIntoMessageContent(message.content, options);
	if (injected === undefined) {
		next[index] = { ...message, content: buildCodingDisciplinePrompt(options) };
	} else {
		next[index] = { ...message, content: injected };
	}
	return next;
}

function injectIntoMessageContent(content: unknown, options: { lookupEnabled?: boolean }): unknown {
	if (typeof content === "string") return prependCodingDisciplinePrompt(content, options);
	if (!Array.isArray(content)) return undefined;

	const next = [...content];
	const textIndex = next.findIndex((part) => isRecord(part) && part.type === "text" && typeof part.text === "string");
	if (textIndex === -1) return [{ type: "text", text: buildCodingDisciplinePrompt(options) }, ...next];

	const textPart = next[textIndex] as Record<string, unknown>;
	next[textIndex] = { ...textPart, text: prependCodingDisciplinePrompt(String(textPart.text ?? ""), options) };
	return next;
}

function isInstructionMessage(message: unknown): boolean {
	if (!isRecord(message)) return false;
	return message.role === "system" || message.role === "developer";
}

function countAssistantToolChatter(messages: readonly unknown[]): number {
	let count = 0;
	for (const message of messages) {
		if (!isAssistantToolChatter(message)) continue;
		count++;
	}
	return count;
}

function isAssistantToolChatter(message: unknown): boolean {
	if (!isRecord(message) || message.role !== "assistant") return false;
	if (!Array.isArray(message.content)) return false;
	const hasToolCall = message.content.some((part) => isRecord(part) && part.type === "toolCall");
	if (!hasToolCall) return false;
	return message.content.some((part) => isRecord(part) && part.type === "text" && hasNonEmptyText(part.text));
}

function hasNonEmptyText(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function createSilenceReminderMessage() {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text: SILENCE_REMINDER_TEXT }],
		timestamp: Date.now(),
	};
}

function lookupModelFromConfig(cwd?: string): string | undefined {
	return loadPiToolsSuiteConfig(["glm-coding-discipline"], { cwd: cwd ?? process.cwd() }).lookupModel;
}

function buildLookupPrompt(params: LookupParams, recentContext: string, imageCount: number, warnings: string[]): string {
	return [
		"Lookup request from a blind GLM parent model.",
		"",
		"Focused question:",
		params.query.trim(),
		params.context?.trim() ? `\nAdditional context:\n${params.context.trim()}` : "",
		"",
		`Images provided to this lookup: ${imageCount}`,
		warnings.length ? `Image path warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}` : "",
		"",
		"Recent session context:",
		truncate(recentContext || "(no recent context)", DEFAULT_LOOKUP_MAX_CONTEXT_CHARS),
		"",
		"Answer requirements:",
		"- inspect only the provided images and context;",
		"- explicitly mention arrows, annotations, highlights, visible labels/text, UI state, layout, spacing, and visual bugs when relevant;",
		"- separate observed facts from uncertainty;",
		"- keep the answer compact enough for the parent agent to use directly.",
	].filter(Boolean).join("\n");
}

function buildRecentSessionContext(ctx: unknown, maxChars: number): string {
	const branch = sessionBranch(ctx);
	const chunks: string[] = [];
	for (let i = branch.length - 1; i >= 0 && chunks.join("\n\n").length < maxChars; i--) {
		const text = sessionEntryToText(branch[i]);
		if (text) chunks.unshift(text);
	}
	return truncate(chunks.join("\n\n"), maxChars);
}

function sessionEntryToText(entry: unknown): string | undefined {
	if (!isRecord(entry)) return undefined;
	if (entry.type === "message") return messageToContextText(entry.message);
	if (entry.type === "custom_message") return `custom:${String(entry.customType ?? "unknown")}: ${contentToText(entry.content)}`;
	if (entry.type === "branch_summary") return `branch summary: ${String(entry.summary ?? "")}`;
	if (entry.type === "compaction") return `compaction summary: ${String(entry.summary ?? "")}`;
	return undefined;
}

function messageToContextText(message: unknown): string | undefined {
	if (!isRecord(message)) return undefined;
	const role = typeof message.role === "string" ? message.role : "message";
	if (role === "assistant") {
		const text = contentToText(message.content);
		return text ? `assistant: ${text}` : undefined;
	}
	if (role === "toolResult") {
		const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
		const text = contentToText(message.content);
		return text ? `tool:${toolName}: ${text}` : undefined;
	}
	const text = contentToText(message.content);
	return text ? `${role}: ${text}` : undefined;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => {
		if (!isRecord(part)) return "";
		if (part.type === "text" && typeof part.text === "string") return part.text;
		if (part.type === "image") return `[image:${typeof part.mimeType === "string" ? part.mimeType : "unknown"}]`;
		if (part.type === "toolCall") return `[toolCall:${typeof part.name === "string" ? part.name : "unknown"}]`;
		return "";
	}).filter(Boolean).join("\n");
}

function extractRecentSessionImages(ctx: unknown, maxImages: number): ImageContent[] {
	const images: ImageContent[] = [];
	const branch = sessionBranch(ctx);
	for (let i = branch.length - 1; i >= 0 && images.length < maxImages; i--) {
		for (const image of imagesFromSessionEntry(branch[i])) {
			images.push(image);
			if (images.length >= maxImages) break;
		}
	}
	return images;
}

function imagesFromSessionEntry(entry: unknown): ImageContent[] {
	if (!isRecord(entry)) return [];
	if (entry.type === "message" && isRecord(entry.message)) return imagesFromContent(entry.message.content);
	if (entry.type === "custom_message") return imagesFromContent(entry.content);
	return [];
}

function imagesFromContent(content: unknown): ImageContent[] {
	if (!Array.isArray(content)) return [];
	return content.filter(isImageContent);
}

function readImagePathContents(cwd: string, imagePaths: string[], maxImages: number): { images: ImageContent[]; warnings: string[] } {
	const images: ImageContent[] = [];
	const warnings: string[] = [];
	for (const imagePath of imagePaths) {
		if (images.length >= maxImages) {
			warnings.push(`Skipped ${imagePath}: image limit reached.`);
			continue;
		}
		const resolved = path.resolve(cwd, imagePath);
		try {
			const stat = fs.statSync(resolved);
			if (!stat.isFile()) {
				warnings.push(`Skipped ${imagePath}: not a file.`);
				continue;
			}
			if (stat.size > MAX_IMAGE_BYTES) {
				warnings.push(`Skipped ${imagePath}: file is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MiB.`);
				continue;
			}
			const mimeType = mimeTypeForImagePath(resolved);
			if (!mimeType) {
				warnings.push(`Skipped ${imagePath}: unsupported image extension.`);
				continue;
			}
			images.push({ type: "image", data: fs.readFileSync(resolved).toString("base64"), mimeType });
		} catch (error) {
			warnings.push(`Skipped ${imagePath}: ${error instanceof Error ? error.message : String(error)}.`);
		}
	}
	return { images, warnings };
}

function mimeTypeForImagePath(filePath: string): string | undefined {
	switch (path.extname(filePath).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		default:
			return undefined;
	}
}

async function resolveLookupModel(ctx: unknown, modelRef: string): Promise<ResolvedLookupModel | undefined> {
	const parsed = parseModelRef(modelRef);
	if (!parsed || !isRecord(ctx)) return undefined;
	const registry = ctx.modelRegistry;
	if (!isRecord(registry) || typeof registry.find !== "function" || typeof registry.getApiKeyAndHeaders !== "function") return undefined;
	const model = registry.find(parsed.provider, parsed.modelId) as Model<Api> | undefined;
	if (!model) return undefined;
	const auth = await registry.getApiKeyAndHeaders(model) as { ok?: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string };
	if (auth.ok === false) return undefined;
	return { model, apiKey: auth.apiKey, headers: auth.headers };
}

function parseModelRef(modelRef: string): { provider: string; modelId: string } | undefined {
	const trimmed = modelRef.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

function responseText(response: AssistantMessage): string {
	return response.content
		.filter((block): block is TextContent => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function lookupToolTextResult(text: string, details: LookupDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function sessionBranch(ctx: unknown): unknown[] {
	if (!isRecord(ctx)) return [];
	const manager = ctx.sessionManager;
	if (!isRecord(manager) || typeof manager.getBranch !== "function") return [];
	try {
		const branch = manager.getBranch();
		return Array.isArray(branch) ? branch : [];
	} catch {
		return [];
	}
}

function modelRefFromContext(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	const model = (ctx as { model?: unknown }).model;
	return modelRefFromModel(model);
}

function modelRefFromPayload(payload: unknown): string | undefined {
	if (!isRecord(payload)) return undefined;
	const model = typeof payload.model === "string" ? payload.model : undefined;
	return model;
}

function modelRefFromModel(model: unknown): string | undefined {
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

function contextCwd(ctx: unknown): string | undefined {
	return isRecord(ctx) && typeof ctx.cwd === "string" ? ctx.cwd : undefined;
}

function isImageContent(value: unknown): value is ImageContent {
	return isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string";
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || /\baborted\b/i.test(error.message));
}

function truncate(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars).trimEnd()}…`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
