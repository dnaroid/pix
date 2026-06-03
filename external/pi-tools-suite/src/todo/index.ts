import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { autoClearCompletedTodos } from "./state/auto-clear.js";
import { loadPersistedPlan, syncPersistedPlan } from "./state/persistence.js";
import { replayFromBranch } from "./state/replay.js";
import { ACTIVE_STATUSES, isTaskBlocked, selectVisibleTasks } from "./state/selectors.js";
import { getState, replaceState } from "./state/store.js";
import { publishTodoState, registerTodosCommand, registerTodoTool } from "./todo.js";

const TODO_NUDGE_LIMIT = 8;
const TODO_NUDGE_INITIAL_DELAY_MS = 5_000;
const TODO_NUDGE_IDLE_RETRY_DELAY_MS = 100;
const TODO_NUDGE_MAX_IDLE_ATTEMPTS = 40;
const ASK_USER_TOOL_NAMES = new Set(["ask_user", "ask_user_question", "question"]);

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
			"If the user added/removed/canceled requirements or changed goal/scope/priority/approach, or if discovered facts make the current plan stale/incomplete/impossible, synchronize todos first: update still-relevant items, defer/delete obsolete ones, add new tasks, and adjust blockers/order.",
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
		const priority = task.priority ? ` (${task.priority})` : "";
		const blockedBy = task.blockedBy?.length ? ` (blocked by #${task.blockedBy.join(", #")})` : "";
		return `- #${task.id} [${task.status}]${priority} ${task.subject}${activeForm}${blockedBy}`;
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
	let lastNudgedSignature: string | undefined;
	let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
	const pendingAskUserToolCallIds = new Set<string>();

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

	registerTodoTool(pi, {
		afterCommit: (state, ctx) => {
			try {
				const sync = syncPersistedPlan(ctx.cwd, state);
				if (sync?.completed) console.log(`rpiv-todo: completed persisted plan and removed ${sync.path}`);
			} catch (err) {
				console.warn(`rpiv-todo: failed to sync persisted plan — ${(err as Error).message}`);
			}
		},
	});
	registerTodosCommand(pi);

	pi.on("session_start", async (_event, ctx) => {
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
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (pendingAskUserToolCallIds.size > 0) {
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
