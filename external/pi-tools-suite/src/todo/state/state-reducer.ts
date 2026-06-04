import type { Task, TaskAction, TaskMutationParams, TaskPriority, TaskStatus, TodoThinkingLevel } from "../tool/types.js";
import { isTransitionValid } from "./invariants.js";
import type { TaskState } from "./state.js";
import { detectCycle } from "./task-graph.js";

export type Op =
	| { kind: "create"; taskId: number; replacedCount?: number }
	| { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus }
	| { kind: "batch_create"; ids: number[]; replacedCount?: number }
	| { kind: "batch_update"; ids: number[] }
	| { kind: "delete"; id: number; subject: string }
	| { kind: "list"; statusFilter?: TaskStatus; priorityFilter?: TaskPriority; tagFilter?: string; blockedOnly: boolean; includeDeleted: boolean }
	| { kind: "get"; task: Task }
	| { kind: "clear"; count: number }
	| { kind: "export"; format: "json" | "markdown"; statusFilter?: TaskStatus; priorityFilter?: TaskPriority; tagFilter?: string; blockedOnly: boolean; includeDeleted: boolean }
	| { kind: "import"; count: number; replaced: boolean }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

function uniqueNumbers(values: number[] | undefined): number[] {
	return [...new Set((values ?? []).filter((value) => Number.isFinite(value)))];
}

function normalizeTags(tags: string[] | undefined): string[] | undefined {
	const normalized = [...new Set((tags ?? []).map((tag) => tag.trim()).filter(Boolean))];
	return normalized.length ? normalized : undefined;
}

function isTodoThinkingLevel(value: unknown): value is TodoThinkingLevel {
	return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function findTask(state: TaskState, id: number): Task | undefined {
	return state.tasks.find((task) => task.id === id);
}

function validateLiveReference(state: TaskState, field: string, id: number): string | undefined {
	const task = findTask(state, id);
	if (!task) return `${field}: #${id} not found`;
	if (task.status === "deleted") return `${field}: #${id} is deleted`;
	return undefined;
}

function wouldCreateParentCycle(tasks: readonly Task[], id: number, parentId: number): boolean {
	let cursor: number | undefined = parentId;
	const seen = new Set<number>();
	while (cursor !== undefined) {
		if (cursor === id) return true;
		if (seen.has(cursor)) return true;
		seen.add(cursor);
		cursor = tasks.find((task) => task.id === cursor)?.parentId;
	}
	return false;
}

function validateImportedTasks(tasks: readonly Task[]): string | undefined {
	const ids = new Set<number>();
	for (const task of tasks) {
		if (!Number.isFinite(task.id) || task.id <= 0) return `invalid task id: ${task.id}`;
		if (ids.has(task.id)) return `duplicate task id: #${task.id}`;
		if (!task.subject?.trim()) return `subject required for #${task.id}`;
		ids.add(task.id);
	}
	for (const task of tasks) {
		if (task.parentId !== undefined && !ids.has(task.parentId)) return `parentId: #${task.parentId} not found`;
		for (const dep of task.blockedBy ?? []) {
			if (!ids.has(dep)) return `blockedBy: #${dep} not found`;
		}
		if (task.parentId !== undefined && wouldCreateParentCycle(tasks, task.id, task.parentId)) {
			return `parentId would create a cycle for #${task.id}`;
		}
		if (detectCycle(tasks, task.id, task.blockedBy ?? [])) return `blockedBy would create a cycle for #${task.id}`;
	}
	return undefined;
}

function coerceTask(value: unknown, fallbackId: number): Task | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	const subject = typeof v.subject === "string" ? v.subject.trim() : "";
	if (!subject) return undefined;
	const status = v.status === "in_progress" || v.status === "deferred" || v.status === "completed" || v.status === "deleted" ? v.status : "pending";
	const task: Task = { id: typeof v.id === "number" && Number.isFinite(v.id) ? v.id : fallbackId, subject, status };
	if (typeof v.description === "string" && v.description) task.description = v.description;
	if (typeof v.activeForm === "string" && v.activeForm) task.activeForm = v.activeForm;
	if (v.priority === "low" || v.priority === "medium" || v.priority === "high" || v.priority === "urgent") task.priority = v.priority;
	if (isTodoThinkingLevel(v.thinking)) task.thinking = v.thinking;
	if (typeof v.parentId === "number" && Number.isFinite(v.parentId)) task.parentId = v.parentId;
	const blockedBy = Array.isArray(v.blockedBy) ? uniqueNumbers(v.blockedBy as number[]) : undefined;
	if (blockedBy?.length) task.blockedBy = blockedBy;
	const tags = Array.isArray(v.tags) ? normalizeTags(v.tags.filter((tag): tag is string => typeof tag === "string")) : undefined;
	if (tags) task.tags = tags;
	if (typeof v.owner === "string" && v.owner) task.owner = v.owner;
	if (v.metadata && typeof v.metadata === "object" && !Array.isArray(v.metadata)) task.metadata = { ...(v.metadata as Record<string, unknown>) };
	return task;
}

function parseJsonImport(content: string): Task[] | undefined {
	const parsed = JSON.parse(content) as unknown;
	let rawTasks: unknown[] | undefined;
	if (Array.isArray(parsed)) {
		rawTasks = parsed;
	} else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { tasks?: unknown }).tasks)) {
		rawTasks = (parsed as { tasks: unknown[] }).tasks;
	}
	if (!rawTasks) return undefined;
	return rawTasks.map((value, index) => coerceTask(value, index + 1)).filter((task): task is Task => task !== undefined);
}

function parseMarkdownImport(content: string): Task[] {
	const tasks: Task[] = [];
	const stack: Array<{ indent: number; id: number }> = [];
	for (const line of content.split(/\r?\n/)) {
		const match = /^(\s*)- \[([ xX])\](?: #(\d+))?(?: \((low|medium|high|urgent)\))? (.+?)(?: \[(#[^\]]+)\])?$/.exec(line);
		if (!match) continue;
		const indent = match[1].length;
		const id = match[3] ? Number(match[3]) : tasks.length + 1;
		const tags = match[6] ? normalizeTags(match[6].split(/\s+/).map((tag) => tag.replace(/^#/, ""))) : undefined;
		const subjectParts = match[5].split(/\s+⛓\s+/);
		const blockedBy = subjectParts[1] ? uniqueNumbers(subjectParts[1].split(/\s*,\s*/).map((ref) => Number(ref.replace(/^#/, "")))) : [];
		while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
		const rawSubject = subjectParts[0];
		const isDeferred = /\s+\{deferred\}$/.test(rawSubject);
		let status: TaskStatus = "pending";
		if (match[2].toLowerCase() === "x") status = "completed";
		else if (isDeferred) status = "deferred";
		const task: Task = {
			id,
			subject: rawSubject.replace(/\s+\{deferred\}$/, "").trim(),
			status,
		};
		if (match[4]) task.priority = match[4] as TaskPriority;
		if (stack.length) task.parentId = stack[stack.length - 1].id;
		if (blockedBy.length) task.blockedBy = blockedBy;
		if (tags) task.tags = tags;
		tasks.push(task);
		stack.push({ indent, id });
	}
	return tasks;
}

function remapImportedTasks(imported: readonly Task[], state: TaskState, replace: boolean): Task[] {
	if (replace) {
		return imported.map((task) => ({
			...task,
			blockedBy: task.blockedBy ? [...task.blockedBy] : undefined,
			tags: task.tags ? [...task.tags] : undefined,
		}));
	}
	const idMap = new Map<number, number>();
	imported.forEach((task, index) => idMap.set(task.id, state.nextId + index));
	return imported.map((task) => ({
		...task,
		id: idMap.get(task.id) ?? task.id,
		parentId: task.parentId !== undefined ? (idMap.get(task.parentId) ?? task.parentId) : undefined,
		blockedBy: task.blockedBy?.map((id) => idMap.get(id) ?? id),
		tags: task.tags ? [...task.tags] : undefined,
	}));
}

export function applyTaskMutation(state: TaskState, action: TaskAction, params: TaskMutationParams): ApplyResult {
	switch (action) {
		case "create": {
			if (!params.subject?.trim()) return errorResult(state, "subject required for create");
			const replacedCount = params.replace === true ? state.tasks.length : 0;
			const baseState = params.replace === true ? { tasks: [], nextId: 1 } : state;
			if (params.parentId !== undefined && params.parentId !== null) {
				const err = validateLiveReference(baseState, "parentId", params.parentId);
				if (err) return errorResult(state, err);
			}
			for (const dep of uniqueNumbers(params.blockedBy)) {
				const err = validateLiveReference(baseState, "blockedBy", dep);
				if (err) return errorResult(state, err);
			}
			const newTask: Task = { id: baseState.nextId, subject: params.subject.trim(), status: "pending" };
			if (params.description) newTask.description = params.description;
			if (params.activeForm) newTask.activeForm = params.activeForm;
			if (params.priority) newTask.priority = params.priority;
			if (params.thinking) newTask.thinking = params.thinking;
			if (params.parentId !== undefined && params.parentId !== null) newTask.parentId = params.parentId;
			const blockedBy = uniqueNumbers(params.blockedBy);
			if (blockedBy.length) newTask.blockedBy = blockedBy;
			const tags = normalizeTags(params.tags);
			if (tags) newTask.tags = tags;
			if (params.owner) newTask.owner = params.owner;
			if (params.metadata) newTask.metadata = { ...params.metadata };
			return {
				state: { tasks: [...baseState.tasks, newTask], nextId: baseState.nextId + 1 },
				op: { kind: "create", taskId: newTask.id, ...(replacedCount > 0 ? { replacedCount } : {}) },
			};
		}

		case "update": {
			if (params.id === undefined) return errorResult(state, "id required for update");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];
			const hasMutation =
				params.subject !== undefined || params.description !== undefined || params.activeForm !== undefined || params.status !== undefined ||
				params.priority !== undefined || params.thinking !== undefined || params.parentId !== undefined || params.clearParent === true || params.owner !== undefined ||
				params.metadata !== undefined || params.tags !== undefined || (params.addTags?.length ?? 0) > 0 || (params.removeTags?.length ?? 0) > 0 ||
				(params.addBlockedBy?.length ?? 0) > 0 || (params.removeBlockedBy?.length ?? 0) > 0;
			if (!hasMutation) return errorResult(state, "update requires at least one mutable field");

			let newStatus = current.status;
			if (params.status !== undefined) {
				if (!isTransitionValid(current.status, params.status)) return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
				newStatus = params.status;
			}

			let newParentId = current.parentId;
			if (params.clearParent === true) newParentId = undefined;
			if (params.parentId !== undefined) {
				if (params.parentId === null) newParentId = undefined;
				else {
					if (params.parentId === current.id) return errorResult(state, `cannot parent #${current.id} on itself`);
					const err = validateLiveReference(state, "parentId", params.parentId);
					if (err) return errorResult(state, err);
					if (wouldCreateParentCycle(state.tasks, current.id, params.parentId)) return errorResult(state, "parentId would create a cycle in the task tree");
					newParentId = params.parentId;
				}
			}

			let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
			if (params.removeBlockedBy?.length) newBlockedBy = newBlockedBy.filter((dep) => !new Set(params.removeBlockedBy).has(dep));
			if (params.addBlockedBy?.length) {
				for (const dep of params.addBlockedBy) {
					if (dep === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
					const err = validateLiveReference(state, "addBlockedBy", dep);
					if (err) return errorResult(state, err);
					if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
				}
				if (detectCycle(state.tasks, current.id, newBlockedBy)) return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
			}

			let newTags = params.tags !== undefined ? normalizeTags(params.tags) : current.tags ? [...current.tags] : undefined;
			if (params.addTags?.length) newTags = normalizeTags([...(newTags ?? []), ...params.addTags]);
			if (params.removeTags?.length && newTags) {
				const remove = new Set(params.removeTags.map((tag) => tag.trim()).filter(Boolean));
				newTags = normalizeTags(newTags.filter((tag) => !remove.has(tag)));
			}

			let newMetadata = current.metadata;
			if (params.metadata !== undefined) {
				const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
				for (const [k, v] of Object.entries(params.metadata)) v === null ? delete merged[k] : (merged[k] = v);
				newMetadata = Object.keys(merged).length ? merged : undefined;
			}

			const updated: Task = { ...current, status: newStatus };
			if (params.subject !== undefined) updated.subject = params.subject;
			if (params.description !== undefined) updated.description = params.description;
			if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
			if (params.priority !== undefined) updated.priority = params.priority;
			if (params.thinking !== undefined) updated.thinking = params.thinking;
			if (params.owner !== undefined) updated.owner = params.owner;
			if (newParentId === undefined) delete updated.parentId;
			else updated.parentId = newParentId;
			if (newBlockedBy.length) updated.blockedBy = newBlockedBy;
			else delete updated.blockedBy;
			if (newTags) updated.tags = newTags;
			else delete updated.tags;
			if (newMetadata === undefined) delete updated.metadata;
			else updated.metadata = newMetadata;

			const newTasks = [...state.tasks];
			newTasks[idx] = updated;
			return { state: { tasks: newTasks, nextId: state.nextId }, op: { kind: "update", id: updated.id, fromStatus: current.status, toStatus: newStatus } };
		}

		case "batch_create": {
			if (!params.items?.length) return errorResult(state, "items required for batch_create");
			const replacedCount = params.replace === true ? state.tasks.length : 0;
			let working = params.replace === true ? { tasks: [], nextId: 1 } : state;
			const ids: number[] = [];
			for (let i = 0; i < params.items.length; i++) {
				const result = applyTaskMutation(working, "create", { ...params.items[i], action: "create" });
				if (result.op.kind === "error") return errorResult(state, `item ${i + 1}: ${result.op.message}`);
				if (result.op.kind === "create") ids.push(result.op.taskId);
				working = result.state;
			}
			return { state: working, op: { kind: "batch_create", ids, ...(replacedCount > 0 ? { replacedCount } : {}) } };
		}

		case "batch_update": {
			if (!params.items?.length) return errorResult(state, "items required for batch_update");
			let working = state;
			const ids: number[] = [];
			for (let i = 0; i < params.items.length; i++) {
				const result = applyTaskMutation(working, "update", { ...params.items[i], action: "update" });
				if (result.op.kind === "error") return errorResult(state, `item ${i + 1}: ${result.op.message}`);
				if (result.op.kind === "update") ids.push(result.op.id);
				working = result.state;
			}
			return { state: working, op: { kind: "batch_update", ids } };
		}

		case "list":
			return {
				state,
				op: {
					kind: "list",
					includeDeleted: params.includeDeleted === true,
					blockedOnly: params.blockedOnly === true,
					...(params.status ? { statusFilter: params.status } : {}),
					...(params.priority ? { priorityFilter: params.priority } : {}),
					...(params.tag ? { tagFilter: params.tag } : {}),
				},
			};

		case "get": {
			if (params.id === undefined) return errorResult(state, "id required for get");
			const task = findTask(state, params.id);
			if (!task) return errorResult(state, `#${params.id} not found`);
			return { state, op: { kind: "get", task } };
		}

		case "delete": {
			if (params.id === undefined) return errorResult(state, "id required for delete");
			const idx = state.tasks.findIndex((t) => t.id === params.id);
			if (idx === -1) return errorResult(state, `#${params.id} not found`);
			const current = state.tasks[idx];
			if (current.status === "deleted") return errorResult(state, `#${current.id} is already deleted`);
			const dependents = state.tasks.filter((task) => task.status !== "deleted" && task.blockedBy?.includes(current.id));
			if (dependents.length > 0) return errorResult(state, `cannot delete #${current.id}; still blocks ${dependents.map((task) => `#${task.id}`).join(", ")}`);
			const children = state.tasks.filter((task) => task.status !== "deleted" && task.parentId === current.id);
			if (children.length > 0) return errorResult(state, `cannot delete #${current.id}; still has subtasks ${children.map((task) => `#${task.id}`).join(", ")}`);
			const newTasks = [...state.tasks];
			newTasks[idx] = { ...current, status: "deleted" };
			return { state: { tasks: newTasks, nextId: state.nextId }, op: { kind: "delete", id: current.id, subject: current.subject } };
		}

		case "clear":
			return { state: { tasks: [], nextId: 1 }, op: { kind: "clear", count: state.tasks.length } };

		case "export":
			return {
				state,
				op: {
					kind: "export",
					format: params.format ?? "json",
					includeDeleted: params.includeDeleted === true,
					blockedOnly: params.blockedOnly === true,
					...(params.status ? { statusFilter: params.status } : {}),
					...(params.priority ? { priorityFilter: params.priority } : {}),
					...(params.tag ? { tagFilter: params.tag } : {}),
				},
			};

		case "import": {
			if (!params.content?.trim()) return errorResult(state, "content required for import");
			let imported: Task[];
			try {
				imported = (params.format ?? "json") === "markdown" ? parseMarkdownImport(params.content) : (parseJsonImport(params.content) ?? []);
			} catch (err) {
				return errorResult(state, `invalid import content: ${(err as Error).message}`);
			}
			if (imported.length === 0) return errorResult(state, "import content contained no tasks");
			const replace = params.replace === true;
			const remapped = remapImportedTasks(imported, state, replace);
			const merged = replace ? remapped : [...state.tasks, ...remapped];
			const err = validateImportedTasks(merged);
			if (err) return errorResult(state, err);
			return { state: { tasks: merged, nextId: Math.max(0, ...merged.map((task) => task.id)) + 1 }, op: { kind: "import", count: remapped.length, replaced: replace } };
		}
	}
}
