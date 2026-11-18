/**
 * ACP-owned record of which saved plan launched which session (decision 0077,
 * phase 0). Dependency-free: Desktop imports it directly.
 *
 * Every response is the complete, bounded snapshot of one project's launches,
 * so a client can replace its cache with the newest response it issued.
 */
export const PIX_PLAN_LAUNCHES_METHOD = "pix/plans/launches";
export const PLAN_LAUNCH_LIMIT = 50;

/** How the last prompt of a plan-launched session ended. */
export type PlanLaunchOutcome = "completed" | "cancelled" | "failed";
/** Which saved plan a session was launched from. */
export interface PlanLaunch {
	path: string;
	launchedAt: number;
	outcome?: PlanLaunchOutcome;
	settledAt?: number;
}
export type PlanLaunches = Readonly<Record<string, PlanLaunch>>;

export type PlanLaunchesRequest = { cwd: string } & (
	| { action: "list" }
	| { action: "record"; sessionId: string; path: string }
	| { action: "settle"; sessionId: string; outcome: PlanLaunchOutcome }
	/** One-time migration of legacy Desktop records; existing entries win. */
	| { action: "import"; launches: PlanLaunches }
);
export interface PlanLaunchesResponse {
	launches: PlanLaunches;
}

const OUTCOMES: readonly PlanLaunchOutcome[] = ["completed", "cancelled", "failed"];
const MAX_SESSION_ID = 128;
const MAX_PATH = 4_096;
const MAX_CWD = 32_768;

export function isPlanLaunchOutcome(value: unknown): value is PlanLaunchOutcome {
	return OUTCOMES.includes(value as PlanLaunchOutcome);
}

function isSessionId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_SESSION_ID;
}

function isPlanPathShape(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_PATH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lenient parse of a launch map: invalid entries are dropped, and a malformed
 * outcome only loses the status, never the launch itself. The result is bounded.
 */
export function parsePlanLaunches(value: unknown, isPlanPath: (path: string) => boolean = () => true): Record<string, PlanLaunch> {
	if (!isRecord(value)) return {};
	const launches: Record<string, PlanLaunch> = {};
	for (const [sessionId, entry] of Object.entries(value)) {
		if (!isSessionId(sessionId) || !isRecord(entry)) continue;
		const { path, launchedAt, outcome, settledAt } = entry;
		if (!isPlanPathShape(path) || !isPlanPath(path)) continue;
		if (typeof launchedAt !== "number" || !Number.isFinite(launchedAt)) continue;
		const launch: PlanLaunch = { path, launchedAt };
		if (isPlanLaunchOutcome(outcome) && typeof settledAt === "number" && Number.isFinite(settledAt)) {
			launch.outcome = outcome;
			launch.settledAt = settledAt;
		}
		launches[sessionId] = launch;
	}
	return boundPlanLaunches(launches);
}

/** Keeps only the newest {@link PLAN_LAUNCH_LIMIT} launches. */
export function boundPlanLaunches<T extends Record<string, PlanLaunch>>(launches: T): T {
	const entries = Object.entries(launches);
	if (entries.length <= PLAN_LAUNCH_LIMIT) return launches;
	return Object.fromEntries(
		entries.sort((left, right) => right[1].launchedAt - left[1].launchedAt).slice(0, PLAN_LAUNCH_LIMIT),
	) as T;
}

export function parsePlanLaunchesRequest(value: unknown): PlanLaunchesRequest {
	if (!isRecord(value) || typeof value.cwd !== "string" || !value.cwd.trim() || value.cwd.length > MAX_CWD) {
		throw new Error("plan launches request requires a non-empty cwd");
	}
	const cwd = value.cwd;
	switch (value.action) {
		case "list":
			return { cwd, action: "list" };
		case "record":
			if (!isSessionId(value.sessionId) || !isPlanPathShape(value.path)) {
				throw new Error("plan launch record requires sessionId and path");
			}
			return { cwd, action: "record", sessionId: value.sessionId, path: value.path };
		case "settle":
			if (!isSessionId(value.sessionId) || !isPlanLaunchOutcome(value.outcome)) {
				throw new Error("plan launch settle requires sessionId and outcome completed|cancelled|failed");
			}
			return { cwd, action: "settle", sessionId: value.sessionId, outcome: value.outcome };
		case "import":
			if (!isRecord(value.launches)) throw new Error("plan launch import requires a launches object");
			return { cwd, action: "import", launches: parsePlanLaunches(value.launches) };
		default:
			throw new Error("plan launches action must be list, record, settle, or import");
	}
}

export function parsePlanLaunchesResponse(value: unknown): PlanLaunches {
	if (!isRecord(value) || !isRecord(value.launches)) throw new Error(`${PIX_PLAN_LAUNCHES_METHOD} returned an invalid response`);
	return parsePlanLaunches(value.launches);
}
