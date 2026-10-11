import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { completeWithModelRegistry, type ModelCompletionRegistry } from "../../model-completion.js";
import { currentModelRef, resolveSubagentRoutingConfig, type SubagentConfig } from "./config.js";

export type UltraworkAutoDecision = "ultrawork" | "hint" | "none";

export interface UltraworkAutoContext {
	model?: unknown;
	modelRegistry?: ModelCompletionRegistry & {
		find(provider: string, modelId: string): Model<Api> | undefined;
		getApiKeyAndHeaders(model: Model<Api>): Promise<
			| { ok?: true; apiKey?: string; headers?: ProviderHeaders; baseUrl?: string; env?: Record<string, string> }
			| { ok: false; error: string }
		>;
	};
	hasUI?: boolean;
	ui?: { notify?(message: string, level?: string): void };
}

export const ULTRAWORK_AUTO_HINT = [
	"Auto-ultrawork hint:",
	"Follow the delegation policy in the subagents tool description. Keep implementation in the parent unless an explicit user request, concrete implementation capability gap, or sufficiently large deterministic mechanical transformation justifies a handoff. Broad scope or parallelism alone is not enough; use bounded research only for a named unresolved question.",
].join(" ");

const TRUE_ENV_PATTERN = /^(1|true|yes|on|auto)$/i;

const CLASSIFIER_SYSTEM_PROMPT = [
	"You classify the FIRST user message for Pi ultrawork mode.",
	"This is a weak-model routing task: be conservative and follow the labels exactly.",
	"Return exactly one lowercase word: ultrawork, hint, or none.",
	"ultrawork = an explicit user request to delegate or split independent tracks, or real UI QA requiring its dedicated agent.",
	"hint = possible named uncertainty or capability gap, or a vague bug/feature request needing scope assessment; the parent must establish valid delegation grounds first.",
	"Size, broad scope, parallelism, model tier and token price alone never justify implementation delegation.",
	"none = simple chat, one known file, exact lookup, trivial edit, or narrow question.",
	"When uncertain between ultrawork and hint, choose hint. When uncertain between hint and none, choose none.",
].join("\n");

export function isUltraworkAutoEnvEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return [env.ULTRAWORK_AUTO, env.PI_ULTRAWORK_AUTO, env.ASYNC_SUBAGENTS_ULTRAWORK_AUTO, env.PI_SUBAGENTS_ULTRAWORK_AUTO]
		.some((value) => typeof value === "string" && TRUE_ENV_PATTERN.test(value.trim()));
}

export function isGptLikeModel(modelRef: string | undefined): boolean {
	if (!modelRef) return false;
	const lower = modelRef.toLowerCase();
	return lower.includes("openai-codex/") || /\bgpt(?:[-_.\w]*)?\b/i.test(modelRef);
}

export function appendUltraworkAutoHint(text: string): string {
	return `${text.trimEnd()}\n\n${ULTRAWORK_AUTO_HINT}`;
}

export async function decideUltraworkAuto(
	userText: string,
	config: SubagentConfig,
	ctx: UltraworkAutoContext,
	signal?: AbortSignal,
): Promise<UltraworkAutoDecision> {
	const routing = resolveSubagentRoutingConfig(config);
	if (!routing.enabled) return "none";
	if (signal?.aborted) throw new Error("Aborted");

	const refs = [routing.model, ...routing.fallbackModels];
	const parentModel = currentModelRef(ctx.model);
	if (parentModel) refs.push(parentModel);
	const seen = new Set<string>();

	for (const ref of refs) {
		const modelRef = ref?.trim();
		if (!modelRef || seen.has(modelRef)) continue;
		seen.add(modelRef);

		let resolved: Awaited<ReturnType<typeof resolveModelRef>>;
		try {
			resolved = await resolveModelRef(ctx, modelRef);
		} catch (error) {
			if (signal?.aborted || isAbortError(error)) throw error;
			continue;
		}
		if (!resolved) continue;

		try {
			const response = await completeWithModelRegistry(
				ctx.modelRegistry,
				resolved.model,
				{
					systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: buildClassifierPrompt(userText) }],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: resolved.apiKey,
					headers: resolved.headers,
					env: resolved.env,
					cacheRetention: "none",
					maxRetries: routing.maxRetries,
					maxTokens: Math.min(routing.maxTokens, 32),
					signal,
					timeoutMs: routing.timeoutMs,
				},
			);
			if (signal?.aborted || response.stopReason === "aborted") throw new Error("Aborted");
			if (response.stopReason === "error") continue;
			return parseUltraworkAutoDecision(responseText(response));
		} catch (error) {
			if (signal?.aborted || isAbortError(error)) throw error;
		}
	}
	return "none";
}

export function parseUltraworkAutoDecision(raw: string): UltraworkAutoDecision {
	const normalized = raw.trim().toLowerCase()
		.replace(/^```(?:json|text)?\s*/iu, "")
		.replace(/```$/u, "")
		.trim();

	if (normalized === "ultrawork" || normalized === "hint" || normalized === "none") return normalized;

	try {
		const parsed = JSON.parse(normalized) as unknown;
		const value = isRecord(parsed) ? parsed.decision ?? parsed.mode ?? parsed.result : parsed;
		if (typeof value === "string") return parseUltraworkAutoDecision(value);
	} catch {
		// Fall through to weak-model text extraction.
	}

	const matches = normalized.match(/\b(ultrawork|hint|none)\b/gi) ?? [];
	const unique = [...new Set(matches.map((match: string) => match.toLowerCase()))];
	return unique.length === 1 && isUltraworkDecision(unique[0]) ? unique[0] : "none";
}

function buildClassifierPrompt(userText: string): string {
	return [
		"Choose one label for this first user message.",
		"Use ultrawork for: explicit requests to delegate or split independent tracks; real UI QA requiring its dedicated agent.",
		"Use hint for: a possible named uncertainty or implementation capability gap that still needs the parent's assessment, or an unscoped request like 'Fix this bug.' Broad investigations and multi-file implementation/refactors do not by themselves justify ultrawork.",
		"Use none for: simple question, exact string/file lookup, known one-file edit, typo, formatting, command request, or casual chat.",
		"First user message:",
		`<<<${truncate(userText, 4000)}>>>`,
		"Answer with exactly one word: ultrawork, hint, or none.",
	].join("\n");
}

async function resolveModelRef(ctx: UltraworkAutoContext, modelRef: string): Promise<{
	model: Model<Api>;
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: Record<string, string>;
} | undefined> {
	const parsed = parseModelRef(modelRef);
	if (!parsed || !ctx.modelRegistry) return undefined;
	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) return undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false) return undefined;
	return { model, apiKey: auth.apiKey, headers: auth.headers, env: auth.env };
}

function parseModelRef(modelRef: string): { provider: string; modelId: string } | undefined {
	const trimmed = modelRef.trim();
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

function responseText(response: { content: Array<{ type: string; text?: string }> }): string {
	return response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function truncate(value: string, maxChars: number): string {
	const trimmed = value.trim();
	return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars).trimEnd()}…`;
}

function isUltraworkDecision(value: string): value is UltraworkAutoDecision {
	return value === "ultrawork" || value === "hint" || value === "none";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && /abort/i.test(error.name || error.message);
}
