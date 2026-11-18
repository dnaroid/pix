// Debounced supervisor wakes (0077, phase 1). Worker lifecycle events are
// coalesced per project into one digest. The digest is delivered as a single
// auto-queued message in the supervisor session: an idle supervisor runs it
// as one wake turn, and a busy one gets it after its current turn. While that
// message is still queued, later events rewrite it instead of adding more.
import type { SessionEvent } from "./session-events.js";

export const DEFAULT_WAKE_DEBOUNCE_MS = 5_000;
const MAX_DIGEST_SESSIONS = 20;
const MAX_LINE_TEXT = 200;

export interface SupervisorWakerDeps {
	readonly debounceMs?: number | undefined;
	readonly setTimer?: (callback: () => void, ms: number) => unknown;
	readonly clearTimer?: (handle: unknown) => void;
	supervisorFor(cwd: string): Promise<string | undefined>;
	paused(cwd: string): Promise<boolean>;
	/**
	 * Rewrite queued item `replace.id` with `replace.text` when it is still
	 * queued, otherwise queue `text` as a new item. Undefined when the
	 * supervisor is not loaded.
	 */
	enqueue(supervisorSessionId: string, text: string, replace?: { readonly id: string; readonly text: string }):
		Promise<{ readonly itemId: string; readonly replaced: boolean } | undefined>;
	report?(message: string): void;
}

export interface SupervisorWaker {
	push(cwd: string, event: SessionEvent): void;
	/** Resolves when scheduled deliveries have finished (tests). */
	whenIdle(): Promise<void>;
	dispose(): void;
}

type Entries = Map<string, Map<SessionEvent["type"], string>>;

interface ProjectState {
	timer: unknown;
	pending: Entries;
	delivered?: { readonly itemId: string; readonly supervisorId: string; readonly entries: Entries };
	chain: Promise<void>;
}

export function createSupervisorWaker(deps: SupervisorWakerDeps): SupervisorWaker {
	const debounceMs = deps.debounceMs ?? DEFAULT_WAKE_DEBOUNCE_MS;
	const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
	const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const report = deps.report ?? (() => {});
	const projects = new Map<string, ProjectState>();
	let disposed = false;

	function schedule(cwd: string, state: ProjectState): void {
		if (state.timer !== undefined) clearTimer(state.timer);
		state.timer = setTimer(() => {
			state.timer = undefined;
			if (disposed) return;
			state.chain = state.chain.then(() => flush(cwd, state)).catch((error: unknown) => {
				report(`supervisor wake failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		}, debounceMs);
	}

	async function flush(cwd: string, state: ProjectState): Promise<void> {
		if (disposed || state.pending.size === 0) return;
		const supervisorId = await deps.supervisorFor(cwd);
		if (disposed) return;
		if (!supervisorId) {
			state.pending = new Map();
			return;
		}
		state.pending.delete(supervisorId);
		if (state.pending.size === 0) return;
		// Pause holds the wake but keeps the digest current.
		if (await deps.paused(cwd) || disposed) return;
		const taken = state.pending;
		state.pending = new Map();
		const previous = state.delivered?.supervisorId === supervisorId ? state.delivered : undefined;
		const merged = previous ? mergeEntries(previous.entries, taken) : undefined;
		const result = await deps.enqueue(supervisorId, renderDigest(taken),
			previous && merged ? { id: previous.itemId, text: renderDigest(merged) } : undefined);
		if (!result) {
			// Supervisor not loaded: keep the events for the next attempt.
			state.pending = mergeEntries(taken, state.pending);
			return;
		}
		state.delivered = { itemId: result.itemId, supervisorId, entries: result.replaced && merged ? merged : taken };
	}

	return {
		push(cwd, event) {
			if (disposed) return;
			let state = projects.get(cwd);
			if (!state) {
				state = { timer: undefined, pending: new Map(), chain: Promise.resolve() };
				projects.set(cwd, state);
			}
			let lines = state.pending.get(event.sessionId);
			if (!lines) {
				if (state.pending.size >= MAX_DIGEST_SESSIONS) return;
				lines = new Map();
				state.pending.set(event.sessionId, lines);
			}
			lines.set(event.type, describeEvent(event));
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

function mergeEntries(base: Entries, next: Entries): Entries {
	const merged: Entries = new Map([...base].map(([id, lines]) => [id, new Map(lines)]));
	for (const [id, lines] of next) {
		const target = merged.get(id) ?? new Map();
		for (const [type, line] of lines) target.set(type, line);
		if (!merged.has(id) && merged.size >= MAX_DIGEST_SESSIONS) continue;
		merged.set(id, target);
	}
	return merged;
}

function clip(text: string): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > MAX_LINE_TEXT ? `${single.slice(0, MAX_LINE_TEXT)}…` : single;
}

export function describeEvent(event: SessionEvent): string {
	switch (event.type) {
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
		lines.push(`- ${sessionId}: ${[...events.values()].join("; ")}`);
	}
	lines.push("Use `supervisor status` / `supervisor read` for details before deciding.");
	return lines.join("\n");
}
