import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { StopReason } from "@agentclientprotocol/sdk";
import { SUPERVISOR_MANDATE_LIMITS } from "./supervisor-contract.js";

/**
 * Deterministic per-session lifecycle events for the project supervisor
 * (decision 0077, phase 0). ACP derives them from the pi event stream it
 * already observes; no model is involved. Consumers subscribe in-process.
 *
 * - `settled`: the ACP run finished, with its stop reason and the files the
 *   session changed through successful write/edit/apply_patch calls so far;
 * - `file_changed`: one file of a successful write/edit/apply_patch, including
 *   repeat writes (shell writes are not tracked);
 * - `question`: the session waits on a `question` dialog;
 * - `error`: model, compaction, run or process failure;
 * - `stalled`: a running turn produced no event for `stalledAfterMinutes`,
 *   excluding time inside tool calls and while a question is pending.
 *   Notify-only; emitted once per quiet period;
 * - `checklist`: the saved checklist of the plan that launched the session,
 *   on first observation and whenever its counts change.
 */
export const DEFAULT_STALLED_AFTER_MINUTES: number = SUPERVISOR_MANDATE_LIMITS.stalledAfterMinutes.default;
export const MIN_STALLED_AFTER_MINUTES: number = SUPERVISOR_MANDATE_LIMITS.stalledAfterMinutes.min;
export const MAX_STALLED_AFTER_MINUTES: number = SUPERVISOR_MANDATE_LIMITS.stalledAfterMinutes.max;
export const MAX_TOUCHED_FILES = 500;
/** Sessions whose touched files outlive runtime replacement (oldest dropped). */
export const MAX_TRACKED_SESSIONS = 256;
const MAX_ERROR_MESSAGE = 2_000;
const MAX_PLAN_BYTES = 2 * 1024 * 1024;
const PLANS_DIR = ".pi/plans/";

export interface PlanProgress {
	readonly completed: number;
	readonly total: number;
}

export type SessionErrorSource = "model" | "compaction" | "run" | "process";

interface SessionEventBase {
	readonly sessionId: string;
	readonly at: number;
}
export type SessionEvent = SessionEventBase & (
	| { readonly type: "settled"; readonly stopReason: StopReason; readonly touchedFiles: readonly string[] }
	| { readonly type: "file_changed"; readonly path: string }
	| { readonly type: "question"; readonly questionId: string }
	| { readonly type: "error"; readonly source: SessionErrorSource; readonly message: string }
	| { readonly type: "stalled"; readonly idleMs: number }
	| { readonly type: "checklist"; readonly path: string; readonly progress: PlanProgress | null }
	/** Emitted by ACP (not the monitor) when the user takes a managed session over. */
	| { readonly type: "manual_takeover" }
	/** Emitted by ACP startup reconciliation: the saved last turn never finished. */
	| { readonly type: "interrupted" }
	/** Emitted by ACP startup reconciliation: a registered session no longer exists. */
	| { readonly type: "missing" }
);
export type SessionEventListener = (event: SessionEvent) => void;

/** Structural subset of pi session events the observer reads. */
export interface SessionEventInput {
	readonly type: string;
	readonly [key: string]: unknown;
}

export interface SessionEventObserver {
	/** Feed one pi session event. Every event counts as activity. */
	event(event: SessionEventInput): void;
	questionPending(questionId: string): void;
	questionResolved(questionId: string): void;
	/** The ACP run settled (or resolved without an agent run). */
	settled(stopReason: StopReason): void;
	failed(source: SessionErrorSource, message: string): void;
	/** Stop timers and drop pending work. Idempotent. */
	dispose(): void;
}

export interface SessionEventMonitor {
	/** Start observing a session; replaces an older observer for the same id. */
	observe(sessionId: string, cwd: string): SessionEventObserver;
	subscribe(listener: SessionEventListener): () => void;
	/**
	 * Workspace-relative (or absolute outside the workspace) changed files.
	 * Kept per session id across runtime replacement until `forget`.
	 */
	touchedFiles(sessionId: string): readonly string[];
	/** Drop retained state of a deleted session. */
	forget(sessionId: string): void;
	/** Resolves when queued checklist reads have finished (tests, shutdown). */
	whenIdle(): Promise<void>;
	dispose(): void;
}

export interface SessionEventMonitorOptions {
	readonly now?: () => number;
	readonly setTimer?: (callback: () => void, ms: number) => unknown;
	readonly clearTimer?: (handle: unknown) => void;
	readonly stalledAfterMinutes?: number;
	/** Saved plan path that launched the session, if any. */
	readonly planFor?: (cwd: string, sessionId: string) => Promise<string | undefined>;
	readonly readPlanProgress?: (cwd: string, path: string) => Promise<PlanProgress | null>;
	/** Recoverable failures (listener throws, checklist reads). */
	readonly report?: (message: string) => void;
}

export function stalledAfterMs(minutes?: number): number {
	const value = typeof minutes === "number" && Number.isFinite(minutes)
		? Math.min(MAX_STALLED_AFTER_MINUTES, Math.max(MIN_STALLED_AFTER_MINUTES, minutes))
		: DEFAULT_STALLED_AFTER_MINUTES;
	return value * 60_000;
}

const TASK_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\](?:\s|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Count Markdown task-list items outside fenced code blocks. */
export function countChecklist(markdown: string): PlanProgress {
	let completed = 0;
	let total = 0;
	let fence: string | undefined;
	for (const line of markdown.split(/\r?\n/)) {
		const marker = FENCE.exec(line)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = undefined;
			continue;
		}
		if (marker) {
			fence = marker;
			continue;
		}
		const item = TASK_ITEM.exec(line);
		if (!item) continue;
		total += 1;
		if (item[1] !== " ") completed += 1;
	}
	return { completed, total };
}

export async function readPlanProgress(cwd: string, path: string): Promise<PlanProgress | null> {
	const file = resolve(cwd, path);
	try {
		const info = await stat(file);
		if (!info.isFile() || info.size > MAX_PLAN_BYTES) return null;
		return countChecklist(await readFile(file, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function toolPath(args: unknown): string | undefined {
	const record = asRecord(args);
	const path = record?.["file_path"] ?? record?.["path"];
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

const PATCH_FILE_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
const HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Files named by an `apply_patch` input: every Begin-patch Add/Update/Delete
 * header and both sides of a move; for a unified diff, both paths of each
 * `---`/`+++` header pair, without `a/`/`b/` prefixes and `/dev/null`.
 */
export function patchPaths(args: unknown): string[] {
	const record = asRecord(args);
	const input = typeof args === "string" ? args : record?.["input"] ?? record?.["patch"];
	if (typeof input !== "string") return [];
	const text = input.replace(/\r\n?/g, "\n");
	const paths = new Set<string>();
	// The tool also accepts a Begin-patch block wrapped in <<EOF … EOF.
	if (/^\s*(?:\*\*\* Begin Patch\b|<<['"]?EOF['"]?\s*\n\s*\*\*\* Begin Patch\b)/.test(text)) {
		for (const match of text.matchAll(PATCH_FILE_HEADER)) {
			const path = match[1]?.trim();
			if (path) paths.add(path);
		}
	} else {
		// Hunk bodies are skipped by their `@@ -a,b +c,d @@` line counts, so a
		// removed line `-- x` or an added line `++ x` is never read as a header.
		const lines = text.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			const hunk = HUNK_HEADER.exec(line);
			if (hunk) {
				let oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
				let newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
				while ((oldLeft > 0 || newLeft > 0) && i + 1 < lines.length) {
					const body = lines[++i] ?? "";
					if (body.startsWith("\\")) continue;
					if (body.startsWith("-")) oldLeft -= 1;
					else if (body.startsWith("+")) newLeft -= 1;
					else { oldLeft -= 1; newLeft -= 1; }
				}
				continue;
			}
			const next = lines[i + 1] ?? "";
			if (!line.startsWith("--- ") || !next.startsWith("+++ ")) continue;
			for (const header of [line, next]) {
				const path = header.slice(4).split("\t")[0]?.trim().replace(/^[ab]\//, "");
				if (path && path !== "/dev/null") paths.add(path);
			}
			i += 1;
		}
	}
	return [...paths];
}

/** `apply_patch` reports the files it actually changed in `details.changedFiles`. */
function resultChangedFiles(result: unknown): string[] {
	const files = asRecord(asRecord(result)?.["details"])?.["changedFiles"];
	return Array.isArray(files) ? files.filter((file): file is string => typeof file === "string" && file.trim().length > 0) : [];
}

function workspacePath(cwd: string, path: string): string {
	const absolute = resolve(cwd, path);
	const inside = relative(cwd, absolute);
	if (!inside || inside.startsWith("..") || isAbsolute(inside)) return absolute;
	return inside.split(sep).join("/");
}

function lastAssistantError(messages: unknown): string | undefined {
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = asRecord(messages[i]);
		if (message?.["role"] !== "assistant") continue;
		if (message["stopReason"] !== "error") return undefined;
		const text = message["errorMessage"];
		return typeof text === "string" && text ? text : "Request failed";
	}
	return undefined;
}

export function createSessionEventMonitor(options: SessionEventMonitorOptions = {}): SessionEventMonitor {
	const now = options.now ?? Date.now;
	const setTimer = options.setTimer ?? ((callback, ms) => {
		const handle = setTimeout(callback, ms);
		handle.unref?.();
		return handle;
	});
	const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const stallMs = stalledAfterMs(options.stalledAfterMinutes);
	const readProgress = options.readPlanProgress ?? readPlanProgress;
	const report = options.report ?? (() => {});
	const listeners = new Set<SessionEventListener>();
	const observers = new Map<string, Observer>();
	const touchedBySession = new Map<string, Set<string>>();
	const pending = new Set<Promise<void>>();
	let disposed = false;

	function touchedSet(sessionId: string): Set<string> {
		let set = touchedBySession.get(sessionId);
		if (set) {
			touchedBySession.delete(sessionId);
		} else {
			set = new Set();
		}
		touchedBySession.set(sessionId, set);
		while (touchedBySession.size > MAX_TRACKED_SESSIONS) {
			const oldest = touchedBySession.keys().next().value;
			if (oldest === undefined || oldest === sessionId) break;
			touchedBySession.delete(oldest);
		}
		return set;
	}

	function emit(event: SessionEvent): void {
		for (const listener of [...listeners]) {
			try {
				listener(event);
			} catch (error) {
				report(`session event listener failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	class Observer implements SessionEventObserver {
		private disposed = false;
		private running = false;
		private readonly tools = new Map<string, { name: string; paths: readonly string[] }>();
		private readonly questions = new Set<string>();
		private timer: unknown;
		private lastActivity = now();
		private lastChecklist: string | undefined;
		private checklist: Promise<void> = Promise.resolve();

		constructor(readonly sessionId: string, readonly cwd: string) {}

		get touchedFiles(): readonly string[] {
			return [...(touchedBySession.get(this.sessionId) ?? [])];
		}

		event(event: SessionEventInput): void {
			if (this.disposed) return;
			this.lastActivity = now();
			switch (event.type) {
				case "agent_start":
					this.running = true;
					break;
				case "tool_execution_start": {
					const id = event["toolCallId"];
					const name = event["toolName"];
					if (typeof id === "string" && typeof name === "string") {
						const lower = name.toLowerCase();
						const path = toolPath(event["args"]);
						const paths = lower === "apply_patch" ? patchPaths(event["args"]) : path ? [path] : [];
						this.tools.set(id, { name: lower, paths });
					}
					break;
				}
				case "tool_execution_end": {
					const id = event["toolCallId"];
					const tool = typeof id === "string" ? this.tools.get(id) : undefined;
					if (typeof id === "string") this.tools.delete(id);
					if (!tool || event["isError"] === true) break;
					if (tool.name === "write" || tool.name === "edit") {
						for (const path of tool.paths) this.touch(workspacePath(this.cwd, path));
					} else if (tool.name === "apply_patch") {
						// Patch headers name both sides of a move; the result's
						// changedFiles covers inputs the header parser cannot read.
						const paths = new Set<string>();
						for (const path of [...tool.paths, ...resultChangedFiles(event["result"])]) paths.add(workspacePath(this.cwd, path));
						for (const path of paths) this.touch(path);
					}
					break;
				}
				case "agent_end": {
					if (event["willRetry"] === true) break;
					const message = lastAssistantError(event["messages"]);
					if (message) this.failed("model", message);
					break;
				}
				case "compaction_end":
					if (!event["result"] && event["aborted"] !== true && event["willRetry"] !== true) {
						const message = event["errorMessage"];
						this.failed("compaction", typeof message === "string" && message ? message : "Compaction failed");
					}
					break;
			}
			this.armStall();
		}

		questionPending(questionId: string): void {
			if (this.disposed || this.questions.has(questionId)) return;
			this.questions.add(questionId);
			this.disarmStall();
			this.emit({ type: "question", questionId });
		}

		questionResolved(questionId: string): void {
			if (this.disposed || !this.questions.delete(questionId)) return;
			this.lastActivity = now();
			this.armStall();
		}

		settled(stopReason: StopReason): void {
			if (this.disposed) return;
			this.running = false;
			this.tools.clear();
			this.disarmStall();
			this.emit({ type: "settled", stopReason, touchedFiles: this.touchedFiles });
			this.refreshChecklist();
		}

		failed(source: SessionErrorSource, message: string): void {
			if (this.disposed) return;
			this.emit({ type: "error", source, message: message.slice(0, MAX_ERROR_MESSAGE) });
		}

		dispose(): void {
			if (this.disposed) return;
			this.disposed = true;
			this.disarmStall();
			this.tools.clear();
			this.questions.clear();
			if (observers.get(this.sessionId) === this) observers.delete(this.sessionId);
		}

		private emit(event: SessionEvent extends infer E ? E extends SessionEvent ? Omit<E, "sessionId" | "at"> : never : never): void {
			emit({ ...event, sessionId: this.sessionId, at: now() } as SessionEvent);
		}

		private touch(path: string): void {
			const touched = touchedSet(this.sessionId);
			touched.delete(path);
			touched.add(path);
			if (touched.size > MAX_TOUCHED_FILES) {
				const oldest = touched.values().next().value;
				if (oldest !== undefined) touched.delete(oldest);
			}
			this.emit({ type: "file_changed", path });
			if (path.startsWith(PLANS_DIR) && path.toLowerCase().endsWith(".md")) this.refreshChecklist();
		}

		private watching(): boolean {
			return !this.disposed && this.running && this.tools.size === 0 && this.questions.size === 0;
		}

		/**
		 * Armed lazily: streaming events only move `lastActivity`; an expiring
		 * timer re-arms for the remainder instead of every event resetting it.
		 * After `stalled` fires, only new activity arms it again.
		 */
		private armStall(): void {
			if (this.timer !== undefined || !this.watching()) return;
			this.schedule(stallMs);
		}

		private schedule(ms: number): void {
			this.timer = setTimer(() => {
				this.timer = undefined;
				if (!this.watching()) return;
				const idle = now() - this.lastActivity;
				if (idle < stallMs) {
					this.schedule(stallMs - idle);
					return;
				}
				this.emit({ type: "stalled", idleMs: idle });
			}, ms);
		}

		private disarmStall(): void {
			if (this.timer === undefined) return;
			clearTimer(this.timer);
			this.timer = undefined;
		}

		/** Serialized per session so the newest read decides what changed. */
		private refreshChecklist(): void {
			const planFor = options.planFor;
			if (!planFor || this.disposed) return;
			const work = this.checklist.then(async () => {
				if (this.disposed) return;
				const path = await planFor(this.cwd, this.sessionId);
				if (!path || this.disposed) return;
				const progress = await readProgress(this.cwd, path);
				if (this.disposed) return;
				const key = `${path}\n${progress ? `${progress.completed}/${progress.total}` : "missing"}`;
				if (key === this.lastChecklist) return;
				this.lastChecklist = key;
				this.emit({ type: "checklist", path, progress });
			}).catch((error: unknown) => {
				report(`plan checklist refresh failed: ${error instanceof Error ? error.message : String(error)}`);
			});
			this.checklist = work;
			pending.add(work);
			void work.finally(() => pending.delete(work));
		}
	}

	return {
		observe(sessionId, cwd) {
			observers.get(sessionId)?.dispose();
			const observer = new Observer(sessionId, cwd);
			if (disposed) observer.dispose();
			else observers.set(sessionId, observer);
			return observer;
		},
		subscribe(listener) {
			if (disposed) return () => {};
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		touchedFiles(sessionId) {
			return [...(touchedBySession.get(sessionId) ?? [])];
		},
		forget(sessionId) {
			touchedBySession.delete(sessionId);
		},
		async whenIdle() {
			while (pending.size > 0) await Promise.allSettled([...pending]);
		},
		dispose() {
			disposed = true;
			for (const observer of [...observers.values()]) observer.dispose();
			listeners.clear();
			touchedBySession.clear();
		},
	};
}
