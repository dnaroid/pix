import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { publishRpcSessionState } from "../lib/rpc-session-state.js";
import { loadBackgroundShellConfig, type BackgroundShellConfig } from "./config.js";
import { isLive, type BackgroundJobSnapshot, type OrphanRecord } from "./manager.js";
import { backgroundShellManager, formatJobLine, registerBackgroundShellTools, sessionKeyOf } from "./service.js";

export const BACKGROUND_SHELL_STATE_CHANNEL = "pi-tools-suite:background-shell:state";
export const BACKGROUND_SHELL_NOTICE_TYPE = "background-shell-exit";
const STATUS_KEY = "background-shell";
const PUBLISH_THROTTLE_MS = 300;
const SNAPSHOT_TAIL_BYTES = 2 * 1024;
const NOTICE_TAIL_BYTES = 1024;
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP", "SIGKILL"] as const;

export interface BackgroundShellStateJob {
	id: string;
	command: string;
	description?: string;
	status: BackgroundJobSnapshot["status"];
	pid?: number;
	exitCode?: number | null;
	signal?: string | null;
	startedAt: number;
	endedAt?: number;
	logPath: string;
	tail: string;
}

export interface BackgroundShellState {
	checkedAt: number;
	running: number;
	jobs: BackgroundShellStateJob[];
	orphans: Array<{ pid: number; command: string; startedAt: number; logPath: string; jobId: string }>;
}

interface SessionState {
	ctx?: ExtensionContext;
	config: BackgroundShellConfig;
	agentRunning: boolean;
	pending: Map<string, BackgroundJobSnapshot>;
	/** Exits that missed a continuing turn; delivered as context with the next user prompt. */
	deferred: Map<string, BackgroundJobSnapshot>;
	silenced: Set<string>;
	orphans: OrphanRecord[];
	publishTimer?: NodeJS.Timeout;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function text(value: string, details?: unknown) {
	return { content: [{ type: "text" as const, text: value }], details: details ?? {} };
}

function noticeText(job: BackgroundJobSnapshot, tail: string): string {
	const trimmed = tail.trimEnd();
	return [`Background job ${formatJobLine(job)}`, ...(trimmed ? ["Last output:", trimmed] : [])].join("\n");
}

export default function backgroundShell(pi: ExtensionAPI): void {
	const manager = backgroundShellManager();
	const sessions = new Map<string, SessionState>();

	const stateOf = (key: string): SessionState => {
		let state = sessions.get(key);
		if (!state) {
			state = { config: loadBackgroundShellConfig(), agentRunning: false, pending: new Map(), deferred: new Map(), silenced: new Set(), orphans: [] };
			sessions.set(key, state);
		}
		return state;
	};
	const remember = (ctx: ExtensionContext): SessionState => {
		const state = stateOf(sessionKeyOf(ctx));
		state.ctx = ctx;
		return state;
	};

	const buildState = (key: string): BackgroundShellState => {
		const jobs = manager.list(key);
		return {
			checkedAt: Date.now(),
			running: jobs.filter((job) => isLive(job.status)).length,
			jobs: jobs.map((job) => ({
				id: job.id, command: job.command, ...(job.description ? { description: job.description } : {}),
				status: job.status, ...(job.pid !== undefined ? { pid: job.pid } : {}),
				...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
				...(job.signal !== undefined ? { signal: job.signal } : {}),
				startedAt: job.startedAt, ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
				logPath: job.logPath, tail: manager.tail(job.id, SNAPSHOT_TAIL_BYTES),
			})),
			orphans: stateOf(key).orphans.map((orphan) => ({
				pid: orphan.pid, command: orphan.command, startedAt: orphan.startedAt, logPath: orphan.logPath, jobId: orphan.jobId,
			})),
		};
	};

	const publishNow = (key: string): void => {
		const state = sessions.get(key);
		if (!state?.ctx) return;
		const snapshot = buildState(key);
		try {
			const extra = snapshot.orphans.length ? ` · ${snapshot.orphans.length} orphaned` : "";
			state.ctx.ui.setStatus(STATUS_KEY, snapshot.running || snapshot.orphans.length
				? `${snapshot.running} ${snapshot.running === 1 ? "job" : "jobs"}${extra}` : undefined);
			publishRpcSessionState(state.ctx, BACKGROUND_SHELL_STATE_CHANNEL, snapshot);
		} catch {
			// A stale context after session replacement must not break job bookkeeping.
		}
	};
	const schedulePublish = (key: string): void => {
		const state = sessions.get(key);
		if (!state || state.publishTimer) return;
		state.publishTimer = setTimeout(() => {
			state.publishTimer = undefined;
			publishNow(key);
		}, PUBLISH_THROTTLE_MS);
		state.publishTimer.unref?.();
	};

	const notifyUi = (state: SessionState, message: string, level: "info" | "warning" = "info"): void => {
		try { state.ctx?.ui.notify(message, level); } catch { /* stale ctx */ }
	};

	const takeNotices = (key: string) => {
		const state = sessions.get(key);
		if (!state || state.pending.size === 0) return undefined;
		const jobs = [...state.pending.values()];
		state.pending.clear();
		return jobs.map((job) => ({
			type: "custom_message" as const,
			customType: BACKGROUND_SHELL_NOTICE_TYPE,
			content: noticeText(job, manager.tail(job.id, NOTICE_TAIL_BYTES)),
			display: true,
			details: { backgroundJob: job },
		}));
	};

	const unsubscribe = manager.onEvent((event) => {
		const state = sessions.get(event.job.sessionKey);
		if (!state) return;
		schedulePublish(event.job.sessionKey);
		if (event.type !== "status" || isLive(event.job.status)) return;
		if (state.silenced.delete(event.job.id) || state.config.notifyOnExit === "off") return;
		if (state.config.notifyOnExit === "context" && state.agentRunning) {
			state.pending.set(event.job.id, event.job);
			return;
		}
		// Idle (or ui-only): show the user, never trigger a new agent turn.
		notifyUi(state, `Background job ${formatJobLine(event.job)}`, event.job.status === "exited" && event.job.exitCode === 0 ? "info" : "warning");
	});

	pi.on("session_start", (_event, ctx) => {
		const key = sessionKeyOf(ctx);
		manager.openSession(key);
		const state = remember(ctx);
		state.config = loadBackgroundShellConfig(ctx.cwd);
		manager.setSessionLimit(key, state.config.maxJobsPerSession);
		try {
			state.orphans = manager.findOrphans(ctx.cwd);
		} catch {
			state.orphans = [];
		}
		if (state.orphans.length) {
			notifyUi(state, [
				`Found ${state.orphans.length} background job(s) left running by a previous Pix process:`,
				...state.orphans.map((orphan) => `  pid ${orphan.pid}: ${orphan.command}`),
				"They were not stopped. Use /background-jobs kill-orphans to stop them, or /background-jobs orphans to review.",
			].join("\n"), "warning");
		}
		publishNow(key);
	});

	pi.on("agent_start", (_event, ctx) => { remember(ctx).agentRunning = true; });
	pi.on("turn_end", (event, ctx) => {
		// Only a turn that continues with tool results may carry the notice. A trailing
		// non-assistant entry after the final turn makes ACP report the session as
		// continuable, which Desktop shows as a paused run.
		if (!event?.toolResults?.length) return undefined;
		const entries = takeNotices(sessionKeyOf(ctx));
		return entries ? { entries } : undefined;
	});
	pi.on("agent_settled", (_event, ctx) => {
		const state = remember(ctx);
		state.agentRunning = false;
		// Exits that missed a continuing turn: show now, give the model context next prompt.
		for (const job of state.pending.values()) {
			notifyUi(state, `Background job ${formatJobLine(job)}`);
			state.deferred.set(job.id, job);
		}
		state.pending.clear();
	});
	pi.on("before_agent_start", (_event, ctx) => {
		const state = sessions.get(sessionKeyOf(ctx));
		if (!state || state.deferred.size === 0) return undefined;
		const jobs = [...state.deferred.values()];
		state.deferred.clear();
		return {
			message: {
				customType: BACKGROUND_SHELL_NOTICE_TYPE,
				content: jobs.map((job) => noticeText(job, manager.tail(job.id, NOTICE_TAIL_BYTES))).join("\n\n"),
				display: true,
				details: { backgroundJobs: jobs },
			},
		};
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const key = sessionKeyOf(ctx);
		const state = sessions.get(key);
		if (state?.publishTimer) clearTimeout(state.publishTimer);
		sessions.delete(key);
		try { ctx.ui.setStatus(STATUS_KEY, undefined); } catch { /* stale ctx */ }
		await manager.shutdownSession(key);
		// The manager is process-wide; drop this instance's listener once it owns no sessions
		// (an extension reload registers a fresh instance and listener).
		if (sessions.size === 0 && event.reason === "reload") unsubscribe();
	});

	const readJob = (ctx: ExtensionContext, jobId: string) => {
		const key = sessionKeyOf(ctx);
		const job = manager.get(key, jobId);
		if (!job) throw new Error(`Unknown background job: ${jobId}. Call shell_output without job_id to list this session's jobs.`);
		return { key, job };
	};

	const listJobs = (ctx: ExtensionContext) => {
		const jobs = manager.list(sessionKeyOf(ctx));
		if (!jobs.length) return text("No background jobs in this session.", { jobs: [] });
		const now = Date.now();
		return text(jobs.map((job) => `${formatJobLine(job)} (age ${Math.round(((job.endedAt ?? now) - job.startedAt) / 1000)}s)`).join("\n"), { jobs });
	};

	const outputTool = defineTool({
		name: "shell_output",
		label: "Shell Output",
		description: "Read new output from a background shell job started with run_in_background. The server keeps a cursor per job, so repeated calls return only output produced since the last read; pass since to re-read from an absolute byte offset still in the 256 KB ring buffer. Returns status (running, exited(code), killed, failed), text, next cursor and whether output was truncated. The complete log path is included. Omit job_id to list this session's jobs with id, status, pid, age and command.",
		promptSnippet: "Use shell_output(job_id) to read new output from background shell jobs (omit job_id to list them); use shell_kill to stop them.",
		parameters: Type.Object({
			job_id: Type.Optional(Type.String({ description: "Background job id (bg_...); omit to list this session's jobs" })),
			since: Type.Optional(Type.Number({ minimum: 0, description: "Absolute byte offset to read from instead of the server cursor" })),
			filter: Type.Optional(Type.String({ description: "Optional regular expression; only matching lines are returned" })),
			max_bytes: Type.Optional(Type.Number({ minimum: 1, description: "Maximum bytes to return (default 32768)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const state = remember(ctx);
			if (params.job_id === undefined || params.job_id === "") return listJobs(ctx);
			const jobId = params.job_id;
			const { key } = readJob(ctx, jobId);
			let filter: RegExp | undefined;
			if (params.filter) {
				try { filter = new RegExp(params.filter); } catch (error) { throw new Error(`Invalid filter: ${errorText(error)}`); }
			}
			const output = manager.read(key, jobId, {
				...(params.since !== undefined ? { since: params.since } : {}),
				...(params.max_bytes !== undefined ? { maxBytes: params.max_bytes } : {}),
				...(filter ? { filter } : {}),
			});
			if (!isLive(output.job.status) && output.cursor >= output.job.totalBytes) {
				state.pending.delete(output.job.id);
				state.deferred.delete(output.job.id);
			}
			const header = [
				`Status: ${formatJobLine(output.job).split(" ")[1]}`,
				`Bytes ${output.from}..${output.cursor} of ${output.job.totalBytes}${output.truncated ? " (truncated; read again or open the log)" : ""}`,
				`Log: ${output.job.logPath}`,
			].join("\n");
			return text(output.text ? `${header}\n\n${output.text}` : `${header}\n\n(no new output)`, {
				backgroundJob: output.job, cursor: output.cursor, from: output.from, truncated: output.truncated,
			});
		},
	});
	pi.registerTool(outputTool);

	const killTool = defineTool({
		name: "shell_kill",
		label: "Shell Kill",
		description: "Stop a background shell job and its whole process group. Sends SIGTERM by default and escalates to SIGKILL after a short grace period. Returns the final status.",
		parameters: Type.Object({
			job_id: Type.String({ description: "Background job id (bg_...)" }),
			signal: Type.Optional(Type.Union(SIGNALS.map((name) => Type.Literal(name)), { description: "Initial signal (default SIGTERM)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const state = remember(ctx);
			const { key, job } = readJob(ctx, params.job_id);
			if (isLive(job.status)) state.silenced.add(job.id);
			state.pending.delete(job.id);
			state.deferred.delete(job.id);
			const final = await manager.kill(key, job.id, params.signal ?? "SIGTERM");
			return text(`Background job ${formatJobLine(final)}`, { backgroundJob: final });
		},
	});
	pi.registerTool(killTool);
	registerBackgroundShellTools({ output: outputTool, kill: killTool });

	pi.registerCommand("background-jobs", {
		description: "Background shell jobs: list | kill <job_id> | kill-all | orphans | kill-orphans",
		handler: async (args, ctx) => {
			const state = remember(ctx);
			const key = sessionKeyOf(ctx);
			const [action = "list", target] = args.trim().split(/\s+/).filter(Boolean);
			try {
				switch (action) {
					case "list": {
						const jobs = manager.list(key);
						ctx.ui.notify(jobs.length ? jobs.map(formatJobLine).join("\n") : "No background jobs in this session.", "info");
						return;
					}
					case "kill": {
						if (!target) throw new Error("Usage: /background-jobs kill <job_id>");
						state.silenced.add(target);
						const job = await manager.kill(key, target);
						ctx.ui.notify(`Background job ${formatJobLine(job)}`, "info");
						break;
					}
					case "kill-all": {
						const live = manager.list(key).filter((job) => isLive(job.status));
						for (const job of live) state.silenced.add(job.id);
						await Promise.all(live.map((job) => manager.kill(key, job.id)));
						ctx.ui.notify(`Stopped ${live.length} background job(s).`, "info");
						break;
					}
					case "orphans": {
						state.orphans = manager.findOrphans(ctx.cwd);
						ctx.ui.notify(state.orphans.length
							? state.orphans.map((orphan) => `pid ${orphan.pid}: ${orphan.command} (log ${orphan.logPath})`).join("\n")
							: "No orphaned background jobs.", "info");
						break;
					}
					case "kill-orphans": {
						const orphans = manager.findOrphans(ctx.cwd);
						const stopped = orphans.filter((orphan) => manager.killOrphan(orphan)).length;
						state.orphans = [];
						ctx.ui.notify(`Stopped ${stopped} of ${orphans.length} orphaned background job(s).`, "info");
						break;
					}
					default:
						throw new Error("Usage: /background-jobs list | kill <job_id> | kill-all | orphans | kill-orphans");
				}
			} catch (error) {
				ctx.ui.notify(errorText(error), "error");
			}
			publishNow(key);
		},
	});
}
