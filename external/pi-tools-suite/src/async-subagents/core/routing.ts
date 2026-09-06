import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { completeWithModelRegistry, type ModelCompletionRegistry } from "../../model-completion.js";
import type { AgentTask } from "./types.js";
import {
	currentModelRef,
	defaultSubagentType,
	resolveSubagentRoutingConfig,
	type ResolvedSubagentRoutingConfig,
	type SubagentConfig,
} from "./config.js";

export interface SubagentRoutingContext {
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

export interface RoutedSubagentTasks {
	tasks: AgentTask[];
	usedLlm: boolean;
	routes: Record<string, string>;
	warnings: string[];
}

/** A recoverable selection error: the parent must correct the batch before spawn. */
export class SubagentRoutingError extends Error {
	constructor(reason: string, readonly taskIds: string[], readonly allowedTypes: string[]) {
		super([
			reason,
			`Tasks requiring a valid role: ${taskIds.join(", ")}.`,
			"Set an explicit valid subagentType for these tasks and retry; defaultType is not an error fallback.",
			`Available types: ${allowedTypes.join(", ") || "(none configured)"}.`,
		].join("\n"));
		this.name = "SubagentRoutingError";
	}
}

const ROUTER_SYSTEM_PROMPT = [
	"You route Pi async sub-agent tasks to the best configured subagentType.",
	"Choose exactly one allowed type for each task. Use the allowed type descriptions as the source of truth.",
	"Prefer a matching project specialist. Otherwise use research for reading/review and evidence, implement for code/docs/tests/UI changes, verify for running checks, browser-qa for real-browser testing. Oracle is a deliberate strong second opinion, not the default for difficult work.",
	"Return only strict JSON with this shape: {\"routes\":[{\"id\":\"task-id\",\"subagentType\":\"type\"}]}",
	"Do not include markdown, comments, explanations, or unknown types.",
].join("\n");

export async function routeSubagentTasks(
	tasks: AgentTask[],
	config: SubagentConfig,
	ctx: SubagentRoutingContext,
	signal?: AbortSignal,
): Promise<RoutedSubagentTasks> {
	if (signal?.aborted) throw new Error("Aborted");
	// Validate even the fast path: an explicit typo must not bypass profiles.
	tasks = tasks.map((task) => hasText(task.subagentType) && task.subagentType !== task.subagentType.trim()
		? { ...task, subagentType: task.subagentType.trim() }
		: task);
	const invalidTasks = tasks.filter((task) => hasText(task.subagentType)
		&& !Object.prototype.hasOwnProperty.call(config.types, task.subagentType));
	if (invalidTasks.length > 0) {
		throw routingError(`Unknown subagentType: ${invalidTasks.map((task) => `${task.id}=${JSON.stringify(task.subagentType)}`).join(", ")}.`, invalidTasks, config);
	}
	const autoTasks = tasks.filter((task) => !hasText(task.subagentType));
	if (autoTasks.length === 0) return { tasks, usedLlm: false, routes: {}, warnings: [] };

	const routing = resolveSubagentRoutingConfig(config);
	if (!routing.enabled) {
		throw routingError("LLM sub-agent routing is disabled.", autoTasks, config);
	}
	if (Object.keys(config.types).length === 0) throw routingError("No sub-agent types are configured.", autoTasks, config);

	try {
		const candidates = await resolveRoutingModels(ctx, routing);
		if (candidates.length === 0) {
			throw routingError(`LLM sub-agent routing model unavailable (${routing.model}).`, autoTasks, config);
		}

		const prompt = buildRoutingPrompt(autoTasks, config, routing);
		const failures: string[] = [];
		for (const candidate of candidates) {
			if (signal?.aborted) throw new Error("Aborted");
			try {
				const response = await completeWithModelRegistry(
					ctx.modelRegistry,
					candidate.model,
					{
						systemPrompt: ROUTER_SYSTEM_PROMPT,
						messages: [
							{
								role: "user" as const,
								content: [{ type: "text" as const, text: prompt }],
								timestamp: Date.now(),
							},
						],
					},
					{
						apiKey: candidate.apiKey,
						headers: candidate.headers,
						env: candidate.env,
						cacheRetention: "none",
						maxRetries: routing.maxRetries,
						maxTokens: routing.maxTokens,
						signal,
						timeoutMs: routing.timeoutMs,
					},
				);
				if (signal?.aborted || response.stopReason === "aborted") throw new Error("Aborted");
				if (response.stopReason === "error") throw new Error(response.errorMessage || "Router provider returned an error.");
				const routes = parseRoutingResponse(responseText(response), config, autoTasks);
				const missingTasks = autoTasks.filter((task) => !Object.prototype.hasOwnProperty.call(routes, task.id));
				if (missingTasks.length > 0) {
					throw new Error(`Returned ${Object.keys(routes).length}/${autoTasks.length} valid route(s); missing: ${missingTasks.map((task) => task.id).join(", ")}.`);
				}
				return {
					usedLlm: true,
					routes,
					warnings: [],
					tasks: tasks.map((task) => hasText(task.subagentType) ? task : { ...task, subagentType: routes[task.id] }),
				};
			} catch (error) {
				if (signal?.aborted || isAbortError(error)) throw error;
				failures.push(`${currentModelRef(candidate.model) ?? "(unknown)"}: ${errorMessage(error)}`);
			}
		}

		throw routingError(`LLM sub-agent routing failed (${failures.join("; ")}).`, autoTasks, config);
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) throw error;
		const failure = error instanceof SubagentRoutingError
			? error
			: routingError(`LLM sub-agent routing failed (${errorMessage(error)}).`, autoTasks, config);
		notifyRoutingWarning(ctx, routing, failure.message);
		throw failure;
	}
}

function routingError(reason: string, tasks: AgentTask[], config: SubagentConfig): SubagentRoutingError {
	return new SubagentRoutingError(reason, tasks.map((task) => task.id), Object.keys(config.types).sort());
}

function buildRoutingPrompt(tasks: AgentTask[], config: SubagentConfig, routing: ResolvedSubagentRoutingConfig): string {
	return [
		"Choose subagentType for each task.",
		"",
		"Allowed types (type: description):",
		...Object.entries(config.types).map(([name, profile]) => {
			return `- ${name}: ${profile.description ?? "No description; use only when the task explicitly names this type."}`;
		}),
		"",
		`Preferred type only for genuinely ambiguous tasks: ${defaultSubagentType(config) ?? "none"}`,
		"",
		"Tasks:",
		JSON.stringify(tasks.map((task) => ({
			id: task.id,
			task: truncate(task.task, routing.maxTaskChars),
			scope: truncate(task.scope, routing.maxTaskChars),
			parentObjective: truncate(task.parentObjective, routing.maxTaskChars),
			hasImages: Array.isArray(task.imagePaths) && task.imagePaths.length > 0,
			focus: truncate(task.focus, routing.maxTaskChars),
		})), null, 2),
	].join("\n");
}

async function resolveRoutingModels(
	ctx: SubagentRoutingContext,
	routing: ResolvedSubagentRoutingConfig,
): Promise<RoutingCandidate[]> {
	const candidates: RoutingCandidate[] = [];
	const seen = new Set<string>();
	const refs = [routing.model, ...routing.fallbackModels];
	const parentModel = currentModelRef(ctx.model);
	if (parentModel) refs.push(parentModel);
	for (const ref of refs) {
		const trimmed = ref?.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		const resolved = await resolveModelRef(ctx, trimmed);
		if (resolved) candidates.push(resolved);
	}
	return candidates;
}

interface RoutingCandidate {
	model: Model<Api>;
	apiKey?: string;
	headers?: ProviderHeaders;
	env?: Record<string, string>;
}

async function resolveModelRef(ctx: SubagentRoutingContext, modelRef: string): Promise<{
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

function parseRoutingResponse(raw: string, config: SubagentConfig, tasks: AgentTask[]): Record<string, string> {
	const parsed = parseJsonObject(raw);
	const allowedTypes = new Map(Object.keys(config.types).map((name) => [name.toLowerCase(), name]));
	const taskIds = new Set(tasks.map((task) => task.id));
	const routes: Record<string, string> = Object.create(null);
	if (Array.isArray(parsed)) collectRouteArray(parsed, taskIds, allowedTypes, routes);
	else if (typeof parsed === "string" && tasks.length === 1) addRoute(routes, taskIds, allowedTypes, tasks[0]!.id, parsed);
	else if (isRecord(parsed)) {
		if (Array.isArray(parsed.routes)) collectRouteArray(parsed.routes, taskIds, allowedTypes, routes);
		else {
			for (const [id, value] of Object.entries(parsed)) {
				if (typeof value === "string") addRoute(routes, taskIds, allowedTypes, id, value);
				else if (isRecord(value)) addRoute(routes, taskIds, allowedTypes, id, value.subagentType ?? value.type);
			}
		}
	}
	if (Object.keys(routes).length === 0 && tasks.length === 1) addRoute(routes, taskIds, allowedTypes, tasks[0]!.id, raw.trim());
	return routes;
}

function collectRouteArray(items: unknown[], taskIds: Set<string>, allowedTypes: Map<string, string>, routes: Record<string, string>): void {
	for (const item of items) {
		if (!isRecord(item)) continue;
		addRoute(routes, taskIds, allowedTypes, item.id ?? item.taskId ?? item.agentId, item.subagentType ?? item.type);
	}
}

function addRoute(routes: Record<string, string>, taskIds: Set<string>, allowedTypes: Map<string, string>, rawId: unknown, rawType: unknown): void {
	if (typeof rawId !== "string" || typeof rawType !== "string") return;
	const id = rawId.trim();
	if (!taskIds.has(id)) return;
	const type = allowedTypes.get(rawType.trim().toLowerCase());
	if (type) routes[id] = type;
}

function parseJsonObject(raw: string): unknown {
	const cleaned = raw.trim()
		.replace(/^```(?:json)?\s*/iu, "")
		.replace(/```$/u, "")
		.trim();
	try {
		return JSON.parse(cleaned) as unknown;
	} catch {
		const match = /(?:\[[\s\S]*\]|\{[\s\S]*\})/.exec(cleaned);
		if (!match) return undefined;
		try {
			return JSON.parse(match[0]) as unknown;
		} catch {
			return undefined;
		}
	}
}

function responseText(response: { content: Array<{ type: string; text?: string }> }): string {
	return response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function notifyRoutingWarning(ctx: SubagentRoutingContext, routing: ResolvedSubagentRoutingConfig, message: string): void {
	if (!routing.debug || !ctx.hasUI) return;
	ctx.ui?.notify?.(message, "warning");
}

function truncate(value: unknown, maxChars: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars).trimEnd()}…`;
}

function hasText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (/abort/i.test(error.name) || /^aborted$/i.test(error.message));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
