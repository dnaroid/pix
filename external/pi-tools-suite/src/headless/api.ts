import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check, Errors } from "typebox/value";
import { detectModelProfile, selectSuitableToolsForModel, type ModelProfile } from "../lib/tool-args.js";

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

export type HeadlessContent = { type: "text"; text: string };
export type HeadlessResult = {
	content: HeadlessContent[];
	isError?: boolean;
	details?: unknown;
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

const MODULES = [
	() => import("../ast-grep/index.js"),
	() => import("../project-search/index.js"),
	() => import("../project-tasks/index.js"),
] as const;

/** Minimal Pi host, for registration only. No session, model, commands, hooks or UI. */
async function loadTools(): Promise<Map<string, RegisteredTool>> {
	const tools = new Map<string, RegisteredTool>();
	const host = {
		registerTool(tool: RegisteredTool) {
			if (tools.has(tool.name)) throw new Error(`Duplicate headless tool: ${tool.name}`);
			tools.set(tool.name, tool);
		},
		// Extension-specific commands and session-start handlers have no meaning in headless mode.
		registerCommand() {},
		on() { return () => {}; },
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
	return tools;
}

function isWithin(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function constrainArgs(name: string, args: Record<string, unknown>, root: string): Promise<void> {
	if (name === "project_search" && args.projectPath !== undefined) {
		throw new Error("project_search.projectPath is disabled in headless mode; the host owns cwd");
	}
	if (name !== "ast_grep" && name !== "ast_apply") return;
	if (args.follow === true) throw new Error("ast-grep --follow is disabled in headless mode");
	const paths = [...((args.paths as string[] | undefined) ?? ["."])];
	for (const param of ["config", "rule"] as const) {
		if (typeof args[param] === "string") paths.push(args[param]);
	}
	for (const item of paths) {
		const resolved = await realpath(path.resolve(root, item)).catch(() => {
			throw new Error(`Headless path does not exist: ${item}`);
		});
		if (!isWithin(root, resolved)) throw new Error(`Headless path escapes selected project: ${item}`);
	}
}

export interface HeadlessApiOptions {
	cwd: string;
	/** Disabled by default. Host must separately authorize every mutating tool call. */
	readOnly?: boolean;
	/** The calling model, supplied by the trusted host, never tool-call arguments. */
	model?: HeadlessModel;
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
	const registered = await loadTools();
	const visible = [...registered.values()].filter((tool) => !readOnly || tool.name !== "ast_apply");
	const listTools = (): HeadlessTool[] => visible.map((tool) => {
		const schema = structuredClone(tool.parameters);
		if (readOnly && tool.name === "project_tasks") {
			const op = (schema.properties as Record<string, any>).op;
			op.enum = ["list", "get"];
		}
		return { name: tool.name, label: tool.label ?? tool.name,
			description: readOnly && tool.name === "project_tasks"
				? "Read saved Pix project tasks. Only list/get are available in headless read-only mode."
				: tool.description,
			inputSchema: schema, readOnly: readOnly || tool.name !== "ast_apply" && tool.name !== "project_tasks" };
	});
	return {
		listTools,
		inventory: () => ({ model, profile, nativeTools: [...nativeTools], tools: listTools() }),
		async execute(name, rawArgs, signal = new AbortController().signal) {
			const tool = registered.get(name);
			if (!tool || (readOnly && name === "ast_apply")) throw new Error(`Headless tool not available: ${name}`);
			if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) throw new Error("Tool arguments must be an object");
			const args = tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs;
			if (!args || typeof args !== "object" || Array.isArray(args) || !Check(tool.parameters, args)) {
				const issue = [...Errors(tool.parameters, args)].at(0);
				throw new Error(`Invalid ${name} arguments${issue ? `: ${issue.message}` : ""}`);
			}
			const params = args as Record<string, unknown>;
			if (readOnly && name === "project_tasks" && !["list", "get"].includes(String(params.op))) {
				throw new Error("Headless project_tasks is read-only; only list/get are allowed");
			}
			await constrainArgs(name, params, root);
			signal.throwIfAborted();
			return tool.execute("headless", params, signal, () => {}, { cwd: root, hasUI: false });
		},
	};
}
