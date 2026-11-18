/**
 * Project supervisor protocol (decision 0077, phase 1). Dependency-free:
 * Desktop imports it directly.
 *
 * - `pix/supervisor/open`: Desktop asks ACP to open the project's single
 *   supervisor session, creating it on first use.
 * - The `supervisor` agent tool reaches ACP through a correlated request
 *   bridge (`pix_supervisor_request` event, prompt-prefixed response), like
 *   `project_tasks run`. Phase 2 adds mutating ops on managed sessions
 *   (`send`, `cancel`, `close`, `escalate`) behind atomic ACP checks.
 * - `pix/supervisor/mandate`: Desktop reads or patches the saved mandate
 *   (enable, pause/resume, limits, default worker model, policy).
 */
export const PIX_SUPERVISOR_OPEN_METHOD = "pix/supervisor/open";
export const SUPERVISOR_RESPONSE_PREFIX = "\u0000pix:supervisor-response:";
export const SUPERVISOR_TOOL = "supervisor";
export const SUPERVISOR_SESSION_TITLE = "Project supervisor";
/** Session-list `_meta` key marking the project's supervisor session. */
export const PIX_SUPERVISOR_META_KEY = "pix.supervisor";
/**
 * `pix/supervisor/handover`: the user hands a session to the supervisor or
 * takes it back. Handed-over sessions are registered as `managed`; handing
 * over a session the user took back (`manual`) makes it `managed` again.
 */
export const PIX_SUPERVISOR_HANDOVER_METHOD = "pix/supervisor/handover";
/** Session-list `_meta` key carrying the registry mode of a supervised session. */
export const PIX_SUPERVISOR_MANAGED_META_KEY = "pix.supervisorManaged";
export type SupervisedMode = "managed" | "manual";
export const PIX_SUPERVISOR_MANDATE_METHOD = "pix/supervisor/mandate";
/**
 * Worker rules (0077) prepended once to the first supervisor message a
 * managed session receives; launches built later reuse the same text.
 */
export const SUPERVISOR_WORKER_PREAMBLE = "[Supervisor worker rules] The project supervisor manages this session. "
	+ "Do not commit and do not run destructive git commands (checkout, reset, stash, clean, branch switches). "
	+ "Do not reformat or mass-rewrite the repository. Run only the checks relevant to your scope. "
	+ "Other sessions work in the same tree: expect their uncommitted changes and leave them alone. "
	+ "Finish with a final report that has a Verification section (what you checked and how).";
export const SUPERVISOR_OPS = ["status", "read", "start", "send", "answer", "cancel", "close", "reopen", "escalate"] as const;
export const SUPERVISOR_QUESTION_RESOLVED_CHANNEL = "supervisor:question-resolved";
/**
 * `pix/supervisor/start` (ACP -> Desktop): supervisor `start` launches a
 * task, plan or prompt through Desktop's own Run actions. Desktop prepends
 * SUPERVISOR_WORKER_PREAMBLE to the launch prompt and replies once the
 * prompt is dispatched; ACP then registers the session as managed.
 */
export const PIX_SUPERVISOR_START_METHOD = "pix/supervisor/start";
export type SupervisorStartItem =
	| { kind: "task"; taskId: string }
	| { kind: "plan"; path: string }
	| { kind: "prompt"; text: string };
export interface SupervisorStartRequest {
	requestId: string;
	cwd: string;
	sourceSessionId: string;
	item: SupervisorStartItem;
	modelRef?: string;
}
export interface SupervisorStartResponse {
	sessionId: string;
}
export type SupervisorOp = typeof SUPERVISOR_OPS[number];
export const SUPERVISOR_SEND_KINDS = ["rework", "answer", "note"] as const;
export type SupervisorSendKind = typeof SUPERVISOR_SEND_KINDS[number];
export type SupervisorCloseOutcome = "done" | "failed";

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
	| { op: "read"; sessionId: string }
	| SupervisorMutation;

/** Ops that change sessions, tasks or the registry; ACP checks each atomically. */
export type SupervisorMutation =
	| { op: "start"; item: SupervisorStartItem; modelRef?: string }
	| { op: "send"; sessionId: string; text: string; kind: SupervisorSendKind }
	| { op: "answer"; sessionId: string; questionId: string; authority: "mandate" | "user"; rationale: string; selections: SupervisorQuestionSelection[] }
	| { op: "cancel"; sessionId: string }
	| { op: "close"; sessionId: string; outcome: SupervisorCloseOutcome; summary: string }
	| { op: "reopen"; sessionId: string }
	| { op: "escalate"; sessionId?: string; questionId?: string; text: string };

export type SupervisorQuestionSelection =
	| { id: string; choiceValue: string }
	| { id: string; customText: string }
	| { id: string; choiceValues: string[]; customText?: string };

export function isSupervisorMutation(request: SupervisorToolRequest): request is SupervisorMutation {
	return request.op !== "status" && request.op !== "read";
}

/** Supported mandate ranges; ACP clamps saved values into them, Desktop bounds its inputs. */
export const SUPERVISOR_MANDATE_LIMITS = {
	maxConcurrent: { min: 1, max: 20, default: 5 },
	maxReworkRounds: { min: 0, max: 50, default: 5 },
	stalledAfterMinutes: { min: 5, max: 60, default: 15 },
} as const;

/** Mandate fields Desktop may change; ACP clamps them to the supported ranges. */
export interface SupervisorMandatePatch {
	enabled?: boolean;
	paused?: boolean;
	maxConcurrent?: number;
	maxReworkRounds?: number;
	stalledAfterMinutes?: number;
	/** Omit to keep the default; null removes it. */
	workerModelRef?: string | null;
	policy?: string;
}
export interface SupervisorMandateRequest {
	cwd: string;
	/** Omitted: read only. */
	patch?: SupervisorMandatePatch;
}
export interface SupervisorMandateResponse {
	enabled: boolean;
	paused: boolean;
	maxConcurrent: number;
	maxReworkRounds: number;
	stalledAfterMinutes: number;
	workerModelRef?: string;
	policy: string;
	/** Registry sessions the supervisor may act on. */
	managed: number;
	/** Registry sessions the user took over. */
	manual: number;
	/** Managed sessions with a turn in flight or a pending question. */
	running: number;
	/** Rework rounds used, summed over managed sessions. */
	reworkRounds: number;
}

const MAX_CWD = 32_768;
const MAX_SESSION_ID = 128;
export const MAX_SUPERVISOR_TEXT = 20_000;
export const MAX_SUPERVISOR_SUMMARY = 4_000;
export const MAX_SUPERVISOR_POLICY = 20_000;

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

function sessionIdOf(row: Record<string, unknown>, op: string): string {
	if (typeof row.sessionId !== "string" || !row.sessionId.trim() || row.sessionId.length > MAX_SESSION_ID) {
		throw new Error(`supervisor ${op} requires a sessionId from status`);
	}
	return row.sessionId.trim();
}

function textOf(row: Record<string, unknown>, key: string, op: string, max: number): string {
	const value = row[key];
	if (typeof value !== "string" || !value.trim()) throw new Error(`supervisor ${op} requires non-empty ${key}`);
	if (value.length > max) throw new Error(`supervisor ${op} ${key} exceeds ${max} characters`);
	return value;
}

function answerSelections(value: unknown): SupervisorQuestionSelection[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > 5) throw new Error("supervisor answer requires 1–5 selections");
	const selections = value.map((raw): SupervisorQuestionSelection => {
		const row = record(raw, "Invalid supervisor answer selection");
		const id = textOf(row, "id", "answer", MAX_SUPERVISOR_TEXT);
		const allowed = row.choiceValues !== undefined ? ["id", "choiceValues", "customText"]
			: row.choiceValue !== undefined ? ["id", "choiceValue"] : ["id", "customText"];
		if (Object.keys(row).some((key) => !allowed.includes(key))) throw new Error("Invalid supervisor answer selection fields");
		if (row.choiceValues !== undefined) {
			if (!Array.isArray(row.choiceValues) || row.choiceValues.length > 5) throw new Error("Invalid supervisor answer choiceValues");
			const choiceValues = row.choiceValues.map((choiceValue) => textOf({ choiceValue }, "choiceValue", "answer", MAX_SUPERVISOR_TEXT));
			return { id, choiceValues, ...(row.customText === undefined ? {} : { customText: textOf(row, "customText", "answer", MAX_SUPERVISOR_TEXT) }) };
		}
		if (row.choiceValue !== undefined) return { id, choiceValue: textOf(row, "choiceValue", "answer", MAX_SUPERVISOR_TEXT) };
		return { id, customText: textOf(row, "customText", "answer", MAX_SUPERVISOR_TEXT) };
	});
	if (JSON.stringify(selections).length > MAX_SUPERVISOR_TEXT) throw new Error("supervisor answer selections are too large");
	return selections;
}

const MAX_REQUEST_ID = 128;
const MAX_PLAN_PATH = 4_096;
export const MAX_MODEL_REF = 512;

function startItemOf(row: Record<string, unknown>): SupervisorStartItem {
	const given = (["taskId", "planPath", "text"] as const).filter((key) => row[key] !== undefined);
	if (given.length !== 1) throw new Error("supervisor start needs exactly one of taskId, planPath or text");
	if (row.taskId !== undefined) {
		if (typeof row.taskId !== "string" || !row.taskId.trim() || row.taskId.length > MAX_SESSION_ID) throw new Error("Invalid supervisor start taskId");
		return { kind: "task", taskId: row.taskId.trim() };
	}
	if (row.planPath !== undefined) {
		const path = row.planPath;
		if (typeof path !== "string" || !path.startsWith(".pi/plans/") || !path.endsWith(".md") || path.length > MAX_PLAN_PATH
			|| path.split("/").includes("..")) throw new Error("supervisor start planPath must be a saved plan under .pi/plans/");
		return { kind: "plan", path };
	}
	return { kind: "prompt", text: textOf(row, "text", "start", MAX_SUPERVISOR_TEXT) };
}

function modelRefOf(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim() || value.length > MAX_MODEL_REF || !value.includes("/")) {
		throw new Error("supervisor start modelRef must be provider/model[:thinking]");
	}
	return value.trim();
}

/** Desktop side: validate ACP's launch request before running anything. */
export function parseSupervisorStartRequest(value: unknown): SupervisorStartRequest {
	const row = record(value, "Invalid supervisor start request");
	const { cwd } = parseSupervisorOpenRequest({ cwd: row.cwd });
	for (const key of ["requestId", "sourceSessionId"] as const) {
		if (typeof row[key] !== "string" || !row[key] || row[key].length > MAX_REQUEST_ID) throw new Error("Invalid supervisor start request");
	}
	const item = record(row.item, "Invalid supervisor start item");
	const parsed = startItemOf(item.kind === "task" ? { taskId: item.taskId } : item.kind === "plan" ? { planPath: item.path }
		: item.kind === "prompt" ? { text: item.text } : {});
	const modelRef = modelRefOf(row.modelRef);
	return { requestId: row.requestId as string, cwd, sourceSessionId: row.sourceSessionId as string, item: parsed, ...(modelRef ? { modelRef } : {}) };
}

export function parseSupervisorStartResponse(value: unknown): SupervisorStartResponse {
	const row = record(value, "Desktop returned no launch receipt; check status before retrying");
	if (typeof row.sessionId !== "string" || !row.sessionId || row.sessionId.length > MAX_SESSION_ID) {
		throw new Error("Invalid launch receipt; check status before retrying");
	}
	return { sessionId: row.sessionId };
}

export function parseSupervisorToolRequest(value: unknown): SupervisorToolRequest {
	const row = record(value, "Invalid supervisor request");
	switch (row.op) {
		case "start": {
			const modelRef = modelRefOf(row.modelRef);
			return { op: "start", item: startItemOf(row), ...(modelRef ? { modelRef } : {}) };
		}
		case "send": {
			const kind = row.kind ?? "note";
			if (!SUPERVISOR_SEND_KINDS.includes(kind as SupervisorSendKind)) throw new Error("supervisor send kind must be rework, answer or note");
			return { op: "send", sessionId: sessionIdOf(row, "send"), text: textOf(row, "text", "send", MAX_SUPERVISOR_TEXT), kind: kind as SupervisorSendKind };
		}
		case "answer": {
			if (row.authority !== "mandate" && row.authority !== "user") throw new Error("supervisor answer authority must be mandate or user");
			return { op: "answer", sessionId: sessionIdOf(row, "answer"), questionId: textOf(row, "questionId", "answer", MAX_REQUEST_ID),
				authority: row.authority, rationale: textOf(row, "rationale", "answer", MAX_SUPERVISOR_SUMMARY), selections: answerSelections(row.selections) };
		}
		case "cancel":
			return { op: "cancel", sessionId: sessionIdOf(row, "cancel") };
		case "close": {
			if (row.outcome !== "done" && row.outcome !== "failed") throw new Error("supervisor close outcome must be done or failed");
			return { op: "close", sessionId: sessionIdOf(row, "close"), outcome: row.outcome,
				summary: textOf(row, "summary", "close", MAX_SUPERVISOR_SUMMARY) };
		}
		case "reopen":
			return { op: "reopen", sessionId: sessionIdOf(row, "reopen") };
		case "escalate":
			return { op: "escalate", ...(row.sessionId === undefined ? {} : { sessionId: sessionIdOf(row, "escalate") }),
				...(row.questionId === undefined ? {} : { sessionId: sessionIdOf(row, "escalate"), questionId: textOf(row, "questionId", "escalate", MAX_REQUEST_ID) }),
				text: textOf(row, "text", "escalate", MAX_SUPERVISOR_SUMMARY) };
	}
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

export function parseSupervisorMandateRequest(value: unknown): SupervisorMandateRequest {
	const row = record(value, "Invalid supervisor mandate request");
	const { cwd } = parseSupervisorOpenRequest({ cwd: row.cwd });
	if (row.patch === undefined) return { cwd };
	const raw = record(row.patch, "Invalid supervisor mandate patch");
	const patch: SupervisorMandatePatch = {};
	for (const key of ["enabled", "paused"] as const) {
		if (raw[key] === undefined) continue;
		if (typeof raw[key] !== "boolean") throw new Error(`Invalid supervisor mandate ${key}`);
		patch[key] = raw[key];
	}
	for (const key of ["maxConcurrent", "maxReworkRounds", "stalledAfterMinutes"] as const) {
		if (raw[key] === undefined) continue;
		if (typeof raw[key] !== "number" || !Number.isInteger(raw[key])) throw new Error(`Invalid supervisor mandate ${key}`);
		patch[key] = raw[key];
	}
	if (raw.policy !== undefined) {
		if (typeof raw.policy !== "string" || raw.policy.length > MAX_SUPERVISOR_POLICY) throw new Error("Invalid supervisor mandate policy");
		patch.policy = raw.policy;
	}
	if (raw.workerModelRef !== undefined) {
		const ref = raw.workerModelRef;
		if (ref === null) patch.workerModelRef = null;
		else {
			if (typeof ref !== "string" || ref.length > MAX_MODEL_REF || !/^[^/\s]+\/\S+$/.test(ref.trim())) {
				throw new Error("Invalid supervisor mandate workerModelRef: expected provider/model[:thinking] or null");
			}
			patch.workerModelRef = ref.trim();
		}
	}
	return { cwd, patch };
}

export function parseSupervisorMandateResponse(value: unknown): SupervisorMandateResponse {
	const row = record(value, "Invalid supervisor mandate response");
	const int = (key: string) => {
		const field = row[key];
		if (typeof field !== "number" || !Number.isInteger(field) || field < 0) throw new Error(`Invalid supervisor mandate response ${key}`);
		return field;
	};
	if (typeof row.enabled !== "boolean" || typeof row.paused !== "boolean" || typeof row.policy !== "string") {
		throw new Error("Invalid supervisor mandate response");
	}
	// Older mandates may contain a manually saved value; display it so it can be edited or cleared.
	const ref = row.workerModelRef;
	if (ref !== undefined && (typeof ref !== "string" || ref.length === 0 || ref.length > MAX_MODEL_REF)) {
		throw new Error("Invalid supervisor mandate response workerModelRef");
	}
	return {
		enabled: row.enabled, paused: row.paused,
		maxConcurrent: int("maxConcurrent"), maxReworkRounds: int("maxReworkRounds"), stalledAfterMinutes: int("stalledAfterMinutes"),
		policy: row.policy, managed: int("managed"), manual: int("manual"), running: int("running"),
		...(ref === undefined ? {} : { workerModelRef: ref }),
		reworkRounds: int("reworkRounds"),
	};
}
