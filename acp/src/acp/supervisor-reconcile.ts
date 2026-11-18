import type { SessionEvent } from "./session-events.js";
import type { SupervisorStore } from "./supervisor-store.js";

/**
 * Startup reconciliation of the supervisor registry (decision 0077): once
 * per project and ACP lifetime, when the supervisor runtime starts, every
 * registered session is checked against the saved session state. A session
 * whose saved last turn never finished (Pix quit mid-turn) becomes an
 * `interrupted` event; a session that no longer exists becomes `missing`.
 * Nothing is resumed, replaced or unregistered automatically.
 */
export interface SupervisorReconcileDeps {
	readonly store: SupervisorStore;
	/** Saved session record, or undefined when the session no longer exists in this project. */
	record(cwd: string, sessionId: string): Promise<{ readonly piSessionPath: string } | undefined>;
	/** Messages on the saved transcript's current branch, oldest first. */
	messages(piSessionPath: string): Promise<readonly unknown[]>;
	/** A turn is in flight in this ACP process: the session is live, not interrupted. */
	running(sessionId: string): boolean;
	emit(event: SessionEvent): void;
	report(message: string): void;
}

export interface SupervisorReconcileResult {
	readonly interrupted: readonly string[];
	readonly missing: readonly string[];
}

/** The saved branch ends inside a turn: a prompt or tool result with no final assistant message. */
export function turnInterrupted(messages: readonly unknown[]): boolean {
	const last = messages.at(-1);
	if (!last || typeof last !== "object") return false;
	const message = last as Record<string, unknown>;
	if (message["role"] === "user" || message["role"] === "toolResult") return true;
	return message["role"] === "assistant" && message["stopReason"] === "toolUse";
}

export async function reconcileSupervisor(cwd: string, deps: SupervisorReconcileDeps): Promise<SupervisorReconcileResult> {
	const registry = await deps.store.readRegistry(cwd);
	const interrupted: string[] = [];
	const missing: string[] = [];
	for (const sessionId of Object.keys(registry.sessions)) {
		if (deps.running(sessionId)) continue;
		const record = await deps.record(cwd, sessionId);
		if (!record) {
			missing.push(sessionId);
			continue;
		}
		try {
			if (turnInterrupted(await deps.messages(record.piSessionPath))) interrupted.push(sessionId);
		} catch (error) {
			deps.report(`supervisor reconcile could not read ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (interrupted.length === 0 && missing.length === 0) return { interrupted, missing };
	await deps.store.appendLedger(cwd, { kind: "reconciled", detail: { interrupted, missing } });
	const at = Date.now();
	for (const sessionId of interrupted) deps.emit({ type: "interrupted", sessionId, at });
	for (const sessionId of missing) deps.emit({ type: "missing", sessionId, at });
	return { interrupted, missing };
}
