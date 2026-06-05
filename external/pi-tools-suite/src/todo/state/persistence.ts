import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Task } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

export const TODO_PLAN_RELATIVE_PATH = join(".pi", "todo-plan.json");

interface PersistedTodoPlan {
	version: 1;
	enabled: true;
	updatedAt: string;
	nextId: number;
	tasks: Task[];
}

export interface PersistedPlanLoadResult {
	path: string;
	state: TaskState;
}

function cloneTask(task: Task): Task {
	return {
		...task,
		blockedBy: task.blockedBy ? [...task.blockedBy] : undefined,
		metadata: task.metadata ? { ...task.metadata } : undefined,
	};
}

function normalizeCwd(cwd: string | undefined): string {
	return cwd && cwd.trim() ? cwd : process.cwd();
}

export function getTodoPlanPath(cwd: string | undefined): string {
	return join(normalizeCwd(cwd), TODO_PLAN_RELATIVE_PATH);
}

export function isPersistenceEnabled(cwd: string | undefined): boolean {
	return existsSync(getTodoPlanPath(cwd));
}

export function loadPersistedPlan(cwd: string | undefined): PersistedPlanLoadResult | undefined {
	const path = getTodoPlanPath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedTodoPlan>;
		if (raw.version !== 1 || raw.enabled !== true || !Array.isArray(raw.tasks)) return undefined;
		return {
			path,
			state: {
				tasks: raw.tasks.map(cloneTask),
				nextId: typeof raw.nextId === "number" && Number.isFinite(raw.nextId) ? raw.nextId : EMPTY_STATE.nextId,
			},
		};
	} catch (err) {
		console.warn(`rpiv-todo: failed to load persisted plan from ${path} — ${(err as Error).message}`);
		return undefined;
	}
}

export function savePersistedPlan(cwd: string | undefined, state: TaskState): string {
	const path = getTodoPlanPath(cwd);
	mkdirSync(dirname(path), { recursive: true });
	const payload: PersistedTodoPlan = {
		version: 1,
		enabled: true,
		updatedAt: new Date().toISOString(),
		nextId: state.nextId,
		tasks: state.tasks.map(cloneTask),
	};
	const tmpPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	renameSync(tmpPath, path);
	return path;
}

export function disablePersistence(cwd: string | undefined): string {
	const path = getTodoPlanPath(cwd);
	rmSync(path, { force: true });
	return path;
}

export function isPlanComplete(state: TaskState): boolean {
	const visible = state.tasks.filter((task) => task.status !== "deleted");
	return visible.length === 0 || visible.every((task) => task.status === "completed");
}

export function syncPersistedPlan(cwd: string | undefined, state: TaskState): { path: string; completed: boolean } | undefined {
	if (!isPersistenceEnabled(cwd)) return undefined;
	if (isPlanComplete(state)) {
		return { path: disablePersistence(cwd), completed: true };
	}
	return { path: savePersistedPlan(cwd, state), completed: false };
}
