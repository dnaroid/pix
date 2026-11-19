// Debounced supervisor wakes (0077, phase 1). Worker lifecycle events are
// coalesced per project into one digest. The digest is delivered as a single
// auto-queued message in the supervisor session: an idle supervisor runs it
// as one wake turn, and a busy one gets it after its current turn. While that
// message is still queued, later events rewrite it instead of adding more.
import { resolve } from "node:path";
import { MAX_TOUCHED_FILES, type SessionEvent } from "./session-events.js";
import type { SupervisorRegistry } from "./supervisor-store.js";

export const DEFAULT_WAKE_DEBOUNCE_MS = 5_000;
const MAX_DIGEST_SESSIONS = 20;
const MAX_CONFLICTS_PER_SESSION = 10;
const MAX_LINE_TEXT = 200;

export interface SupervisorWakerDeps {
	readonly debounceMs?: number | undefined;
	readonly setTimer?: (callback: () => void, ms: number) => unknown;
	readonly clearTimer?: (handle: unknown) => void;
	registryFor(cwd: string): Promise<SupervisorRegistry | undefined>;
	paused(cwd: string): Promise<boolean>;
	/**
	 * Rewrite queued item `replace.id` with `replace.text` when it is still
	 * queued, otherwise queue `text` as a new item. Undefined when the
	 * supervisor is not loaded.
	 */
	enqueue(supervisorSessionId: string, text: string, replace?: { readonly id: string; readonly text: string }):
		Promise<{ readonly itemId: string; readonly replaced: boolean } | undefined>;
	/**
	 * Rewrite (`text`) or remove (`undefined`) queued item `itemId` only while it
	 * is still queued; never queues anything. False once the supervisor took it.
	 */
	rewrite(supervisorSessionId: string, itemId: string, text: string | undefined): Promise<boolean>;
	report?(message: string): void;
}

export interface SupervisorWaker {
	push(cwd: string, event: SessionEvent): void;
	/**
	 * The session left the registry (close, take back, delete): drop its
	 * pending events and withdraw its lines from a still-queued digest.
	 */
	forget(cwd: string, sessionId: string): void;
	/** Resolves when queued edit checks and started deliveries finish (tests). */
	whenIdle(): Promise<void>;
	dispose(): void;
}

interface Conflict {
	readonly type: "conflict";
	readonly peer: string;
	readonly path: string;
	readonly originEpoch: symbol;
	readonly peerEpoch: symbol;
}

type DigestEvent = Exclude<SessionEvent, { type: "file_changed" }> | Conflict;
type Entries = Map<string, Map<string, DigestEvent>>;

interface TouchHistory {
	readonly registeredAt: number;
	readonly epoch: symbol;
	readonly files: Set<string>;
}

interface ProjectState {
	timer: unknown;
	pending: Entries;
	delivered?: { readonly itemId: string; readonly supervisorId: string; readonly entries: Entries } | undefined;
	chain: Promise<void>;
	touches: Map<string, TouchHistory>;
	supervisorId?: string | undefined;
}

export function createSupervisorWaker(deps: SupervisorWakerDeps): SupervisorWaker {
	const debounceMs = deps.debounceMs ?? DEFAULT_WAKE_DEBOUNCE_MS;
	const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
	const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const report = deps.report ?? (() => {});
	const projects = new Map<string, ProjectState>();
	let disposed = false;

	function run(state: ProjectState, operation: () => void | Promise<void>): void {
		state.chain = state.chain.then(() => disposed ? undefined : operation()).catch((error: unknown) => {
			report(`supervisor wake failed: ${error instanceof Error ? error.message : String(error)}`);
		});
	}

	function schedule(cwd: string, state: ProjectState): void {
		if (state.timer !== undefined) clearTimer(state.timer);
		state.timer = setTimer(() => {
			state.timer = undefined;
			run(state, () => flush(cwd, state));
		}, debounceMs);
	}

	function touch(cwd: string, state: ProjectState, event: Extract<SessionEvent, { type: "file_changed" }>): void {
		// Request the registry read now, not after the debounce (or the last
		// wake): store reads are ordered with handover/takeover registry writes.
		const snapshot = deps.registryFor(cwd).then(
			(registry) => ({ registry }), (error: unknown) => ({ error }),
		);
		run(state, async () => {
			const result = await snapshot;
			if (disposed) return;
			if ("error" in result) throw result.error;
			const registry = result.registry;
			if (!registry) return;
			pruneTouches(state, registry);
			const { sessionId, path } = event;
			const worker = registry.supervisorSessionId && managedWorker(registry, sessionId);
			if (!worker) return;
			let history = state.touches.get(sessionId);
			if (!history) {
				history = { registeredAt: worker.registeredAt, epoch: Symbol(), files: new Set() };
				state.touches.set(sessionId, history);
			}
			const seen = history.files.delete(path);
			history.files.add(path);
			if (seen) return; // each pair is reported when its second worker first touches the path
			if (history.files.size > MAX_TOUCHED_FILES) {
				const oldest = history.files.values().next().value;
				if (oldest !== undefined) history.files.delete(oldest);
			}
			let found = false;
			for (const [peer, other] of state.touches) {
				if (peer === sessionId || !other.files.has(path)) continue;
				addEntry(state.pending, sessionId, { type: "conflict", peer, path, originEpoch: history.epoch, peerEpoch: other.epoch });
				found = true;
			}
			if (found) schedule(cwd, state);
		});
	}

	async function flush(cwd: string, state: ProjectState): Promise<void> {
		if (disposed || state.pending.size === 0) return;
		const paused = await deps.paused(cwd);
		if (disposed) return;
		const registry = await deps.registryFor(cwd);
		if (disposed) return;
		if (registry) pruneTouches(state, registry);
		if (!registry?.supervisorSessionId) {
			state.pending = new Map();
			return;
		}
		const supervisorId = registry.supervisorSessionId;
		state.pending = eligibleEntries(state.pending, registry, state.touches);
		if (state.pending.size === 0) return;
		// Pause holds the wake but keeps the digest current.
		if (paused) return;
		const taken = state.pending;
		state.pending = new Map();
		const previous = state.delivered?.supervisorId === supervisorId ? state.delivered : undefined;
		const merged = previous ? mergeEntries(eligibleEntries(previous.entries, registry, state.touches), taken) : undefined;
		const result = await deps.enqueue(supervisorId, renderDigest(taken),
			previous && merged ? { id: previous.itemId, text: renderDigest(merged) } : undefined);
		if (!result) {
			// Supervisor not loaded: keep the events for the next attempt.
			state.pending = mergeEntries(taken, state.pending);
			return;
		}
		state.delivered = { itemId: result.itemId, supervisorId, entries: result.replaced && merged ? merged : taken };
	}

	/**
	 * Ordered on the project chain, so it never interleaves with a flush. The
	 * registry is read when this runs, not when `forget` was called: a session
	 * handed over again in between keeps its new events.
	 */
	async function withdraw(cwd: string, state: ProjectState, sessionId: string): Promise<void> {
		const registry = await deps.registryFor(cwd);
		if (disposed || !registry) return;
		if (Object.hasOwn(registry.sessions, sessionId) && registry.supervisorSessionId !== sessionId) return;
		state.pending.delete(sessionId);
		state.touches.delete(sessionId);
		pruneTouches(state, registry);
		const delivered = state.delivered;
		if (!delivered || delivered.supervisorId !== registry.supervisorSessionId) return;
		const remaining = eligibleEntries(delivered.entries, registry, state.touches);
		const text = remaining.size > 0 ? renderDigest(remaining) : undefined;
		if (text === renderDigest(delivered.entries)) return;
		const rewritten = await deps.rewrite(delivered.supervisorId, delivered.itemId, text);
		if (disposed || state.delivered !== delivered) return;
		// Consumed already: nothing left to withdraw; the next digest starts fresh.
		if (!rewritten || remaining.size === 0) state.delivered = undefined;
		else state.delivered = { ...delivered, entries: remaining };
	}

	function project(cwd: string): ProjectState {
		let state = projects.get(cwd);
		if (!state) {
			state = { timer: undefined, pending: new Map(), chain: Promise.resolve(), touches: new Map() };
			projects.set(cwd, state);
		}
		return state;
	}

	return {
		forget(cwd, sessionId) {
			if (disposed) return;
			cwd = resolve(cwd);
			const state = project(cwd);
			run(state, () => withdraw(cwd, state, sessionId));
		},
		push(cwd, event) {
			if (disposed) return;
			cwd = resolve(cwd);
			const state = project(cwd);
			if (event.type === "file_changed") {
				touch(cwd, state, event);
				return;
			}
			if (event.type === "manual_takeover") {
				const target = state;
				run(target, () => { target.touches.delete(event.sessionId); });
			}
			addEntry(state.pending, event.sessionId, event);
			schedule(cwd, state);
		},
		async whenIdle() {
			await Promise.all([...projects.values()].map((state) => state.chain));
		},
		dispose() {
			disposed = true;
			for (const state of projects.values()) {
				if (state.timer !== undefined) clearTimer(state.timer);
				state.timer = undefined;
			}
			projects.clear();
		},
	};
}

function managedWorker(registry: SupervisorRegistry, id: string) {
	const worker = Object.hasOwn(registry.sessions, id) ? registry.sessions[id] : undefined;
	return id !== registry.supervisorSessionId && worker?.mode === "managed" ? worker : undefined;
}

function pruneTouches(state: ProjectState, registry: SupervisorRegistry): void {
	if (state.supervisorId !== registry.supervisorSessionId) {
		state.touches.clear();
		state.supervisorId = registry.supervisorSessionId;
	}
	for (const [id, history] of state.touches) {
		if (managedWorker(registry, id)?.registeredAt !== history.registeredAt) state.touches.delete(id);
	}
}

function addEntry(entries: Entries, id: string, event: DigestEvent): void {
	let lines = entries.get(id);
	if (!lines) entries.set(id, lines = new Map());
	let key: string = event.type;
	if (event.type === "conflict") {
		key = JSON.stringify([event.peer, event.path]);
		lines.delete(key);
		const conflicts = [...lines.keys()].filter((key) => lines.get(key)?.type === "conflict");
		const oldest = conflicts[0];
		if (oldest !== undefined && conflicts.length >= MAX_CONFLICTS_PER_SESSION) lines.delete(oldest);
	}
	lines.set(key, event);
}

function eligibleEntries(entries: Entries, registry: SupervisorRegistry, touches: ReadonlyMap<string, TouchHistory>): Entries {
	const result: Entries = new Map();
	for (const [id, lines] of entries) {
		if (id === registry.supervisorSessionId || !Object.hasOwn(registry.sessions, id)) continue;
		if (managedWorker(registry, id)) {
			for (const event of lines.values()) {
				if (event.type !== "conflict" || (touches.get(id)?.epoch === event.originEpoch
					&& touches.get(event.peer)?.epoch === event.peerEpoch)) addEntry(result, id, event);
			}
		} else {
			const takeover = lines.get("manual_takeover");
			if (takeover !== undefined) addEntry(result, id, takeover);
		}
		if (result.size >= MAX_DIGEST_SESSIONS) break;
	}
	return result;
}

function mergeEntries(base: Entries, next: Entries): Entries {
	const merged: Entries = new Map([...base].map(([id, lines]) => [id, new Map(lines)]));
	for (const [id, lines] of next) {
		if (!merged.has(id) && merged.size >= MAX_DIGEST_SESSIONS) continue;
		for (const event of lines.values()) addEntry(merged, id, event);
	}
	return merged;
}

function clip(text: string): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > MAX_LINE_TEXT ? `${single.slice(0, MAX_LINE_TEXT)}…` : single;
}

export function describeEvent(event: DigestEvent): string {
	switch (event.type) {
		case "conflict":
			return `file conflict with ${clip(event.peer)}: ${clip(event.path)}`;
		case "settled":
			return `turn settled (${event.stopReason}), ${event.touchedFiles.length} file(s) changed`;
		case "question":
			return "waiting on a question";
		case "error":
			return `${event.source} error: ${clip(event.message)}`;
		case "stalled":
			return `stalled for ${Math.round(event.idleMs / 60_000)} min`;
		case "manual_takeover":
			return "taken over by the user (manual; supervisor ops on it are refused)";
		case "interrupted":
			return "interrupted when Pix quit (the last turn never finished); read it and decide whether it needs a new turn";
		case "missing":
			return "session no longer exists; it stays registered until you close it (outcome failed)";
		case "checklist":
			return event.progress
				? `plan ${event.path}: ${event.progress.completed}/${event.progress.total} done`
				: `plan ${event.path}: progress unreadable`;
	}
}

export function renderDigest(entries: Entries): string {
	const lines = ["[Supervisor digest] Worker session events since the last digest:"];
	for (const [sessionId, events] of entries) {
		lines.push(`- ${sessionId}: ${[...events.values()].map(describeEvent).join("; ")}`);
	}
	lines.push("Use `supervisor status` / `supervisor read` for details before deciding.");
	return lines.join("\n");
}
