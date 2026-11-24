import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	DEFAULT_STALLED_AFTER_MINUTES,
	MAX_STALLED_AFTER_MINUTES,
	MIN_STALLED_AFTER_MINUTES,
} from "./session-events.js";
import { SUPERVISOR_MANDATE_LIMITS as LIMITS } from "./supervisor-contract.js";

/**
 * ACP-owned durable supervisor state in `<project>/.pi/supervisor/`
 * (decision 0077, phase 0): the mandate, the managed-session registry and an
 * append-only ledger. Mutations of one project are serialized in arrival
 * order; JSON documents are written atomically (temp file + rename). Desktop
 * cleanup keeps the directory as canonical project state.
 */
export const SUPERVISOR_DIR = ".pi/supervisor";
export const MANDATE_FILE = "mandate.json";
const BUDGET_HOLD_FILE = "budget-hold.json";
export const REGISTRY_FILE = "registry.json";
export const LEDGER_FILE = "ledger.jsonl";
export const MAX_MANAGED_SESSIONS = 200;
export const MAX_LEDGER_READ = 500;
const MAX_POLICY = 20_000;
const MAX_TEXT = 4_000;
const MAX_ID = 512;

export interface SupervisorMandate {
	readonly version: 1;
	readonly enabled: boolean;
	readonly paused: boolean;
	readonly maxConcurrent: number;
	readonly maxReworkRounds: number;
	/** Token ceiling over a rolling 24 hours; absent = no budget check. */
	readonly budgetTokens?: number;
	readonly stalledAfterMinutes: number;
	readonly policy: string;
	readonly updatedAt: number;
}

export type SupervisorItem =
	| { readonly kind: "task"; readonly taskId: string }
	| { readonly kind: "plan"; readonly path: string }
	| { readonly kind: "prompt" };

export interface ManagedSession {
	readonly item: SupervisorItem;
	readonly mode: "managed" | "manual";
	readonly registeredAt: number;
	readonly reworkRounds: number;
	/** Set by `escalate`: the item waits for the user (cleared by the next supervisor send). */
	readonly escalation?: { readonly text: string; readonly at: number; readonly questionId?: string };
	/** The worker rules preamble was delivered with a supervisor message. */
	readonly briefed?: boolean;
	/** How the session was registered; `close done` auto-closes only `started` tabs. */
	readonly origin?: "started" | "handed_over";
}

export interface SupervisorRegistry {
	readonly version: 1;
	readonly supervisorSessionId?: string;
	/** Former supervisor IDs and when each stopped accruing supervisor usage. */
	readonly previousSupervisors?: Readonly<Record<string, number>>;
	readonly sessions: Readonly<Record<string, ManagedSession>>;
}

export interface LedgerEntry {
	readonly at: number;
	readonly kind: string;
	readonly sessionId?: string;
	readonly detail?: Readonly<Record<string, unknown>>;
}

export const DEFAULT_MANDATE: SupervisorMandate = {
	version: 1,
	enabled: false,
	paused: false,
	maxConcurrent: LIMITS.maxConcurrent.default,
	maxReworkRounds: LIMITS.maxReworkRounds.default,
	stalledAfterMinutes: DEFAULT_STALLED_AFTER_MINUTES,
	policy: "",
	updatedAt: 0,
};

export const EMPTY_REGISTRY: SupervisorRegistry = { version: 1, sessions: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function text(value: unknown, max: number): string | undefined {
	return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

/** Lenient: invalid fields fall back to defaults, never to wider limits. */
export function parseMandate(value: unknown): SupervisorMandate {
	if (!isRecord(value)) return DEFAULT_MANDATE;
	const budget = value["budgetTokens"];
	return {
		version: 1,
		enabled: value["enabled"] === true,
		// Unknown pause state is treated as paused: never resume by accident.
		paused: value["paused"] === undefined ? false : value["paused"] !== false,
		maxConcurrent: intIn(value["maxConcurrent"], LIMITS.maxConcurrent.min, LIMITS.maxConcurrent.max, DEFAULT_MANDATE.maxConcurrent),
		maxReworkRounds: intIn(value["maxReworkRounds"], LIMITS.maxReworkRounds.min, LIMITS.maxReworkRounds.max, DEFAULT_MANDATE.maxReworkRounds),
		...(typeof budget === "number" && Number.isInteger(budget) && budget > 0 ? { budgetTokens: Math.min(budget, LIMITS.budgetTokens.max) } : {}),
		stalledAfterMinutes: intIn(value["stalledAfterMinutes"], MIN_STALLED_AFTER_MINUTES, MAX_STALLED_AFTER_MINUTES, DEFAULT_STALLED_AFTER_MINUTES),
		policy: typeof value["policy"] === "string" ? value["policy"].slice(0, MAX_POLICY) : "",
		updatedAt: typeof value["updatedAt"] === "number" ? value["updatedAt"] : 0,
	};
}

export function parseSupervisorItem(value: unknown): SupervisorItem | undefined {
	if (!isRecord(value)) return undefined;
	if (value["kind"] === "task") {
		const taskId = text(value["taskId"], MAX_ID);
		return taskId ? { kind: "task", taskId } : undefined;
	}
	if (value["kind"] === "plan") {
		const path = text(value["path"], MAX_TEXT);
		return path ? { kind: "plan", path } : undefined;
	}
	return value["kind"] === "prompt" ? { kind: "prompt" } : undefined;
}

/** Lenient: invalid session records are dropped; the result is bounded. */
export function parseRegistry(value: unknown): SupervisorRegistry {
	if (!isRecord(value)) return EMPTY_REGISTRY;
	const sessions: Record<string, ManagedSession> = {};
	const raw = isRecord(value["sessions"]) ? value["sessions"] : {};
	for (const [sessionId, record] of Object.entries(raw)) {
		if (!sessionId || sessionId.length > MAX_ID || !isRecord(record)) continue;
		const item = parseSupervisorItem(record["item"]);
		if (!item) continue;
		sessions[sessionId] = {
			item,
			mode: record["mode"] === "manual" ? "manual" : "managed",
			registeredAt: typeof record["registeredAt"] === "number" ? record["registeredAt"] : 0,
			reworkRounds: intIn(record["reworkRounds"], 0, 1_000, 0),
			...(record["briefed"] === true ? { briefed: true } : {}),
			...(record["origin"] === "started" || record["origin"] === "handed_over" ? { origin: record["origin"] } : {}),
		};
		const escalation = record["escalation"];
		const escalationText = isRecord(escalation) ? text(escalation["text"], 2_000) : undefined;
		if (isRecord(escalation) && escalationText) {
			const questionId = text(escalation["questionId"], MAX_ID);
			sessions[sessionId] = { ...sessions[sessionId]!, escalation: {
				text: escalationText, at: typeof escalation["at"] === "number" ? escalation["at"] : 0, ...(questionId ? { questionId } : {}) } };
		}
	}
	const supervisorSessionId = text(value["supervisorSessionId"], MAX_ID);
	const archived = value["previousSupervisors"];
	const previous = isRecord(archived) ? Object.entries(archived).flatMap(([id, at]) =>
		id !== supervisorSessionId && id.length > 0 && id.length <= MAX_ID && typeof at === "number" && Number.isSafeInteger(at) && at > 0
			? [[id, at] as const] : []) : [];
	return { version: 1, ...(supervisorSessionId ? { supervisorSessionId } : {}),
		...(previous.length ? { previousSupervisors: Object.fromEntries(previous) } : {}), sessions: boundSessions(sessions) };
}

function boundSessions(sessions: Record<string, ManagedSession>): Record<string, ManagedSession> {
	const entries = Object.entries(sessions);
	if (entries.length <= MAX_MANAGED_SESSIONS) return sessions;
	entries.sort((a, b) => b[1].registeredAt - a[1].registeredAt);
	return Object.fromEntries(entries.slice(0, MAX_MANAGED_SESSIONS));
}

export interface SupervisorStoreOptions {
	readonly now?: () => number;
}

export interface SupervisorStore {
	readMandate(cwd: string): Promise<SupervisorMandate>;
	readBudgetHold(cwd: string): Promise<string | undefined>;
	writeBudgetHold(cwd: string, supervisorId: string | undefined): Promise<void>;
	/** Merge a patch into the saved mandate; returns the normalized result. */
	updateMandate(cwd: string, patch: Partial<Omit<SupervisorMandate, "version" | "updatedAt" | "budgetTokens">> & {
		budgetTokens?: number | null;
	}): Promise<SupervisorMandate>;
	readRegistry(cwd: string): Promise<SupervisorRegistry>;
	/** Atomic read-modify-write; `update` must be synchronous and pure. */
	updateRegistry(cwd: string, update: (current: SupervisorRegistry) => SupervisorRegistry): Promise<SupervisorRegistry>;
	appendLedger(cwd: string, entry: Omit<LedgerEntry, "at">): Promise<LedgerEntry>;
	/** Newest `limit` well-formed entries, oldest first. */
	readLedger(cwd: string, limit?: number): Promise<LedgerEntry[]>;
}

export function createSupervisorStore(options: SupervisorStoreOptions = {}): SupervisorStore {
	const now = options.now ?? Date.now;
	const queues = new Map<string, Promise<unknown>>();

	function serialized<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
		const key = resolve(cwd);
		const previous = queues.get(key) ?? Promise.resolve();
		const next = previous.catch(() => {}).then(operation);
		const tail = next.catch(() => {});
		queues.set(key, tail);
		void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
		return next;
	}

	async function readJson(cwd: string, file: string): Promise<unknown> {
		let raw: string;
		try {
			raw = await readFile(join(cwd, SUPERVISOR_DIR, file), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		try {
			return JSON.parse(raw);
		} catch {
			return undefined;
		}
	}

	async function writeJson(cwd: string, file: string, value: unknown): Promise<void> {
		const dir = join(cwd, SUPERVISOR_DIR);
		await mkdir(dir, { recursive: true });
		const temp = join(dir, `.${file}.${randomUUID()}.tmp`);
		try {
			await writeFile(temp, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
			await rename(temp, join(dir, file));
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {});
			throw error;
		}
	}

	return {
		readMandate: (cwd) => serialized(cwd, async () => parseMandate(await readJson(cwd, MANDATE_FILE))),
		readBudgetHold: (cwd) => serialized(cwd, async () => text(await readJson(cwd, BUDGET_HOLD_FILE), MAX_ID)),
		writeBudgetHold: (cwd, id) => serialized(cwd, () => id === undefined
			? rm(join(cwd, SUPERVISOR_DIR, BUDGET_HOLD_FILE), { force: true })
			: writeJson(cwd, BUDGET_HOLD_FILE, id)),
		updateMandate: (cwd, patch) => serialized(cwd, async () => {
			const current = parseMandate(await readJson(cwd, MANDATE_FILE));
			const next = parseMandate({ ...current, ...patch, updatedAt: now() });
			await writeJson(cwd, MANDATE_FILE, next);
			return next;
		}),
		readRegistry: (cwd) => serialized(cwd, async () => parseRegistry(await readJson(cwd, REGISTRY_FILE))),
		updateRegistry: (cwd, update) => serialized(cwd, async () => {
			const next = parseRegistry(update(parseRegistry(await readJson(cwd, REGISTRY_FILE))));
			await writeJson(cwd, REGISTRY_FILE, next);
			return next;
		}),
		appendLedger: (cwd, entry) => serialized(cwd, async () => {
			const full: LedgerEntry = { ...entry, at: now() };
			await mkdir(join(cwd, SUPERVISOR_DIR), { recursive: true });
			await appendFile(join(cwd, SUPERVISOR_DIR, LEDGER_FILE), `${JSON.stringify(full)}\n`, "utf8");
			return full;
		}),
		readLedger: (cwd, limit = 100) => serialized(cwd, async () => {
			let raw: string;
			try {
				raw = await readFile(join(cwd, SUPERVISOR_DIR, LEDGER_FILE), "utf8");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
				throw error;
			}
			const entries: LedgerEntry[] = [];
			for (const line of raw.split("\n")) {
				if (!line.trim()) continue;
				try {
					const value: unknown = JSON.parse(line);
					if (isRecord(value) && typeof value["at"] === "number" && typeof value["kind"] === "string") {
						entries.push(value as unknown as LedgerEntry);
					}
				} catch {
					// A torn last line after a crash is skipped, never fatal.
				}
			}
			return entries.slice(-Math.min(MAX_LEDGER_READ, Math.max(1, limit)));
		}),
	};
}
