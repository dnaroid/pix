import { complete } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
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
	modelRegistry?: {
		find(provider: string, modelId: string): Model<Api> | undefined;
		getApiKeyAndHeaders(model: Model<Api>): Promise<
			| { ok?: true; apiKey?: string; headers?: Record<string, string> }
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

const ROUTER_SYSTEM_PROMPT = [
	"You route Pi async sub-agent tasks to the best configured subagentType.",
	"Choose exactly one allowed type for each task. Use the allowed type descriptions as the source of truth.",
	"Prefer the most specific matching type over generic quick/deep. Use frontend for UI/UX implementation or visual frontend polish. For pure image inspection, use the lookup tool rather than subagents.",
	"Return only strict JSON with this shape: {\"routes\":[{\"id\":\"task-id\",\"subagentType\":\"type\"}]}",
	"Do not include markdown, comments, explanations, or unknown types.",
].join("\n");

export async function routeSubagentTasks(
	tasks: AgentTask[],
	config: SubagentConfig,
	ctx: SubagentRoutingContext,
	signal?: AbortSignal,
): Promise<RoutedSubagentTasks> {
	const fallbackTasks = () => tasks.map((task) => withFallbackType(task, config));
	const autoTasks = tasks.filter((task) => !hasText(task.subagentType));
	if (autoTasks.length === 0) return { tasks, usedLlm: false, routes: {}, warnings: [] };

	const routing = resolveSubagentRoutingConfig(config);
	if (!routing.enabled) {
		return { tasks: fallbackTasks(), usedLlm: false, routes: {}, warnings: ["LLM sub-agent routing is disabled; used defaultType fallback."] };
	}
	if (signal?.aborted) throw new Error("Aborted");

	try {
		const candidates = await resolveRoutingModels(ctx, routing);
		if (candidates.length === 0) {
			const warning = `LLM sub-agent routing model unavailable (${routing.model}); used defaultType fallback.`;
			notifyRoutingWarning(ctx, routing, warning);
			return { tasks: fallbackTasks(), usedLlm: false, routes: {}, warnings: [warning] };
		}

		const prompt = buildRoutingPrompt(autoTasks, config, routing);
		const failures: string[] = [];
		let response: RoutingResponse | undefined;
		for (const candidate of candidates) {
			if (signal?.aborted) throw new Error("Aborted");
			try {
				response = await complete(
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
						cacheRetention: "none",
						maxRetries: routing.maxRetries,
						maxTokens: routing.maxTokens,
						signal,
						timeoutMs: routing.timeoutMs,
					},
				);
				break;
			} catch (error) {
				if (signal?.aborted || isAbortError(error)) throw error;
				failures.push(`${currentModelRef(candidate.model) ?? "(unknown)"}: ${errorMessage(error)}`);
			}
		}

		if (!response) {
			const warning = `LLM sub-agent routing failed (${failures.join("; ")}); used defaultType fallback.`;
			notifyRoutingWarning(ctx, routing, warning);
			return { tasks: fallbackTasks(), usedLlm: false, routes: {}, warnings: [warning] };
		}

		const routes = parseRoutingResponse(responseText(response), config, autoTasks);
		const warnings = Object.keys(routes).length === autoTasks.length
			? []
			: [`LLM sub-agent routing returned ${Object.keys(routes).length}/${autoTasks.length} valid route(s); missing tasks used defaultType fallback.`];
		for (const warning of warnings) notifyRoutingWarning(ctx, routing, warning);
		return {
			usedLlm: true,
			routes,
			warnings,
			tasks: tasks.map((task) => applyRoute(task, config, routes)),
		};
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) throw error;
		const warning = `LLM sub-agent routing failed (${errorMessage(error)}); used defaultType fallback.`;
		notifyRoutingWarning(ctx, routing, warning);
		return { tasks: fallbackTasks(), usedLlm: false, routes: {}, warnings: [warning] };
	}
}

function applyRoute(task: AgentTask, config: SubagentConfig, routes: Record<string, string>): AgentTask {
	if (hasText(task.subagentType)) return task;
	const fallback = withFallbackType(task, config);
	return routes[task.id] ? { ...fallback, subagentType: routes[task.id] } : fallback;
}

function withFallbackType(task: AgentTask, config: SubagentConfig): AgentTask {
	if (hasText(task.subagentType)) return task;
	const fallback = defaultSubagentType(config);
	return fallback ? { ...task, subagentType: fallback } : task;
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
		`Default fallback if genuinely ambiguous: ${defaultSubagentType(config) ?? "none"}`,
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
	headers?: Record<string, string>;
}

type RoutingResponse = Awaited<ReturnType<typeof complete>>;

async function resolveModelRef(ctx: SubagentRoutingContext, modelRef: string): Promise<{
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
} | undefined> {
	const parsed = parseModelRef(modelRef);
	if (!parsed || !ctx.modelRegistry) return undefined;
	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) return undefined;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false) return undefined;
	return { model, apiKey: auth.apiKey, headers: auth.headers };
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
	const routes: Record<string, string> = {};
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
	return error instanceof Error && /abort/i.test(error.name || error.message);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
