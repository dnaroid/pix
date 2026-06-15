import type { Task } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

const DEFAULT_SCOPE_KEY = "__default__";

/**
 * Module-level live state cells, keyed by the active Pi session identity.
 * Pi can keep multiple SDK runtimes/tabs alive in one Node process, so a
 * single module-level todo cell leaks tasks across sessions. Keep the legacy
 * getState()/commitState() API, but make it resolve through the current scope.
 */
let activeScopeKey = DEFAULT_SCOPE_KEY;
const statesByScopeKey = new Map<string, TaskState>([
	[DEFAULT_SCOPE_KEY, { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId }],
]);

function emptyState(): TaskState {
	return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

function normalizedScopeKey(scopeKey: string | undefined): string {
	const trimmed = scopeKey?.trim();
	return trimmed ? trimmed : DEFAULT_SCOPE_KEY;
}

function activeState(): TaskState {
	let state = statesByScopeKey.get(activeScopeKey);
	if (!state) {
		state = emptyState();
		statesByScopeKey.set(activeScopeKey, state);
	}
	return state;
}

export function activateStateScope(scopeKey: string | undefined): void {
	activeScopeKey = normalizedScopeKey(scopeKey);
	activeState();
}

/**
 * Live tasks accessor. Returned `readonly Task[]` so callers cannot mutate the
 * live cell. Consumers must not cast back.
 */
export function getTodos(): readonly Task[] {
	return activeState().tasks;
}

export function getNextId(): number {
	return activeState().nextId;
}

/** Snapshot accessor used by reducer callers to pass canonical state in. */
export function getState(): TaskState {
	return activeState();
}

/**
 * Replay seam. Lifecycle handlers in `index.ts` call this on
 * `session_start` / `session_compact` / `session_tree` after
 * `replayFromBranch` decodes the latest snapshot.
 */
export function replaceState(next: TaskState): void {
	statesByScopeKey.set(activeScopeKey, next);
}

/**
 * Post-reducer commit seam. Tool execute() calls this with the reducer's
 * `state` output to publish the new canonical state to live readers.
 */
export function commitState(next: TaskState): void {
	statesByScopeKey.set(activeScopeKey, next);
}

/**
 * Test-setup reset. Wired into the global `test/setup.ts` `beforeEach` via
 * the existing `__resetState` import path. Name preserved verbatim — see
 * Plan §Decisions §Decision 7.
 */
export function __resetState(): void {
	activeScopeKey = DEFAULT_SCOPE_KEY;
	statesByScopeKey.clear();
	statesByScopeKey.set(DEFAULT_SCOPE_KEY, emptyState());
}
