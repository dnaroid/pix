import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { createReadToolDefinition, ModelRegistry, ModelRuntime, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check, Errors } from "typebox/value";
import { Type } from "typebox";
import { detectModelProfile, selectSuitableToolsForModel, type ModelProfile } from "../lib/tool-args.js";
import { SUBAGENT_TYPE_SELECTION_GUIDANCE } from "../async-subagents/core/agent-catalog.js";
import { assertPatchWorkspace, assertWorkspacePath } from "./workspace.js";
import { withHeadlessTodoSession, type HeadlessTodoSession } from "./session-todo.js";
import { createHeadlessSessionManager, type HeadlessSessionManager } from "./subagent-journal.js";

/** ChatGPT is an OpenAI GPT model, NOT Pi's default/unknown (Claude) profile. */
export const CHATGPT_HEADLESS_MODEL = Object.freeze({ provider: "openai", id: "gpt-6" });
const PI_BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type HeadlessModel = string | { provider: string; id: string };

/** The Pi model-tools module chooses these native names for this model family. */
export interface HeadlessInventory {
	model: HeadlessModel;
	profile: ModelProfile;
	nativeTools: string[];
	tools: HeadlessTool[];
}

export type HeadlessContent = { type: "text"; text: string } |
  { type: "image"; data: string; mimeType: string };
export type HeadlessResult = {
	content: HeadlessContent[];
	isError?: boolean;
	details?: unknown;
	structuredContent?: unknown;
};
export type HeadlessTool = {
	name: string;
	label: string;
	description: string;
	inputSchema: Record<string, unknown>;
	readOnly: boolean;
};

type RegisteredTool = {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	prepareArguments?: (args: unknown) => unknown;
	execute: (
		id: string,
		args: any,
		signal: AbortSignal,
		onUpdate: (result: unknown) => void,
		ctx: { cwd: string; hasUI: boolean },
	) => Promise<HeadlessResult>;
};

const MUTATING_TOOLS = new Set(["shell", "apply_patch", "ast_apply", "todo", "subagents"]);
type HostSession = HeadlessSessionManager;

/**
 * UI QA and image-backed tasks require confirmed vision-capable model metadata.
 * The ordinary headless host has no parent Pi session/modelRegistry; initialize
 * the SDK's real, locally configured runtime only for those spawn requests.
 * Do not start an agent session, fire Pi prompt hooks or refresh remote catalogs.
 */
export function needsHeadlessModelRegistry(name: string, args: Record<string, unknown>): boolean {
	if (name !== "subagents" || args.action !== "spawn" || !Array.isArray(args.tasks)) return false;
	return args.tasks.some((entry: unknown) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
		const task = entry as { subagentType?: unknown; imagePaths?: unknown };
		return task.subagentType === "ui-qa" || (Array.isArray(task.imagePaths) && task.imagePaths.length > 0);
	});
}

export async function createHeadlessModelRegistry(signal?: AbortSignal): Promise<ModelRegistry> {
	signal?.throwIfAborted();
	const runtime = await ModelRuntime.create({ allowModelNetwork: false, signal });
	signal?.throwIfAborted();
	return new ModelRegistry(runtime);
}

/** Replace two Pi-parent promises that do not hold for ChatGPT MCP headless. */
export function headlessSubagentsDescription(source: string): string {
	const parentFollowups = "Parent sessions receive completion/failure follow-ups, so spawn can return without polling.";
	if (!source.includes(SUBAGENT_TYPE_SELECTION_GUIDANCE) || !source.includes(parentFollowups)) {
		throw new Error("Pix subagents description changed; audit its headless guidance before publishing");
	}
	return source
		.replace(SUBAGENT_TYPE_SELECTION_GUIDANCE,
			"Headless ChatGPT MCP: every spawn task must include an explicit subagentType from subagents_catalog. " +
			"The parent Pi model registry and automatic LLM role routing are unavailable. " +
			"Use the selected role's configured model unless a model override is genuinely required.")
		.replace(parentFollowups,
			"ChatGPT MCP receives no automatic sub-agent completion follow-ups. " +
			"After spawn returns, continue independent work and call status, wait or result only when the agent outcome is needed.")
		+ " Headless spawn returns after scheduling; watchSeconds is unavailable, use a separate wait call.";
}

/** Validate before starting the detached broker: no parent-model role router exists. */
export function assertHeadlessSubagentSpawn(args: unknown): void {
	if (!args || typeof args !== "object" || Array.isArray(args)) return;
	const params = args as Record<string, unknown>;
	if (params.action !== "spawn") return;
	if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
		throw new Error("Headless subagents spawn requires a nonempty tasks array");
	}
	for (const [index, task] of params.tasks.entries()) {
		if (!task || typeof task !== "object" || Array.isArray(task)
			|| typeof task.subagentType !== "string" || !task.subagentType.trim()) {
			throw new Error("Headless subagents spawn requires tasks[" + index
				+ "].subagentType from subagents_catalog; automatic role routing is unavailable");
		}
	}
}

const MODULES = [
	() => import("../ast-grep/index.js"),
	() => import("../project-search/index.js"),
	() => import("../project-tasks/index.js"),
] as const;

/** Minimal Pi host, for registration only. No session, model, commands, hooks or UI. */
async function loadTools(root: string, model: HeadlessModel, sessionKey?: string): Promise<{
	registered: Map<string, RegisteredTool>;
	active: string[];
	sessionManager: HostSession;
}> {
	const tools = new Map<string, RegisteredTool>();
	const handlers = new Map<string, Array<(...args: any[]) => unknown>>();
	let active: string[] = [];
	const host = {
		events: { emit(_event: string, _value: unknown) {} },
		registerTool(tool: RegisteredTool) {
			if (tools.has(tool.name)) throw new Error(`Duplicate headless tool: ${tool.name}`);
			tools.set(tool.name, tool);
			active.push(tool.name);
		},
		// Extension-specific commands and session-start handlers have no meaning in headless mode.
		registerCommand() {},
		on(event: string, handler: (...args: any[]) => unknown) {
			const entries = handlers.get(event) ?? [];
			entries.push(handler);
			handlers.set(event, entries);
			return () => { const index = entries.indexOf(handler); if (index >= 0) entries.splice(index, 1); };
		},
		getActiveTools() { return [...active]; },
		setActiveTools(names: string[]) { active = [...names]; },
		async exec(command: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeout?: number }) {
			if (command !== "ast-grep") throw new Error(`Executable not allowed in headless mode: ${command}`);
			return new Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>((resolve, reject) => {
				execFile(command, args, {
					cwd: options.cwd,
					signal: options.signal,
					timeout: Math.min(options.timeout ?? 120_000, 120_000),
					maxBuffer: 12 * 1024 * 1024,
				}, (error, stdout, stderr) => {
					if (error && typeof (error as NodeJS.ErrnoException).code === "string") return reject(error);
					resolve({ stdout, stderr, code: typeof (error as any)?.code === "number" ? (error as any).code : error ? -1 : 0, killed: Boolean(error && (error as any).killed) });
				});
			});
		},
	};
	for (const load of MODULES) (await load()).default(host as unknown as ExtensionAPI);
	// Register the *original* Pix todo and async-subagents tools, without their
	// Pi-session lifecycle hooks (which require an interactive parent agent).
	const { registerTodoTool } = await import("../todo/todo.js");
	registerTodoTool(host as unknown as ExtensionAPI);
	const { registerSubagentsTool } = await import("../async-subagents/tools/subagents.js");
	registerSubagentsTool(host as unknown as ExtensionAPI, new Map(), () => {});
	const { loadSubagentConfig, filterSubagentConfigForContext } = await import("../async-subagents/core/config.js");
	host.registerTool({
		name: "subagents_catalog",
		label: "Available project agents",
		description: "List the effective Pix async-subagent roles, including project .pi/agents/*.md definitions. Choose subagentType from this catalog before subagents(action=spawn).",
		parameters: Type.Object({}) as unknown as Record<string, unknown>,
		async execute(_id, _args, _signal, _update, ctx) {
			const reference = typeof model === "string" ? model : `${model.provider}/${model.id}`;
			const config = filterSubagentConfigForContext(loadSubagentConfig(ctx.cwd), { cwd: ctx.cwd, parentModelRef: reference });
			const roles = Object.entries(config.types).sort(([a], [b]) => a.localeCompare(b)).map(([name, profile]) => ({
				name, description: profile.description ?? "", projectAgent: Boolean(config.projectAgentMetadata?.[name]),
				...(config.projectAgentMetadata?.[name]?.replacesBuiltin ? { replacesBuiltin: true } : {}),
			}));
			return { content: [{ type: "text" as const, text: JSON.stringify({ project: ctx.cwd, roles }) }], details: { roles } };
		},
	});
	// Use Pix's actual Codex/Claude alias registration and session_start selector.
	// Do not fire other extensions' session hooks: they can start watchers,
	// background indexing or LLM work, which is not headless execution.
	host.registerTool(createReadToolDefinition(root) as unknown as RegisteredTool);
	const existing = handlers.get("session_start")?.length ?? 0;
	(await import("../model-tools/index.js")).default(host as unknown as ExtensionAPI);
	// Sub-agent records persist to a per-session journal so status/result work across CLI processes.
	const sessionManager: HostSession = createHeadlessSessionManager(root, sessionKey);
	const normalizedModel = typeof model === "string"
		? { provider: model.split("/")[0] ?? "openai", id: model.split("/").slice(1).join("/") || model }
		: model;
	const ctx = { cwd: root, sessionManager, model: { ...normalizedModel, input: ["text", "image"] }, hasUI: false };
	for (const handler of (handlers.get("session_start") ?? []).slice(existing)) await handler({}, ctx);
	return { registered: tools, active, sessionManager };
}

async function constrainArgs(name: string, args: Record<string, unknown>, root: string): Promise<void> {
	if (name === "project_search" && args.projectPath !== undefined) {
		throw new Error("project_search.projectPath is disabled in headless mode; the host owns cwd");
	}
	if (name === "read") {
		await assertWorkspacePath(root, args.path as string);
		return;
	}
	if (name === "apply_patch") {
		await assertPatchWorkspace(root, args.input as string);
		return;
	}
	if (name === "shell") {
		if (typeof (args.cwd ?? args.workdir) === "string") await assertWorkspacePath(root, (args.cwd ?? args.workdir) as string);
		return;
	}
	if (name !== "ast_grep" && name !== "ast_apply") return;
	if (args.follow === true) throw new Error("ast-grep --follow is disabled in headless mode");
	const paths = [...((args.paths as string[] | undefined) ?? ["."])];
	for (const param of ["config", "rule"] as const) {
		if (typeof args[param] === "string") paths.push(args[param]);
	}
	for (const item of paths) {
		await assertWorkspacePath(root, item);
	}
}

export interface HeadlessApiOptions {
	cwd: string;
	/** Disabled by default. Host must separately authorize every mutating tool call. */
	readOnly?: boolean;
	/** The calling model, supplied by the trusted host, never tool-call arguments. */
	model?: HeadlessModel;
	/** Project task mutations require a separate explicit approval policy. */
	projectTaskWrites?: boolean;
	/** Required for todo calls; unique to the ChatGPT chat and selected project. */
	todoSession?: HeadlessTodoSession;
}

export interface HeadlessToolApi {
	listTools(): HeadlessTool[];
	inventory(): HeadlessInventory;
	execute(name: string, args: unknown, signal?: AbortSignal): Promise<HeadlessResult>;
}

/**
 * Direct, model-free API to the SAME registered Pi tools, without starting a Pi session.
 * Only modules audited for standalone execution are loaded. Caller controls workspace
 * selection and write authorization; no other project can be selected through arguments.
 */
export async function createHeadlessToolApi(options: HeadlessApiOptions): Promise<HeadlessToolApi> {
	const root = await realpath(options.cwd);
	if (!(await stat(root)).isDirectory()) throw new Error("Headless cwd must be a directory");
	const model = options.model ?? CHATGPT_HEADLESS_MODEL;
	if (typeof model !== "string" &&
		(!model || typeof model.provider !== "string" || typeof model.id !== "string"
			|| !model.provider.trim() || !model.id.trim())) {
		throw new Error("Headless model must have a nonempty provider and id");
	}
	const profile = detectModelProfile(model);
	const nativeTools = selectSuitableToolsForModel(model, PI_BUILTINS);
	const readOnly = options.readOnly !== false;
	const taskWrites = !readOnly && options.projectTaskWrites === true;
	const { registered, active, sessionManager } = await loadTools(root, model, options.todoSession?.key);
	const visible = [...registered.values()].filter((tool) =>
		active.includes(tool.name) && !(readOnly && MUTATING_TOOLS.has(tool.name) && tool.name !== "todo"));
	const listTools = (): HeadlessTool[] => visible.map((tool) => {
		const schema = structuredClone(tool.parameters);
		if (tool.name === "project_tasks") {
			const op = (schema.properties as Record<string, any>).op;
			op.enum = taskWrites ? ["list", "get", "update", "create"] : ["list", "get"];
		}
		if (readOnly && tool.name === "todo") {
			(schema.properties as Record<string, any>).action.enum = ["list", "get", "export"];
		}
		if (tool.name === "subagents") {
			// Spawn returns promptly while a detached broker owns the original Pix
			// process handles. A watch window is a separate `action=wait` call.
			delete (schema.properties as Record<string, unknown>).watchSeconds;
			const itemSchema = (schema.properties as Record<string, any>).tasks?.items;
			if (!itemSchema?.properties?.subagentType) {
				throw new Error("Pix subagents task schema changed; review headless subagentType requirement");
			}
			itemSchema.required = [...new Set([...(itemSchema.required ?? []), "subagentType"])];
			itemSchema.properties.subagentType.description =
				"Required for headless spawn: exact subagentType from subagents_catalog for the selected project. " +
				"Automatic LLM role routing is unavailable.";
		}
		return { name: tool.name, label: tool.label ?? tool.name,
			description: !taskWrites && tool.name === "project_tasks"
				? "Read saved Pix project tasks. Only list/get are available until the host enables authorized task writes."
				: tool.name === "subagents"
					? headlessSubagentsDescription(tool.description)
					: tool.description,
			inputSchema: schema,
			readOnly: (readOnly && tool.name === "todo") ||
				(!MUTATING_TOOLS.has(tool.name) && (tool.name !== "project_tasks" || !taskWrites)) };
	});
	return {
		listTools,
		inventory: () => ({ model, profile, nativeTools: [...nativeTools], tools: listTools() }),
		async execute(name, rawArgs, signal = new AbortController().signal) {
			const tool = registered.get(name);
			if (!tool || !visible.includes(tool)) throw new Error(`Headless tool not available: ${name}`);
			if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) throw new Error("Tool arguments must be an object");
			const args = tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs;
			if (name === "project_tasks" && (args as Record<string, unknown>)?.op === "run") {
				throw new Error("project_tasks run requires Pix Desktop");
			}
			if (!taskWrites && name === "project_tasks" && args && typeof args === "object"
				&& !Array.isArray(args) && !["list", "get"].includes(String((args as Record<string, unknown>).op))) {
				throw new Error("Headless project_tasks is read-only; only list/get are allowed");
			}
			if (!args || typeof args !== "object" || Array.isArray(args) || !Check(tool.parameters, args)) {
				const issue = [...Errors(tool.parameters, args)].at(0);
				throw new Error(`Invalid ${name} arguments${issue ? `: ${issue.message}` : ""}`);
			}
			const params = args as Record<string, unknown>;
			if (name === "subagents") assertHeadlessSubagentSpawn(params);
			if (readOnly && name === "todo" && !["list", "get", "export"].includes(String(params.action))) {
				throw new Error("Headless todo is read-only; only list/get/export are available");
			}
			await constrainArgs(name, params, root);
			signal.throwIfAborted();
			const modelRegistry = needsHeadlessModelRegistry(name, params)
				? await createHeadlessModelRegistry(signal) : undefined;
			const normalizedModel = typeof model === "string"
				? { provider: model.split("/")[0] ?? "openai", id: model.split("/").slice(1).join("/") || model }
				: model;
			const invoke = () => tool.execute("headless", params, signal, () => {}, {
				cwd: root, hasUI: false, sessionManager,
				...(modelRegistry ? { modelRegistry } : {}),
				model: { ...normalizedModel, input: ["text", "image"] },
			} as any);
			if (name === "todo") {
				if (!options.todoSession) throw new Error("Pix todo requires a stable ChatGPT session key");
				return withHeadlessTodoSession(options.todoSession, signal, invoke);
			}
			return invoke();
		},
	};
}
