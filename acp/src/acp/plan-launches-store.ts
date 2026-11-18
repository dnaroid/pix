import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalPlanFileName, canonicalRegistryEntryName } from "../registry/model.js";
import {
	boundPlanLaunches,
	parsePlanLaunches,
	type PlanLaunch,
	type PlanLaunches,
	type PlanLaunchesRequest,
} from "./plan-launches-contract.js";

/**
 * Durable plan-launch records in `<project>/.pi/plan-launches.json`
 * (decision 0077, phase 0). ACP owns the file so agents (the project
 * supervisor) and Desktop see the same launches. Mutations of one project are
 * serialized in arrival order; writes are atomic (temp file + rename). The
 * store never creates `.pi/`: a launch always targets an existing saved plan.
 */
export const PLAN_LAUNCHES_FILE = ".pi/plan-launches.json";
const PLANS_PREFIX = ".pi/plans/";

/** Same rule as Desktop `isCanonicalProjectPlanPath` and the Registry plan filter. */
export function isCanonicalPlanLaunchPath(path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	if (!normalized.startsWith(PLANS_PREFIX)) return false;
	const segments = normalized.slice(PLANS_PREFIX.length).split("/");
	const file = segments.at(-1) ?? "";
	return segments.every((segment) => segment !== "." && segment !== ".." && canonicalRegistryEntryName(segment))
		&& canonicalPlanFileName(file);
}

export interface PlanLaunchesStoreOptions {
	readonly now?: () => number;
}

export interface PlanLaunchesStore {
	handle(request: PlanLaunchesRequest): Promise<{ launches: PlanLaunches }>;
}

export function createPlanLaunchesStore(options: PlanLaunchesStoreOptions = {}): PlanLaunchesStore {
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

	async function read(cwd: string): Promise<Record<string, PlanLaunch>> {
		let raw: string;
		try {
			raw = await readFile(join(cwd, PLAN_LAUNCHES_FILE), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			// Presentation metadata: a corrupt file is replaced by the next write.
			return {};
		}
		return parsePlanLaunches(parsed, isCanonicalPlanLaunchPath);
	}

	async function write(cwd: string, launches: Record<string, PlanLaunch>): Promise<void> {
		const path = join(cwd, PLAN_LAUNCHES_FILE);
		const temp = join(cwd, ".pi", `.plan-launches.json.${randomUUID()}.tmp`);
		try {
			await writeFile(temp, `${JSON.stringify(launches)}\n`, "utf8");
			await rename(temp, path);
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {});
			throw error;
		}
	}

	async function apply(request: PlanLaunchesRequest): Promise<{ launches: PlanLaunches }> {
		const current = await read(request.cwd);
		switch (request.action) {
			case "list":
				return { launches: current };
			case "record": {
				if (!isCanonicalPlanLaunchPath(request.path)) throw new Error(`Not a saved plan path: ${request.path}`);
				const next = boundPlanLaunches({ ...current, [request.sessionId]: { path: request.path, launchedAt: now() } });
				await write(request.cwd, next);
				return { launches: next };
			}
			case "settle": {
				const launch = current[request.sessionId];
				// Sessions that were not launched from a plan are ignored.
				if (!launch) return { launches: current };
				const next = { ...current, [request.sessionId]: { ...launch, outcome: request.outcome, settledAt: now() } };
				await write(request.cwd, next);
				return { launches: next };
			}
			case "import": {
				const imported = parsePlanLaunches(request.launches, isCanonicalPlanLaunchPath);
				const added = Object.keys(imported).filter((sessionId) => !current[sessionId]);
				if (added.length === 0) return { launches: current };
				const next = boundPlanLaunches({ ...imported, ...current });
				await write(request.cwd, next);
				return { launches: next };
			}
		}
	}

	return {
		handle: (request) => serialized(request.cwd, () => apply(request)),
	};
}
