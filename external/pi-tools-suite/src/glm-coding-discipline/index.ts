import * as fs from "node:fs";
import * as path from "node:path";
import { complete, Type } from "@earendil-works/pi-ai";
import type { Api, AssistantMessage, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";

import { loadPiToolsSuiteConfig } from "../config.js";

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
	"GLM coding agent discipline.",
	"",
	"Silent mode:",
	"While working, produce no user-visible text unless blocked by missing required user input.",
	"Do not narrate actions, tool usage, file reads, searches, plans, reasoning, progress, or next steps.",
	"Do not recap inspected context or summarize what you inspected.",
	"Do not write confirmations, preambles, or transition phrases.",
	"Keep all reasoning and task state internal.",
	"Between tool calls, output exactly nothing.",
	"",
	"Quality discipline:",
	"Act like a careful senior coding agent.",
	"Prefer correctness over speed.",
	"Do not guess APIs, types, file paths, or behavior when they can be verified.",
	"Before editing, inspect the minimal relevant code and confirm the actual implementation.",
	"After editing, verify the changed path with the narrowest relevant check.",
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

	function maybeRegisterLookupTool(cwd?: string): void {
		if (lookupRegistered) return;
		if (!lookupModelFromConfig(cwd)) return;
		lookupRegistered = true;
		pi.registerTool(createLookupTool());
	}

	maybeRegisterLookupTool(process.cwd());

	pi.on("session_start", async (_event: unknown, ctx: unknown) => {
		selectedModelRef = modelRefFromContext(ctx);
		maybeRegisterLookupTool(contextCwd(ctx));
	});

	pi.on("model_select", async (event: { model?: unknown }, ctx: unknown) => {
		selectedModelRef = modelRefFromModel(event.model) ?? modelRefFromContext(ctx);
		maybeRegisterLookupTool(contextCwd(ctx));
	});

	pi.on("before_provider_request", async (event: { payload?: unknown }, ctx: unknown) => {
		const modelRef = modelRefFromPayload(event.payload) ?? selectedModelRef ?? modelRefFromContext(ctx);
		if (!isGlmModel(modelRef)) return undefined;
		return injectCodingDisciplineIntoPayload(event.payload, { lookupEnabled: Boolean(lookupModelFromConfig(contextCwd(ctx))) });
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
		name: "lookup",
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
