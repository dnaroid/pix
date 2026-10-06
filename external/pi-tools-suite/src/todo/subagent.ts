import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ignoreStaleExtensionContextError } from "../context-usage.js";
import { replayFromBranch } from "./state/replay.js";
import { replaceState } from "./state/store.js";
import {
	activateTodoStateScope,
	appendTodoStateSnapshot,
	DEFAULT_PROMPT_GUIDELINES,
	registerTodoTool,
} from "./todo.js";

/** Child-local planning only: no project persistence, UI, thinking changes or follow-up turns. */
export default function subagentTodo(pi: ExtensionAPI): void {
	registerTodoTool(pi, {
		promptGuidelines: [
			...DEFAULT_PROMPT_GUIDELINES
				.filter((line) => !line.startsWith("Persistence:"))
				.map((line) => line.replace(/user-facing report/g, "report to the parent")),
			"Your todo list is private to this child attempt, not the parent's plan or another worker's list. Use it for non-trivial multi-step work in any role; skip trivial tasks. Report unfinished work and blockers to the parent. Do not delegate or ask the user from the child.",
		],
		afterCommit: (_state, _ctx, info) => {
			appendTodoStateSnapshot(pi, info.action, info.params as Record<string, unknown>);
		},
	});

	const enableTodo = () => {
		try {
			const active = pi.getActiveTools();
			// Planning is available even when work tools are explicitly restricted or empty.
			if (!active.includes("todo")) pi.setActiveTools([...active, "todo"]);
		} catch (error) {
			ignoreStaleExtensionContextError(error);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		activateTodoStateScope(ctx);
		replaceState(replayFromBranch(ctx));
		enableTodo();
	});
	pi.on("model_select", enableTodo);
	pi.on("session_tree", (_event, ctx) => {
		activateTodoStateScope(ctx);
		replaceState(replayFromBranch(ctx));
	});
	// Compaction does not change the branch: retain the live list and write a
	// fresh snapshot so pruning old tool results cannot lose unfinished tasks.
	pi.on("session_compact", (_event, ctx) => {
		activateTodoStateScope(ctx);
		appendTodoStateSnapshot(pi, "list", {});
	});
}
