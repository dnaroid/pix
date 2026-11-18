import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { openTaskDatabase } from "../registry/task-database.js";
import { isSupervisorMutation, type SupervisorMutation, type SupervisorToolRequest } from "./supervisor-contract.js";
import { readPlanProgress as defaultReadPlanProgress, type PlanProgress, type SessionEvent } from "./session-events.js";
import type { ManagedSession, SupervisorStore } from "./supervisor-store.js";
import type { PixQuestion } from "./ui-request-bridge.js";

/**
 * `supervisor` tool operations (decision 0077). `status` and `read` are
 * derived from ACP state and saved project files with no model call; mutating
 * ops are delegated to `mutate` (supervisor-actions.ts) after the caller check.
 */

export const MAX_STATUS_MANAGED = 50;
export const MAX_STATUS_OBSERVED = 20;
export const MAX_DIGEST_FILES = 100;
const MAX_LAST_EVENTS = 256;
const MAX_USER_TEXT = 1_500;
const MAX_REPORT_TEXT = 4_000;
const MAX_TOOL_ERROR_TEXT = 300;
const MAX_TOOL_ERRORS = 5;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_TASK_ROWS = 10_000;

export interface SupervisorSessionRecord {
	readonly sessionId: string;
	readonly cwd: string;
	readonly piSessionPath: string;
	readonly title?: string | undefined;
	readonly updatedAt: string;
	readonly subagent?: unknown;
}

export interface SupervisorLiveSession {
	readonly running: boolean;
	readonly pendingQuestions: number;
	messages(): Promise<readonly unknown[]>;
}

export interface SupervisorPendingQuestion {
	readonly questionId: string;
	readonly questions: readonly PixQuestion[];
}

export interface SupervisorServiceDeps {
	readonly store: SupervisorStore;
	listRecords(cwd: string): Promise<readonly SupervisorSessionRecord[]>;
	getRecord(sessionId: string): Promise<SupervisorSessionRecord | undefined>;
	live(sessionId: string): SupervisorLiveSession | undefined;
	questions?(sessionId: string): readonly SupervisorPendingQuestion[];
	touchedFiles(sessionId: string): readonly string[];
	planFor(cwd: string, sessionId: string): Promise<string | undefined>;
	readPlanProgress?(cwd: string, path: string): Promise<PlanProgress | null>;
	readTaskLinks?(cwd: string): Promise<ReadonlyMap<string, TaskLink>>;
	readTranscript?(path: string): Promise<readonly unknown[]>;
	/** Mutating ops; absent means the host offers only observation. */
	mutate?(cwd: string, callerSessionId: string, request: SupervisorMutation, callerIsCurrent?: () => boolean): Promise<unknown>;
	report?(message: string): void;
}

export interface TaskLink {
	readonly taskId: string;
	readonly title: string;
	readonly status: string;
}

export type RunState = "running" | "question" | "idle" | "not-loaded";

export interface LastEvent {
	readonly type: SessionEvent["type"];
	readonly at: number;
	readonly stopReason?: string;
	readonly source?: string;
	readonly message?: string;
	readonly idleMs?: number;
}

export interface SupervisorSessionSummary {
	readonly sessionId: string;
	readonly title?: string;
	readonly managed?: Pick<ManagedSession, "item" | "mode" | "reworkRounds" | "escalation">;
	readonly task?: TaskLink;
	readonly run: RunState;
	readonly last?: LastEvent;
	readonly plan?: { readonly path: string; readonly progress: PlanProgress | null };
	readonly updatedAt?: string;
}

export interface SupervisorDigest extends SupervisorSessionSummary {
	readonly pendingQuestion: boolean;
	readonly questions?: readonly SupervisorPendingQuestion[];
	readonly touchedFiles: readonly string[];
	readonly touchedFilesTotal: number;
	readonly lastUserMessages: readonly string[];
	readonly finalReport?: { readonly text: string; readonly stopReason?: string };
	readonly toolErrors: readonly { readonly tool: string; readonly text: string }[];
	readonly messageCount: number;
}

export interface SupervisorService {
	/** Remember the newest lifecycle event per session (bounded). */
	record(event: SessionEvent): void;
	handle(cwd: string, callerSessionId: string, request: SupervisorToolRequest, callerIsCurrent?: () => boolean): Promise<unknown>;
	/** Bounded digest of one worker session (the `read` op without the caller check). */
	digest(cwd: string, callerSessionId: string, sessionId: string): Promise<SupervisorDigest>;
	/** Stop reason of the last settled turn ACP saw for the session. */
	lastStopReason(sessionId: string): string | undefined;
	forget(sessionId: string): void;
}

export function createSupervisorService(deps: SupervisorServiceDeps): SupervisorService {
	const lastEvents = new Map<string, LastEvent>();
	const lastStops = new Map<string, string>();
	const readProgress = deps.readPlanProgress ?? defaultReadPlanProgress;
	const readTasks = deps.readTaskLinks ?? readTaskLinks;
	const readTranscript = deps.readTranscript ?? readSessionBranchMessages;
	const report = deps.report ?? (() => {});

	function runState(sessionId: string): RunState {
		const live = deps.live(sessionId);
		if (!live) return "not-loaded";
		if (live.pendingQuestions > 0) return "question";
		return live.running ? "running" : "idle";
	}

	async function plan(cwd: string, sessionId: string): Promise<SupervisorSessionSummary["plan"]> {
		try {
			const path = await deps.planFor(cwd, sessionId);
			if (!path) return undefined;
			return { path, progress: await readProgress(cwd, path) };
		} catch (error) {
			report(`supervisor plan progress failed: ${errorMessage(error)}`);
			return undefined;
		}
	}

	async function taskLinks(cwd: string): Promise<ReadonlyMap<string, TaskLink>> {
		try {
			return await readTasks(cwd);
		} catch (error) {
			report(`supervisor task links failed: ${errorMessage(error)}`);
			return new Map();
		}
	}

	async function summary(
		cwd: string,
		sessionId: string,
		record: SupervisorSessionRecord | undefined,
		managed: ManagedSession | undefined,
		tasks: ReadonlyMap<string, TaskLink>,
	): Promise<SupervisorSessionSummary> {
		const task = tasks.get(sessionId);
		const last = lastEvents.get(sessionId);
		const linkedPlan = await plan(cwd, sessionId);
		return {
			sessionId,
			...(record?.title ? { title: record.title } : {}),
			...(managed ? { managed: { item: managed.item, mode: managed.mode, reworkRounds: managed.reworkRounds,
				...(managed.escalation ? { escalation: managed.escalation } : {}) } } : {}),
			...(task ? { task } : {}),
			run: runState(sessionId),
			...(last ? { last } : {}),
			...(linkedPlan ? { plan: linkedPlan } : {}),
			...(record ? { updatedAt: record.updatedAt } : {}),
		};
	}

	async function status(cwd: string, callerSessionId: string): Promise<unknown> {
		const [mandate, registry, records, tasks] = await Promise.all([
			deps.store.readMandate(cwd),
			deps.store.readRegistry(cwd),
			deps.listRecords(cwd),
			taskLinks(cwd),
		]);
		const byId = new Map(records.map((record) => [record.sessionId, record]));
		const managedIds = Object.keys(registry.sessions);
		const managed = await Promise.all(managedIds.slice(0, MAX_STATUS_MANAGED)
			.map((id) => summary(cwd, id, byId.get(id), registry.sessions[id], tasks)));
		// Phase 1 observes the project's other recent sessions as well, so the
		// supervisor can report on work the user started by hand.
		const observedRecords = records
			.filter((record) => record.sessionId !== callerSessionId && !record.subagent && !registry.sessions[record.sessionId])
			.slice(0, MAX_STATUS_OBSERVED);
		const observed = await Promise.all(observedRecords.map((record) => summary(cwd, record.sessionId, record, undefined, tasks)));
		const running = managed.filter((session) => session.run === "running" || session.run === "question").length;
		return {
			mandate: {
				enabled: mandate.enabled,
				paused: mandate.paused,
				maxConcurrent: mandate.maxConcurrent,
				maxReworkRounds: mandate.maxReworkRounds,
				...(mandate.budgetTokens !== undefined ? { budgetTokens: mandate.budgetTokens } : { budgetTokens: null }),
				stalledAfterMinutes: mandate.stalledAfterMinutes,
				...(mandate.workerModelRef ? { workerModelRef: mandate.workerModelRef } : {}),
				policy: mandate.policy,
			},
			limits: { running, maxConcurrent: mandate.maxConcurrent },
			managed,
			managedTotal: managedIds.length,
			observed,
			note: deps.mutate
				? "Use op=read for a bounded digest and live questions; start launches new managed work; send/answer/cancel/close/reopen act only on managed sessions. All need the mandate enabled and not paused."
				: "Observer phase: supervisor can only read. Use op=read with a sessionId for a bounded digest.",
		};
	}

	async function read(cwd: string, callerSessionId: string, sessionId: string): Promise<SupervisorDigest> {
		if (sessionId === callerSessionId) throw new Error("supervisor read is for worker sessions, not the supervisor itself");
		const [registry, record, tasks] = await Promise.all([
			deps.store.readRegistry(cwd),
			deps.getRecord(sessionId),
			taskLinks(cwd),
		]);
		if (!record || record.cwd !== cwd || record.subagent) throw new Error(`Unknown session ${sessionId} in this project; use op=status for session ids`);
		const base = await summary(cwd, sessionId, record, registry.sessions[sessionId], tasks);
		const live = deps.live(sessionId);
		let messages: readonly unknown[] = [];
		try {
			messages = live ? await live.messages() : await readTranscript(record.piSessionPath);
		} catch (error) {
			report(`supervisor transcript read failed: ${errorMessage(error)}`);
			throw new Error(`Could not read session ${sessionId}: ${errorMessage(error)}`);
		}
		const touched = deps.touchedFiles(sessionId);
		const questions = registry.sessions[sessionId]?.mode === "managed" ? deps.questions?.(sessionId) : undefined;
		return {
			...base,
			pendingQuestion: (live?.pendingQuestions ?? 0) > 0,
			...(questions?.length ? { questions: questions.slice(0, 5).map(({ questionId, questions }) => ({ questionId,
				questions: questions.map((question) => ({ ...question, label: clip(question.label, 300), prompt: clip(question.prompt, MAX_USER_TEXT),
					choices: question.choices.map((choice) => ({ ...choice, label: clip(choice.label, 300),
						...(choice.description ? { description: clip(choice.description, 500) } : {}) })) })),
			})) } : {}),
			touchedFiles: touched.slice(-MAX_DIGEST_FILES),
			touchedFilesTotal: touched.length,
			...digestMessages(messages),
		};
	}

	return {
		record(event) {
			lastEvents.delete(event.sessionId);
			lastEvents.set(event.sessionId, lastEventOf(event));
			while (lastEvents.size > MAX_LAST_EVENTS) {
				const oldest = lastEvents.keys().next().value;
				if (oldest === undefined) break;
				lastEvents.delete(oldest);
			}
			if (event.type === "settled") {
				lastStops.delete(event.sessionId);
				lastStops.set(event.sessionId, event.stopReason);
				while (lastStops.size > MAX_LAST_EVENTS) {
					const oldest = lastStops.keys().next().value;
					if (oldest === undefined) break;
					lastStops.delete(oldest);
				}
			}
		},
		async handle(cwd, callerSessionId, request, callerIsCurrent) {
			const registry = await deps.store.readRegistry(cwd);
			if (registry.supervisorSessionId !== callerSessionId) {
				throw new Error("This session is not the project supervisor; open it from Desktop (Open Project Supervisor)");
			}
			if (request.op === "status") return status(cwd, callerSessionId);
			if (request.op === "read") return read(cwd, callerSessionId, request.sessionId);
			if (!isSupervisorMutation(request) || !deps.mutate) throw new Error(`supervisor ${request.op} is not available on this host`);
			return deps.mutate(cwd, callerSessionId, request, callerIsCurrent);
		},
		digest: read,
		lastStopReason: (sessionId) => lastStops.get(sessionId),
		forget(sessionId) {
			lastEvents.delete(sessionId);
			lastStops.delete(sessionId);
		},
	};
}

function lastEventOf(event: SessionEvent): LastEvent {
	switch (event.type) {
		case "settled": return { type: event.type, at: event.at, stopReason: event.stopReason };
		case "error": return { type: event.type, at: event.at, source: event.source, message: event.message.slice(0, 500) };
		case "stalled": return { type: event.type, at: event.at, idleMs: event.idleMs };
		default: return { type: event.type, at: event.at };
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => {
		const row = record(part);
		return row?.["type"] === "text" && typeof row["text"] === "string" ? [row["text"]] : [];
	}).join("\n").trim();
}

/** Bounded digest of a message list: never the full transcript. */
export function digestMessages(messages: readonly unknown[]): Pick<SupervisorDigest,
	"lastUserMessages" | "finalReport" | "toolErrors" | "messageCount"> {
	const users: string[] = [];
	const toolErrors: { tool: string; text: string }[] = [];
	let finalReport: SupervisorDigest["finalReport"];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = record(messages[i]);
		if (!message) continue;
		const role = message["role"];
		if (role === "user" && users.length < 2) {
			const text = textOf(message["content"]);
			if (text) users.unshift(clip(text, MAX_USER_TEXT));
		} else if (role === "assistant" && !finalReport) {
			const text = textOf(message["content"]);
			if (text) {
				const stopReason = message["stopReason"];
				finalReport = { text: clip(text, MAX_REPORT_TEXT), ...(typeof stopReason === "string" ? { stopReason } : {}) };
			}
		} else if (role === "toolResult" && message["isError"] === true && toolErrors.length < MAX_TOOL_ERRORS) {
			const tool = typeof message["toolName"] === "string" ? message["toolName"] : "tool";
			toolErrors.unshift({ tool, text: clip(textOf(message["content"]), MAX_TOOL_ERROR_TEXT) });
		}
		if (users.length >= 2 && finalReport && toolErrors.length >= MAX_TOOL_ERRORS) break;
	}
	return { lastUserMessages: users, ...(finalReport ? { finalReport } : {}), toolErrors, messageCount: messages.length };
}

/** Messages on the current branch of a saved Pi session (leaf = last entry). */
export async function readSessionBranchMessages(path: string): Promise<unknown[]> {
	const info = await stat(path);
	if (!info.isFile()) throw new Error("session transcript is not a file");
	if (info.size > MAX_TRANSCRIPT_BYTES) throw new Error("session transcript is too large to digest");
	const entries = new Map<string, { parentId: string | undefined; message: unknown }>();
	let leaf: string | undefined;
	for (const line of (await readFile(path, "utf8")).split("\n")) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown> | undefined;
		try { entry = record(JSON.parse(line)); } catch { continue; } // torn tail line
		const id = entry?.["id"];
		if (!entry || typeof id !== "string") continue;
		const parentId = entry["parentId"];
		entries.set(id, {
			parentId: typeof parentId === "string" ? parentId : undefined,
			message: entry["type"] === "message" ? entry["message"] : undefined,
		});
		leaf = id;
	}
	const messages: unknown[] = [];
	const seen = new Set<string>();
	for (let id = leaf; id && !seen.has(id); id = entries.get(id)?.parentId) {
		seen.add(id);
		const message = entries.get(id)?.message;
		if (message !== undefined) messages.push(message);
	}
	return messages.reverse();
}

/** Saved tasks linked to sessions, read-only. Missing storage = no links. */
export async function readTaskLinks(cwd: string): Promise<Map<string, TaskLink>> {
	const links = new Map<string, TaskLink>();
	let db: Awaited<ReturnType<typeof openTaskDatabase>>;
	try {
		db = await openTaskDatabase(join(cwd, ".pi", "tasks.sqlite"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return links;
		throw error;
	}
	try {
		for (const row of db.prepare(`SELECT id,payload FROM tasks LIMIT ${MAX_TASK_ROWS}`).iterate()) {
			if (typeof row["id"] !== "string" || typeof row["payload"] !== "string") continue;
			let payload: Record<string, unknown> | undefined;
			try { payload = record(JSON.parse(row["payload"])); } catch { continue; }
			const sessionId = payload?.["sessionId"];
			if (typeof sessionId !== "string" || !sessionId) continue;
			links.set(sessionId, {
				taskId: row["id"],
				title: typeof payload?.["title"] === "string" ? clip(payload["title"], 200) : "",
				status: typeof payload?.["status"] === "string" ? payload["status"] : "unknown",
			});
		}
	} finally {
		db.close();
	}
	return links;
}
