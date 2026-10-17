// Session-native sub-agent state (decision 0072, stages 3+4).
//
// Durable facts live as `pi-tools-suite:subagent` custom entries in the
// PARENT session (the parent is the sole writer there); each entry is a
// patch keyed by (scope, batch, agentId) and records are rebuilt by folding
// patches in entry order. Volatile facts (process handle, live activity,
// full result text, stderr tail) live only in this process. There are no
// per-agent sidecar files and no registry: the only per-agent directory is
// the owned-launch base (see paths.ownedAgentDir).
//
// The store hangs off globalThis so an extension reload in the same process
// keeps seeing agents launched by the previous module instance.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { batchBaseName, PARENT_SESSION_ID_PATTERN, parseRunKey, runKey } from "./paths.js";
import type { AgentActivity, AgentTask, StructuredResult } from "./types.js";

export const SUBAGENT_RECORD_ENTRY = "pi-tools-suite:subagent";
const CHILD_TAIL_BYTES = 8 * 1024 * 1024;

export type SubagentStatus = "planned" | "running" | "retrying" | "done" | "failed" | "stopped";

/** Persisted patch fields. `null` deletes a field when folded. */
export interface SubagentRecordPatch {
	cwd?: string;
	createdAt?: string;
	task?: AgentTask;
	extraArgs?: string[];
	timeoutMs?: number;
	maxResultBytes?: number;
	subagentType?: string;
	model?: string;
	status?: SubagentStatus;
	exitCode?: number | null;
	startedAt?: string | null;
	finishedAt?: string | null;
	retryCount?: number;
	nextRetryAt?: string | null;
	pid?: number | null;
	processGroup?: boolean | null;
	childSessionFile?: string | null;
	parentSession?: string;
	owned?: boolean;
	stopRequested?: boolean | null;
	stopSignal?: string | null;
	timedOut?: boolean | null;
	turn?: number;
	/** Compact structured result (never carries resultText). */
	structured?: StructuredResult | null;
	/** Parent-authored bounded result text (launch failure, timeout, stop, RPC error). */
	message?: string | null;
	stderrPreview?: string | null;
	modelFallback?: { from: string; to: string } | null;
}

type Folded<T> = { [K in keyof T]?: Exclude<T[K], null> };

export interface SubagentRecord extends Folded<SubagentRecordPatch> {
	/** Run key `<cwd>/.pi/subagents/<scope>/<batch>`. */
	runDir: string;
	scope: string;
	batch: string;
	agentId: string;
	seq: number;
}

/** In-process overlay; never persisted. */
export interface SubagentLive {
	/** This process owns the agent (queued, running, retry pending, or settling). */
	active?: boolean;
	process?: ChildProcess;
	resultText?: string;
	stderrTail?: string;
	lastActivity?: AgentActivity;
	todoProgress?: { completed: number; total: number };
	/** Child pi argv of the latest launch (diagnostics/tests; never persisted). */
	launchArgs?: string[];
}

export interface SubagentRecordWriter {
	appendCustomEntry?: (customType: string, data?: unknown) => unknown;
}

interface ManagerLike extends SubagentRecordWriter {
	getSessionId?: () => string;
	getCwd?: () => string;
	getEntries?: () => ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>;
}

interface StoreState {
	runs: Map<string, Map<string, SubagentRecord>>;
	live: Map<string, SubagentLive>;
	writers: Map<string, SubagentRecordWriter>;
	hydrated: WeakSet<object>;
	batches: Set<string>;
	seq: number;
	processScope: string;
}

const STORE_KEY = Symbol.for("pi-tools-suite.async-subagents.store.v1");

function store(): StoreState {
	const holder = globalThis as unknown as Record<symbol, StoreState | undefined>;
	let state = holder[STORE_KEY];
	if (!state) {
		state = {
			runs: new Map(), live: new Map(), writers: new Map(), hydrated: new WeakSet(), batches: new Set(), seq: 0,
			processScope: randomUUID(),
		};
		holder[STORE_KEY] = state;
	}
	return state;
}

function recordKey(runDir: string, agentId: string): string {
	return `${runDir}\0${agentId}`;
}

/** Scope of a parent manager: its UUID session id, else a per-process scope (headless/tests). */
export function resolveScope(manager?: unknown): string {
	try {
		const id = (manager as ManagerLike | undefined)?.getSessionId?.();
		if (typeof id === "string" && PARENT_SESSION_ID_PATTERN.test(id)) return id;
	} catch {
		/* stale context: fall through */
	}
	return store().processScope;
}

/** Fresh unique run key for a new batch (no directory is created). */
export function createBatch(cwd: string, scope: string, slug?: string): string {
	const state = store();
	const base = batchBaseName(slug);
	let batch = base;
	for (let suffix = 2; state.batches.has(runKey(cwd, scope, batch)) || state.runs.has(runKey(cwd, scope, batch)); suffix++) {
		batch = `${base}-${suffix}`;
	}
	const key = runKey(cwd, scope, batch);
	state.batches.add(key);
	return key;
}

/** Register an explicit batch name (tool `runDir` reuse) in the current scope. */
export function batchRunKey(cwd: string, scope: string, batch: string): string {
	const key = runKey(cwd, scope, batch);
	store().batches.add(key);
	return key;
}

function applyPatch(record: SubagentRecord, patch: SubagentRecordPatch): void {
	for (const [name, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		if (value === null) delete (record as unknown as Record<string, unknown>)[name];
		else (record as unknown as Record<string, unknown>)[name] = value;
	}
}

/**
 * Fold a parent manager's subagent entries into the store once. In-memory
 * records win: this process is the only writer of the entries it owns.
 */
export function hydrateFromManager(manager: unknown): void {
	if (typeof manager !== "object" || manager === null) return;
	const state = store();
	if (state.hydrated.has(manager)) return;
	state.hydrated.add(manager);
	const reader = manager as ManagerLike;
	let entries: ReadonlyArray<{ type?: string; customType?: string; data?: unknown }>;
	let fallbackCwd: string | undefined;
	try {
		entries = reader.getEntries?.() ?? [];
		fallbackCwd = reader.getCwd?.();
	} catch {
		return;
	}
	const fallbackScope = resolveScope(manager);
	const folded = new Map<string, SubagentRecord>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== SUBAGENT_RECORD_ENTRY) continue;
		const data = entry.data as (SubagentRecordPatch & { version?: unknown; batch?: unknown; agentId?: unknown; scope?: unknown }) | undefined;
		if (!data || data.version !== 1 || typeof data.batch !== "string" || typeof data.agentId !== "string") continue;
		const scope = typeof data.scope === "string" && PARENT_SESSION_ID_PATTERN.test(data.scope) ? data.scope : fallbackScope;
		const keyId = `${scope}\0${data.batch}\0${data.agentId}`;
		let record = folded.get(keyId);
		if (!record) {
			const cwd = typeof data.cwd === "string" ? data.cwd : fallbackCwd;
			if (!cwd) continue;
			record = { runDir: runKey(cwd, scope, data.batch), scope, batch: data.batch, agentId: data.agentId, seq: 0 };
			folded.set(keyId, record);
		}
		const { version: _v, batch: _b, agentId: _a, scope: _s, ...patch } = data;
		applyPatch(record, patch);
	}
	for (const record of folded.values()) {
		const run = state.runs.get(record.runDir) ?? new Map<string, SubagentRecord>();
		if (run.has(record.agentId)) continue;
		record.seq = ++state.seq;
		run.set(record.agentId, record);
		state.runs.set(record.runDir, run);
		state.writers.set(recordKey(record.runDir, record.agentId), manager as SubagentRecordWriter);
	}
}

/**
 * Merge a patch into a record (creating it) and append it to the parent
 * session. The writer captured at creation is reused unless one is passed.
 */
export function updateRecord(runDir: string, agentId: string, patch: SubagentRecordPatch, writer?: unknown): SubagentRecord {
	const state = store();
	const parsed = parseRunKey(runDir);
	let run = state.runs.get(runDir);
	if (!run) {
		run = new Map();
		state.runs.set(runDir, run);
	}
	let record = run.get(agentId);
	const created = !record;
	if (!record) {
		record = {
			runDir, scope: parsed?.scope ?? state.processScope, batch: parsed?.batch ?? runDir, agentId, seq: ++state.seq,
			cwd: parsed?.cwd, createdAt: new Date().toISOString(),
		};
		run.set(agentId, record);
	}
	applyPatch(record, patch);
	const key = recordKey(runDir, agentId);
	if (writer && typeof writer === "object") state.writers.set(key, writer as SubagentRecordWriter);
	const target = state.writers.get(key);
	try {
		if (typeof target?.appendCustomEntry === "function") {
			const data: Record<string, unknown> = { version: 1, scope: record.scope, batch: record.batch, agentId };
			if (created) Object.assign(data, { cwd: record.cwd, createdAt: record.createdAt });
			for (const [name, value] of Object.entries(patch)) if (value !== undefined) data[name] = value;
			target.appendCustomEntry(SUBAGENT_RECORD_ENTRY, data);
		}
	} catch {
		// Persistence is best effort: a stale/closed parent manager must not
		// break the live process or its in-memory state.
	}
	return record;
}

export function getRecord(runDir: string, agentId: string): SubagentRecord | undefined {
	return store().runs.get(runDir)?.get(agentId);
}

/** Records of one batch in launch order. */
export function listRunRecords(runDir: string): SubagentRecord[] {
	return [...(store().runs.get(runDir)?.values() ?? [])].sort((a, b) => a.seq - b.seq);
}

function createdOrder(record: SubagentRecord): string {
	return record.createdAt ?? "";
}

function newer(a: SubagentRecord, b: SubagentRecord): number {
	const byTime = createdOrder(b).localeCompare(createdOrder(a));
	return byTime !== 0 ? byTime : b.seq - a.seq;
}

/** Batches of a scope, newest first. */
export function listScopeRunDirs(cwd: string, scope: string): string[] {
	const latest = new Map<string, SubagentRecord>();
	for (const [runDir, run] of store().runs) {
		const parsed = parseRunKey(runDir);
		if (!parsed || parsed.scope !== scope || parsed.cwd !== cwd) continue;
		for (const record of run.values()) {
			const current = latest.get(runDir);
			if (!current || newer(record, current) < 0) latest.set(runDir, record);
		}
	}
	return [...latest.entries()].sort(([, a], [, b]) => newer(a, b)).map(([runDir]) => runDir);
}

/** Every record of a project (all scopes), newest first. */
export function listProjectRecords(cwd: string): SubagentRecord[] {
	const records: SubagentRecord[] = [];
	for (const [runDir, run] of store().runs) {
		if (parseRunKey(runDir)?.cwd !== cwd) continue;
		records.push(...run.values());
	}
	return records.sort(newer);
}

/** Latest record of an agent id in a scope (agentId reuse: latest wins). */
export function findLatestAgentRecord(cwd: string, scope: string, agentId: string): SubagentRecord | undefined {
	let best: SubagentRecord | undefined;
	for (const runDir of listScopeRunDirs(cwd, scope)) {
		const record = getRecord(runDir, agentId);
		if (record && (!best || newer(record, best) < 0)) best = record;
	}
	return best;
}

/** Find the record whose child session file matches (navigation/`/sub-back`). */
export function findRecordByChildSession(sessionFile: string | undefined): SubagentRecord | undefined {
	if (!sessionFile) return undefined;
	for (const run of store().runs.values()) {
		for (const record of run.values()) if (record.childSessionFile === sessionFile) return record;
	}
	return undefined;
}

export function getLive(runDir: string, agentId: string): SubagentLive | undefined {
	return store().live.get(recordKey(runDir, agentId));
}

export function updateLive(runDir: string, agentId: string, patch: Partial<SubagentLive>): SubagentLive {
	const state = store();
	const key = recordKey(runDir, agentId);
	const live = state.live.get(key) ?? {};
	for (const [name, value] of Object.entries(patch)) (live as Record<string, unknown>)[name] = value;
	state.live.set(key, live);
	return live;
}

export function clearLive(runDir: string, agentId: string): void {
	store().live.delete(recordKey(runDir, agentId));
}

/** Forget a record in memory (persisted entries are append-only history). */
export function forgetRecord(runDir: string, agentId: string): void {
	const state = store();
	const run = state.runs.get(runDir);
	run?.delete(agentId);
	if (run && run.size === 0) state.runs.delete(runDir);
	state.live.delete(recordKey(runDir, agentId));
	state.writers.delete(recordKey(runDir, agentId));
}

/** Test-only: drop all in-memory state. */
export function resetSubagentStoreForTest(): void {
	const holder = globalThis as unknown as Record<symbol, StoreState | undefined>;
	delete holder[STORE_KEY];
}

/**
 * Text of the last assistant message with text in a child session JSONL
 * (the full result after restart). Reads at most the trailing 8 MiB.
 */
export function readChildLastAssistantText(file: string | undefined): string | undefined {
	if (!file) return undefined;
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "r");
		const size = fs.fstatSync(fd).size;
		const length = Math.min(size, CHILD_TAIL_BYTES);
		const buffer = Buffer.alloc(length);
		fs.readSync(fd, buffer, 0, length, size - length);
		const lines = buffer.toString("utf8").split("\n");
		if (length < size) lines.shift();
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trim();
			if (!line) continue;
			let entry: { type?: unknown; message?: { role?: unknown; content?: unknown; stopReason?: unknown } };
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
			if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") continue;
			const text = assistantText(entry.message.content);
			if (text) return text;
		}
		return undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function assistantText(content: unknown): string | undefined {
	if (typeof content === "string") return content.trim() ? content : undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
	return text.trim() ? text : undefined;
}
