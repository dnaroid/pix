/**
 * Project supervisor protocol (decision 0077, phase 1). Dependency-free:
 * Desktop imports it directly.
 *
 * - `pix/supervisor/open`: Desktop asks ACP to open the project's single
 *   supervisor session, creating it on first use.
 * - The `supervisor` agent tool reaches ACP through a correlated request
 *   bridge (`pix_supervisor_request` event, prompt-prefixed response), like
 *   `project_tasks run`. Only read-only operations exist in this phase.
 */
export const PIX_SUPERVISOR_OPEN_METHOD = "pix/supervisor/open";
export const SUPERVISOR_RESPONSE_PREFIX = "\u0000pix:supervisor-response:";
export const SUPERVISOR_TOOL = "supervisor";
export const SUPERVISOR_SESSION_TITLE = "Project supervisor";
/** Session-list `_meta` key marking the project's supervisor session. */
export const PIX_SUPERVISOR_META_KEY = "pix.supervisor";
/**
 * `pix/supervisor/handover`: the user hands a session to the supervisor or
 * takes it back. Handed-over sessions are registered as `manual`.
 */
export const PIX_SUPERVISOR_HANDOVER_METHOD = "pix/supervisor/handover";
/** Session-list `_meta` key carrying the registry mode of a supervised session. */
export const PIX_SUPERVISOR_MANAGED_META_KEY = "pix.supervisorManaged";
export type SupervisedMode = "managed" | "manual";
export const SUPERVISOR_OPS = ["status", "read"] as const;
export type SupervisorOp = typeof SUPERVISOR_OPS[number];

export interface SupervisorOpenRequest {
	cwd: string;
}
export interface SupervisorOpenResponse {
	sessionId: string;
	created: boolean;
}

export interface SupervisorHandoverRequest {
	cwd: string;
	sessionId: string;
	/** true = hand over, false = take back. */
	supervised: boolean;
}
export interface SupervisorHandoverResponse {
	supervised: boolean;
}

export type SupervisorToolRequest =
	| { op: "status" }
	| { op: "read"; sessionId: string };

const MAX_CWD = 32_768;
const MAX_SESSION_ID = 128;

function record(value: unknown, message: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
	return value as Record<string, unknown>;
}

export function parseSupervisorOpenRequest(value: unknown): SupervisorOpenRequest {
	const row = record(value, "Invalid supervisor open request");
	if (typeof row.cwd !== "string" || !row.cwd.trim() || row.cwd.length > MAX_CWD) throw new Error("Invalid supervisor workspace");
	return { cwd: row.cwd };
}

export function parseSupervisorOpenResponse(value: unknown): SupervisorOpenResponse {
	const row = record(value, "Invalid supervisor open response");
	if (typeof row.sessionId !== "string" || !row.sessionId || row.sessionId.length > MAX_SESSION_ID
		|| typeof row.created !== "boolean") throw new Error("Invalid supervisor open response");
	return { sessionId: row.sessionId, created: row.created };
}

export function parseSupervisorHandoverRequest(value: unknown): SupervisorHandoverRequest {
	const row = record(value, "Invalid supervisor handover request");
	const { cwd } = parseSupervisorOpenRequest({ cwd: row.cwd });
	if (typeof row.sessionId !== "string" || !row.sessionId || row.sessionId.length > MAX_SESSION_ID) {
		throw new Error("Invalid supervisor handover session");
	}
	if (typeof row.supervised !== "boolean") throw new Error("Invalid supervisor handover flag");
	return { cwd, sessionId: row.sessionId, supervised: row.supervised };
}

export function parseSupervisorHandoverResponse(value: unknown): SupervisorHandoverResponse {
	const row = record(value, "Invalid supervisor handover response");
	if (typeof row.supervised !== "boolean") throw new Error("Invalid supervisor handover response");
	return { supervised: row.supervised };
}

export function parseSupervisorToolRequest(value: unknown): SupervisorToolRequest {
	const row = record(value, "Invalid supervisor request");
	if (row.op === "status") {
		if (row.sessionId !== undefined) throw new Error("supervisor status accepts no sessionId");
		return { op: "status" };
	}
	if (row.op === "read") {
		if (typeof row.sessionId !== "string" || !row.sessionId.trim() || row.sessionId.length > MAX_SESSION_ID) {
			throw new Error("supervisor read requires a sessionId from status");
		}
		return { op: "read", sessionId: row.sessionId.trim() };
	}
	throw new Error(`Unknown supervisor op; use ${SUPERVISOR_OPS.join(" or ")}`);
}
