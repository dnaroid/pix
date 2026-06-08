import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPiToolsSuiteConfig } from "../config.js";
import { autoClearCompletedTodos } from "./state/auto-clear.js";
import { loadPersistedPlan, syncPersistedPlan } from "./state/persistence.js";
import { replayFromBranch } from "./state/replay.js";
import { ACTIVE_STATUSES, isTaskBlocked, selectVisibleTasks } from "./state/selectors.js";
import { applyTaskMutation } from "./state/state-reducer.js";
import { getState, replaceState } from "./state/store.js";
import { DEFAULT_PROMPT_GUIDELINES, DEFAULT_PROMPT_SNIPPET, publishTodoState, registerTodosCommand, registerTodoTool } from "./todo.js";
import type { Task, TaskMutationParams } from "./tool/types.js";

type AgentMessageLike = { role?: unknown; stopReason?: unknown; content?: unknown };

const TODO_NUDGE_LIMIT = 8;
const TODO_NUDGE_INITIAL_DELAY_MS = 0;
const TODO_NUDGE_IDLE_RETRY_DELAY_MS = 100;
const TODO_NUDGE_MAX_IDLE_ATTEMPTS = 40;
const ASK_USER_TOOL_NAMES = new Set(["ask_user", "ask_user_question", "question"]);
const TODO_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

type TodoThinkingLevel = (typeof TODO_THINKING_LEVELS)[number];
type ModelLike = { reasoning?: boolean; thinkingLevelMap?: Partial<Record<TodoThinkingLevel, unknown | null>> };

function isTodoThinkingLevel(value: unknown): value is TodoThinkingLevel {
	return TODO_THINKING_LEVELS.includes(value as TodoThinkingLevel);
}

function getAvailableTodoThinkingLevels(model: unknown): TodoThinkingLevel[] {
	const m = model as ModelLike | undefined;
	if (!m?.reasoning) return ["off"];
	const map = m.thinkingLevelMap;
	return TODO_THINKING_LEVELS.filter((level) => level === "off" || map?.[level] !== null);
}

function buildThinkingPromptParts(model: unknown): { promptSnippet?: string; promptGuidelines?: string[] } {
	const levels = getAvailableTodoThinkingLevels(model);
	if (levels.length <= 1) return {};
	return {
		promptSnippet: `${DEFAULT_PROMPT_SNIPPET} Optional per-item thinking: ${levels.join("|")}.`.trim(),
		promptGuidelines: [
			...DEFAULT_PROMPT_GUIDELINES,
			`If todoThinking is enabled, assign task \`thinking\` during create/batch_create or update whenever planned items differ in complexity; choose from ${levels.join(", ")}. Use higher thinking for investigation, hard debugging, risky edits, or review; use lower/off for mechanical steps and the final user-facing report. Do not leave all thinking unset for a non-trivial mixed-complexity plan.`,
		],
	};
}

function isAskUserToolName(toolName: string): boolean {
	return ASK_USER_TOOL_NAMES.has(toolName);
}

function getUnfinishedTodoNudge(): { signature: string; message: string } | undefined {
	const visible = selectVisibleTasks(getState());
	const byId = new Map(visible.map((task) => [task.id, task]));
	const unfinished = visible.filter((task) => ACTIVE_STATUSES.has(task.status) && !isTaskBlocked(task, byId));
	if (unfinished.length === 0) return undefined;

	const signature = JSON.stringify(
		unfinished.map((task) => ({
			id: task.id,
			status: task.status,
			subject: task.subject,
			activeForm: task.activeForm,
			blockedBy: task.blockedBy ?? [],
		})),
	);
	const shown = unfinished.slice(0, TODO_NUDGE_LIMIT);
	const hidden = unfinished.length - shown.length;
	const lines = shown.map((task) => {
		const activeForm = task.activeForm ? ` — ${task.activeForm}` : "";
		const blockedBy = task.blockedBy && task.blockedBy.length > 0 ? ` (blocked by #${task.blockedBy.join(", #")})` : "";
		return `- #${task.id} [${task.status}] ${task.subject}${activeForm}${blockedBy}`;
	});
	if (hidden > 0) lines.push(`- …and ${hidden} more unfinished todo item${hidden === 1 ? "" : "s"}.`);

	return {
		signature,
		message: [
			"Todo auto-nudge: unfinished todo items remain after your last response.",
			"Continue working on them now. Pick exactly one pending/in_progress item, mark it in_progress if needed, make concrete progress, and update or complete todos immediately as work changes.",
			"If the user added/removed/canceled requirements or changed goal/scope/approach, or if discovered facts make the current plan stale/incomplete/impossible, synchronize todos first: update still-relevant items, defer/delete obsolete ones, add new tasks, and adjust blockers/order.",
			"If progress is waiting on user-supplied data, clarification, or a decision, defer the affected plan/todos before your final response instead of leaving them pending/in_progress, so auto-nudge stops until the user replies.",
			"For non-user blockers, leave the current item in_progress and create/update a blocker task instead of stopping.",
			"",
			...lines,
		].join("\n"),
	};
}

function getPersistedPlanPrompt(path: string): string | undefined {
	const unfinished = selectVisibleTasks(getState()).filter((task) => task.status !== "completed");
	if (unfinished.length === 0) return undefined;
	const lines = unfinished.slice(0, TODO_NUDGE_LIMIT).map((task) => {
		const activeForm = task.activeForm ? ` — ${task.activeForm}` : "";
		const blockedBy = task.blockedBy?.length ? ` (blocked by #${task.blockedBy.join(", #")})` : "";
		return `- #${task.id} [${task.status}] ${task.subject}${activeForm}${blockedBy}`;
	});
	if (unfinished.length > TODO_NUDGE_LIMIT) lines.push(`- …and ${unfinished.length - TODO_NUDGE_LIMIT} more unfinished todo item(s).`);
	return [
		`Persisted todo plan loaded from ${path}.`,
		"Ask the user which item(s) to continue before implementing. Offer a compact choice list based on these active tasks; do not dump the full plan unless asked.",
		"After the user chooses a scope, run /todos scope <id...> so out-of-scope active tasks become deferred and stop triggering auto-nudges.",
		"Before resuming implementation, synchronize the loaded plan if the user's current goal/scope/requirements changed or discovered facts make it stale/incomplete: update still-relevant items, defer/delete obsolete ones, add new tasks, and adjust blockers/order.",
		"Use /todos persist off (or clear) when the plan should be discarded; when all visible tasks are completed, persistence will be disabled and the plan file removed automatically.",
		"",
		...lines,
	].join("\n");
}

function emitPersistedPlanPrompt(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string): void {
	if (ctx.hasUI) {
		pi.sendUserMessage(prompt);
		return;
	}
	console.log(prompt);
}

export default function (pi: ExtensionAPI) {
	let currentModel: unknown;
	const todoThinkingEnabled = loadPiToolsSuiteConfig(["todo"]).todoThinking;
	const rememberedThinkingByTaskId = new Map<number, TodoThinkingLevel>();
	let lastNudgedSignature: string | undefined;
	let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
	const pendingAskUserToolCallIds = new Set<string>();
	let suppressNextNudgeForThinkingSwitch = false;
	let inProgressAtAgentStart = new Set<number>();

	function registerTodoToolWithCurrentPrompt(): void {
		const thinkingPrompt = todoThinkingEnabled ? buildThinkingPromptParts(currentModel) : {};
		registerTodoTool(pi, {
			...thinkingPrompt,
			afterCommit: async (state, ctx, info) => {
				if (todoThinkingEnabled) applyTodoThinkingAfterCommit(state, info);
				try {
					const sync = syncPersistedPlan(ctx.cwd, state);
					if (sync?.completed) console.log(`rpiv-todo: completed persisted plan and removed ${sync.path}`);
				} catch (err) {
					console.warn(`rpiv-todo: failed to sync persisted plan — ${(err as Error).message}`);
				}
			},
		});
	}

	function applyTodoThinkingAfterCommit(state: ReturnType<typeof getState>, info: { action: string; params: TaskMutationParams }): void {
		const mutations = getTodoThinkingMutations(info.action, info.params);
		for (const mutation of mutations) {
			if (mutation.id === undefined || mutation.status === "in_progress") continue;
			restoreTaskThinking(mutation.id);
		}
		restoreInactiveTodoThinking(state);
		for (const mutation of mutations) {
			if (mutation.id === undefined) continue;
			const task = state.tasks.find((item) => item.id === mutation.id);
			if (!task || task.status !== "in_progress" || !task.thinking) continue;
			if (mutation.status !== "in_progress" && mutation.thinking === undefined) continue;
			switchToTaskThinking(task.id, task.thinking);
		}
	}

	function getTodoThinkingMutations(action: string, params: TaskMutationParams): TaskMutationParams[] {
		if (action === "update") return [params];
		if (action === "batch_update") return params.items ?? [];
		return [];
	}

	function getCurrentThinkingLevel(): TodoThinkingLevel | undefined {
		const level = (pi as { getThinkingLevel?: () => unknown }).getThinkingLevel?.();
		return isTodoThinkingLevel(level) ? level : undefined;
	}

	function switchToTaskThinking(taskId: number, level: TodoThinkingLevel): void {
		if (!getAvailableTodoThinkingLevels(currentModel).includes(level)) return;
		const current = getCurrentThinkingLevel();
		if (!current) return;
		if (!rememberedThinkingByTaskId.has(taskId)) rememberedThinkingByTaskId.set(taskId, current);
		if (current !== level) setTodoThinkingLevel(level);
	}

	function restoreTaskThinking(taskId: number): void {
		const previous = rememberedThinkingByTaskId.get(taskId);
		if (!previous) return;
		rememberedThinkingByTaskId.delete(taskId);
		if (getCurrentThinkingLevel() !== previous) setTodoThinkingLevel(previous);
	}

	function restoreInactiveTodoThinking(state: ReturnType<typeof getState>): void {
		for (const taskId of [...rememberedThinkingByTaskId.keys()]) {
			const task = state.tasks.find((item) => item.id === taskId);
			if (task?.status === "in_progress") continue;
			restoreTaskThinking(taskId);
		}
	}

	function setTodoThinkingLevel(level: TodoThinkingLevel): void {
		const setter = (pi as { setThinkingLevel?: (level: TodoThinkingLevel) => void }).setThinkingLevel;
		if (!setter) return;
		suppressNextNudgeForThinkingSwitch = true;
		setter.call(pi, level);
	}

	function isCompletedAssistantReply(message: AgentMessageLike | undefined): boolean {
		if (message?.role !== "assistant") return false;
		if (message.stopReason === "aborted" || message.stopReason === "error" || message.stopReason === "length") return false;
		if (!Array.isArray(message.content)) return false;
		return message.content.some((block) => typeof (block as { type?: unknown }).type === "string");
	}

	function hasCompletedAssistantReply(messages: readonly unknown[] | undefined): boolean {
		if (!Array.isArray(messages)) return false;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i] as AgentMessageLike | undefined;
			if (message?.role !== "assistant") continue;
			return isCompletedAssistantReply(message);
		}
		return false;
	}

	function findOptimisticallyCompletableTask(tasks: readonly Task[]): Task | undefined {
		const visible = tasks.filter((task) => task.status !== "deleted");
		const byId = new Map(visible.map((task) => [task.id, task]));
		const unfinished = visible.filter((task) => ACTIVE_STATUSES.has(task.status) && !isTaskBlocked(task, byId));
		if (unfinished.length !== 1) return undefined;
		const [task] = unfinished;
		if (task.status !== "in_progress") return undefined;
		if (inProgressAtAgentStart.has(task.id)) return undefined;
		return task;
	}

	function applyInternalTodoMutation(action: "update", params: TaskMutationParams, ctx: ExtensionContext): boolean {
		const result = applyTaskMutation(getState(), action, params);
		if (result.op.kind === "error") {
			console.warn(`rpiv-todo: failed internal ${action} mutation — ${result.op.message}`);
			return false;
		}
		const autoClear = autoClearCompletedTodos(result.state);
		replaceState(autoClear.state);
		publishTodoState(pi as any, ctx, action, params as Record<string, unknown>);
		if (todoThinkingEnabled) applyTodoThinkingAfterCommit(autoClear.state, { action, params });
		try {
			const sync = syncPersistedPlan(ctx.cwd, autoClear.state);
			if (sync?.completed) console.log(`rpiv-todo: completed persisted plan and removed ${sync.path}`);
		} catch (err) {
			console.warn(`rpiv-todo: failed to sync persisted plan — ${(err as Error).message}`);
		}
		return true;
	}

	function maybeRecoverCompletedCurrentTask(messages: readonly unknown[] | undefined, ctx: ExtensionContext): boolean {
		if (!hasCompletedAssistantReply(messages)) return false;
		const task = findOptimisticallyCompletableTask(getState().tasks);
		if (!task) return false;
		return applyInternalTodoMutation("update", { action: "update", id: task.id, status: "completed" }, ctx);
	}

	function clearNudgeTimer(): void {
		if (!nudgeTimer) return;
		clearTimeout(nudgeTimer);
		nudgeTimer = undefined;
	}

	function scheduleTodoNudge(ctx: ExtensionContext, attempt = 0): void {
		clearNudgeTimer();
		const delayMs = attempt === 0 ? TODO_NUDGE_INITIAL_DELAY_MS : TODO_NUDGE_IDLE_RETRY_DELAY_MS;
		nudgeTimer = setTimeout(() => {
			nudgeTimer = undefined;
			try {
				if (!ctx.isIdle()) {
					if (attempt < TODO_NUDGE_MAX_IDLE_ATTEMPTS) scheduleTodoNudge(ctx, attempt + 1);
					return;
				}
				if (ctx.hasPendingMessages()) return;

				const nudge = getUnfinishedTodoNudge();
				if (!nudge) {
					lastNudgedSignature = undefined;
					return;
				}

				// Avoid an infinite self-nudge loop when the previous nudge did not change
				// the pending/in_progress todo snapshot.
				if (nudge.signature === lastNudgedSignature) return;
				lastNudgedSignature = nudge.signature;

				// agent_end fires before Pi is fully back in idle dispatch. Sending as a
				// normal user message on the next idle tick reliably starts a fresh turn;
				// queueing followUp from inside agent_end can be too late to be drained.
				pi.sendUserMessage(nudge.message);
			} catch (err) {
				console.warn(`rpiv-todo: failed to auto-nudge unfinished todos — ${(err as Error).message}`);
			}
		}, delayMs);
	}

	registerTodoToolWithCurrentPrompt();
	registerTodosCommand(pi);

	pi.on("session_start", async (_event, ctx) => {
		currentModel = ctx.model;
		registerTodoToolWithCurrentPrompt();
		const persisted = loadPersistedPlan(ctx.cwd);
		const loaded = autoClearCompletedTodos(persisted?.state ?? replayFromBranch(ctx));
		replaceState(loaded.state);
		publishTodoState(pi as any, ctx);
		if (persisted && loaded.cleared) syncPersistedPlan(ctx.cwd, loaded.state);
		lastNudgedSignature = undefined;
		if (persisted) {
			const prompt = getPersistedPlanPrompt(persisted.path);
			if (prompt) {
				emitPersistedPlanPrompt(pi, ctx, prompt);
				lastNudgedSignature = getUnfinishedTodoNudge()?.signature;
			}
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		replaceState(autoClearCompletedTodos(loadPersistedPlan(ctx.cwd)?.state ?? replayFromBranch(ctx)).state);
		publishTodoState(pi as any, ctx);
		lastNudgedSignature = undefined;
	});

	pi.on("session_tree", async (_event, ctx) => {
		replaceState(autoClearCompletedTodos(loadPersistedPlan(ctx.cwd)?.state ?? replayFromBranch(ctx)).state);
		publishTodoState(pi as any, ctx);
		lastNudgedSignature = undefined;
	});

	pi.on("session_shutdown", async () => {
		clearNudgeTimer();
	});

	pi.on("model_select", async (event) => {
		currentModel = event.model;
		if (todoThinkingEnabled) registerTodoToolWithCurrentPrompt();
	});

	// Reads getTodos() at render time; do NOT call replayFromBranch here
	// (branch is stale — message_end runs after tool_execution_end).
	pi.on("tool_execution_start", async (event) => {
		if (!isAskUserToolName(event.toolName)) return;
		pendingAskUserToolCallIds.add(event.toolCallId);
		clearNudgeTimer();
	});

	pi.on("tool_execution_end", async (event) => {
		if (isAskUserToolName(event.toolName)) pendingAskUserToolCallIds.delete(event.toolCallId);
	});

	pi.on("agent_start", async () => {
		pendingAskUserToolCallIds.clear();
		inProgressAtAgentStart = new Set(selectVisibleTasks(getState()).filter((task) => task.status === "in_progress").map((task) => task.id));
	});

	pi.on("message_end", async (event, ctx) => {
		if (!isCompletedAssistantReply((event as { message?: AgentMessageLike } | undefined)?.message)) return;
		if (maybeRecoverCompletedCurrentTask([(event as { message?: AgentMessageLike }).message], ctx)) {
			lastNudgedSignature = undefined;
			clearNudgeTimer();
		}
	});

	pi.on("agent_end", async (event, ctx) => {
		const completedAssistantReply = hasCompletedAssistantReply((event as { messages?: readonly unknown[] } | undefined)?.messages);

		if (suppressNextNudgeForThinkingSwitch) {
			suppressNextNudgeForThinkingSwitch = false;
			if (!completedAssistantReply) {
				clearNudgeTimer();
				return;
			}
		}

		if (pendingAskUserToolCallIds.size > 0) {
			clearNudgeTimer();
			return;
		}

		if (completedAssistantReply && maybeRecoverCompletedCurrentTask((event as { messages?: readonly unknown[] } | undefined)?.messages, ctx)) {
			lastNudgedSignature = undefined;
			clearNudgeTimer();
			return;
		}

		const nudge = getUnfinishedTodoNudge();
		if (!nudge) {
			lastNudgedSignature = undefined;
			return;
		}
		scheduleTodoNudge(ctx);
	});
}
