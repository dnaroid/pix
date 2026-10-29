import { join } from "node:path";
import { delimiter } from "node:path";
import { getAgentDir, getShellConfig, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { PROJECT_ARTIFACTS_DIR } from "../artifact-paths.js";
import { BackgroundShellManager, type BackgroundJobSnapshot } from "./manager.js";

const MANAGER_KEY = Symbol.for("pi-tools-suite.background-shell.manager");
const STARTUP_WINDOW_MS = 1500;
const STARTUP_OUTPUT_BYTES = 4 * 1024;

const TOOLS_KEY = Symbol.for("pi-tools-suite.background-shell.tools");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BackgroundToolDefinition = ToolDefinition<any, any, any>;
export interface BackgroundShellTools { output: BackgroundToolDefinition; kill: BackgroundToolDefinition }

type GlobalWithManager = typeof globalThis & { [MANAGER_KEY]?: BackgroundShellManager; [TOOLS_KEY]?: BackgroundShellTools };

/** Set by the background-shell module; model-tools aliases (Bash run_in_background, BashOutput, KillShell) require it. */
export function registerBackgroundShellTools(tools: BackgroundShellTools | undefined): void {
	(globalThis as GlobalWithManager)[TOOLS_KEY] = tools;
}

export function backgroundShellTools(): BackgroundShellTools | undefined {
	return (globalThis as GlobalWithManager)[TOOLS_KEY];
}

export function isBackgroundShellAvailable(): boolean {
	return backgroundShellTools() !== undefined && BackgroundShellManager.supported();
}

export function backgroundArtifactsRoot(cwd: string): string {
	return join(cwd, PROJECT_ARTIFACTS_DIR, "background-shell");
}

/** One manager per host process; jobs are keyed by session id inside it. */
export function backgroundShellManager(): BackgroundShellManager {
	const global = globalThis as GlobalWithManager;
	global[MANAGER_KEY] ??= new BackgroundShellManager({ artifactsRoot: backgroundArtifactsRoot });
	return global[MANAGER_KEY];
}

/** Test seam: replace (or clear) the process-wide manager. */
export function setBackgroundShellManager(manager: BackgroundShellManager | undefined): void {
	const global = globalThis as GlobalWithManager;
	global[MANAGER_KEY]?.dispose();
	global[MANAGER_KEY] = manager;
}

export function sessionKeyOf(ctx: Pick<ExtensionContext, "sessionManager">): string {
	return ctx.sessionManager.getSessionId();
}

let signalHooksInstalled = false;

/**
 * Kill every live job group synchronously when the host exits or receives a
 * termination signal. The signal handler re-raises the signal when no other
 * listener owns it, so default termination semantics are preserved.
 */
export function installHostExitHooks(manager: BackgroundShellManager): void {
	manager.installExitHook();
	if (signalHooksInstalled || process.platform === "win32") return;
	signalHooksInstalled = true;
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		const handler = () => {
			backgroundShellManager().killAllSync();
			process.off(signal, handler);
			if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
		};
		process.on(signal, handler);
	}
}

/** Same environment as the synchronous bash tool: Pi bin dir on PATH plus PI_* session metadata. */
export function backgroundShellEnv(ctx: ExtensionContext, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const binDir = join(getAgentDir(), "bin");
	const pathKey = Object.keys(base).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const current = base[pathKey] ?? "";
	const env: NodeJS.ProcessEnv = {
		...base,
		[pathKey]: current.split(delimiter).includes(binDir) ? current : [binDir, current].filter(Boolean).join(delimiter),
	};
	for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
	env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
	const sessionFile = ctx.sessionManager.getSessionFile();
	if (sessionFile) env.PI_SESSION_FILE = sessionFile;
	if (ctx.model) {
		env.PI_PROVIDER = ctx.model.provider;
		env.PI_MODEL = ctx.model.id;
	}
	const thinking = (ctx as { thinkingLevel?: string }).thinkingLevel;
	if (thinking) env.PI_REASONING_LEVEL = thinking;
	return env;
}

const NETWORK_BIND_PATTERN = /(?:^|[\s=:'"])0\.0\.0\.0(?:$|[\s:'"])|--host(?:=|\s+)(?:0\.0\.0\.0|::|\*)\b|(?:^|\s)(?:-H|--bind|-b)\s+(?:0\.0\.0\.0|::)\b|\[::\]/;

/** Heuristic: the command appears to listen on all interfaces (reachable from the network). */
export function bindsAllInterfaces(command: string): boolean {
	return NETWORK_BIND_PATTERN.test(command);
}

export const NETWORK_WARNING = "Warning: this command appears to bind to all network interfaces (0.0.0.0/::), so it may be reachable from other machines on the network. Prefer 127.0.0.1 unless remote access is required.";

export interface StartBackgroundRequest {
	readonly command: string;
	/** Already-validated working directory (see /shell-workdir grants). */
	readonly cwd?: string;
	readonly description?: string;
	readonly maxRuntimeSeconds?: number;
}

export interface BackgroundStartResult {
	content: Array<{ type: "text"; text: string }>;
	details: { backgroundJob: BackgroundJobSnapshot; networkWarning?: boolean };
}

export function formatJobLine(job: BackgroundJobSnapshot): string {
	const state = job.status === "exited" ? `exited(${job.exitCode ?? job.signal ?? "?"})`
		: job.status === "killed" ? `killed${job.signal ? `(${job.signal})` : ""}`
			: job.status === "failed" ? `failed${job.error ? `: ${job.error}` : ""}` : job.status;
	return `${job.id} ${state} pid=${job.pid ?? "-"} ${job.description ? `${job.description} — ` : ""}${job.command}`;
}

/** Start a background job for a model tool call and return after a short startup window. */
export async function startBackgroundJob(
	ctx: ExtensionContext,
	request: StartBackgroundRequest,
	manager: BackgroundShellManager = backgroundShellManager(),
	startupWindowMs: number = STARTUP_WINDOW_MS,
): Promise<BackgroundStartResult> {
	if (!BackgroundShellManager.supported()) throw new Error("run_in_background is not supported on Windows");
	const command = request.command.trim();
	if (!command) throw new Error("Missing shell command");
	const shell = getShellConfig();
	installHostExitHooks(manager);
	const sessionKey = sessionKeyOf(ctx);
	const job = manager.start({
		sessionKey,
		command,
		cwd: request.cwd ?? ctx.cwd,
		projectCwd: ctx.cwd,
		env: backgroundShellEnv(ctx),
		shell: shell.shell,
		shellArgs: shell.args,
		...(request.description ? { description: request.description } : {}),
		...(request.maxRuntimeSeconds && request.maxRuntimeSeconds > 0 ? { maxRuntimeMs: Math.round(request.maxRuntimeSeconds * 1000) } : {}),
	});
	const settled = job.status === "failed" ? job : await manager.waitFor(sessionKey, job.id, startupWindowMs) ?? job;
	const early = manager.read(sessionKey, job.id, { maxBytes: STARTUP_OUTPUT_BYTES });
	const network = bindsAllInterfaces(command);
	const lines = [
		`Started background job ${settled.id} (pid ${settled.pid ?? "-"}). Status: ${formatJobLine(settled).split(" ")[1]}.`,
		`Log: ${settled.logPath}`,
		"Read new output with shell_output(job_id); stop it with shell_kill(job_id). It keeps running after this turn and stops when the session ends.",
		...(network ? [NETWORK_WARNING] : []),
		...(early.text ? ["", `Output so far${early.truncated ? " (truncated)" : ""}:`, early.text.trimEnd()] : []),
	];
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: { backgroundJob: early.job, ...(network ? { networkWarning: true } : {}) },
	};
}
