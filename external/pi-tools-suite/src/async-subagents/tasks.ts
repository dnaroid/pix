import type { AgentTask } from "./lib.js";
import { validateBasename } from "./lib.js";
import { truncate } from "./format.js";
import type { AgentTaskPreview } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalPositiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function optionalTimeoutMs(item: Record<string, unknown>): number | undefined {
	const timeoutMs = optionalPositiveNumber(item.timeoutMs);
	if (timeoutMs !== undefined) return Math.max(1, Math.round(timeoutMs));
	const timeoutSeconds = optionalPositiveNumber(item.timeoutSeconds);
	if (timeoutSeconds !== undefined) return Math.max(1, Math.round(timeoutSeconds * 1000));
	return undefined;
}

function nextGeneratedAgentId(seenIds: Set<string>, reservedIds: Set<string>): string {
	let index = 1;
	while (true) {
		const id = `agent-${index}`;
		if (!seenIds.has(id) && !reservedIds.has(id)) return id;
		index++;
	}
}

export function normalizeAgentTasks(input: unknown): { tasks: AgentTask[]; error?: undefined } | { tasks?: undefined; error: string } {
	if (!Array.isArray(input) || input.length === 0) {
		return { error: "spawn requires at least one task in the tasks array." };
	}

	const reservedIds = new Set<string>();
	for (const item of input) {
		if (!isRecord(item)) continue;
		const id = optionalString(item.id);
		if (id) reservedIds.add(id);
	}

	const tasks: AgentTask[] = [];
	const seenIds = new Set<string>();
	for (let index = 0; index < input.length; index++) {
		const item = input[index];
		if (!isRecord(item)) {
			return { error: `Task ${index + 1} must be an object.` };
		}

		const taskText = optionalString(item.task);
		if (!taskText) {
			return { error: `Task ${index + 1} is missing a non-empty task description.` };
		}

		const id = optionalString(item.id) ?? nextGeneratedAgentId(seenIds, reservedIds);
		if (seenIds.has(id)) {
			return { error: `Duplicate agent ID: "${id}". Each agent must have a unique ID.` };
		}

		try {
			validateBasename(id, `tasks[${index}].id`);
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}

		const tools = Array.isArray(item.tools)
			? item.tools.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
			: undefined;
		const extraArgs = Array.isArray(item.extraArgs)
			? item.extraArgs.filter((arg): arg is string => typeof arg === "string" && arg.trim().length > 0)
			: undefined;
		const scope = optionalString(item.scope);
		const subagentType = optionalString(item.subagentType) ?? optionalString(item.type);
		const model = optionalString(item.model);
		const thinking = optionalString(item.thinking);
		const promptAppend = optionalString(item.promptAppend);
		const promptOverride = optionalString(item.promptOverride);
		const focus = optionalString(item.focus) ?? optionalString(item.attention);
		const imagePaths = Array.isArray(item.imagePaths)
			? item.imagePaths.filter((imagePath): imagePath is string => typeof imagePath === "string" && imagePath.trim().length > 0).map((imagePath) => imagePath.trim())
			: undefined;
		const timeoutMs = optionalTimeoutMs(item);
		const parentObjective = optionalString(item.parentObjective);

		seenIds.add(id);
		const normalizedTask: AgentTask = {
			id,
			task: taskText,
		};
		if (scope) normalizedTask.scope = scope;
		if (subagentType) normalizedTask.subagentType = subagentType;
		if (model) normalizedTask.model = model;
		if (thinking) normalizedTask.thinking = thinking;
		if (promptAppend) normalizedTask.promptAppend = promptAppend;
		if (promptOverride) normalizedTask.promptOverride = promptOverride;
		if (focus) normalizedTask.focus = focus;
		if (imagePaths && imagePaths.length > 0) normalizedTask.imagePaths = imagePaths;
		if (tools && tools.length > 0) normalizedTask.tools = tools;
		if (extraArgs && extraArgs.length > 0) normalizedTask.extraArgs = extraArgs;
		if (timeoutMs !== undefined) normalizedTask.timeoutMs = timeoutMs;
		if (parentObjective) normalizedTask.parentObjective = parentObjective;
		tasks.push(normalizedTask);
	}

	return { tasks };
}

export function toTaskPreviews(tasks: AgentTask[]): AgentTaskPreview[] {
	return tasks.map((task) => ({
		id: task.id,
		task: task.task,
		scope: task.scope ? truncate(task.scope, 80) : undefined,
		model: task.model,
	}));
}
