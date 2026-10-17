import { expect, test } from "bun:test";
import { todoProgressFromRpcEvent } from "../../src/async-subagents/core/todo-progress.js";
import { getAgentState } from "../../src/async-subagents/core/state.js";
import { createBatch, resetSubagentStoreForTest, resolveScope, updateLive, updateRecord } from "../../src/async-subagents/core/store.js";

function event(tasks: unknown[]) {
	return { type: "extension_ui_request", method: "setWidget", widgetKey: "pix.session-state",
		widgetLines: ["pi-tools-suite:todo:state", JSON.stringify({ version: 1, details: { tasks } })] };
}

test("counts child-local todos including deferred items, excluding deleted items", () => {
	expect(todoProgressFromRpcEvent(event([
		{ status: "completed" }, { status: "pending" }, { status: "in_progress" },
		{ status: "deferred" }, { status: "deleted" },
	]))).toEqual({ completed: 1, total: 4 });
	expect(todoProgressFromRpcEvent(event([]))).toEqual({ completed: 0, total: 0 });
	expect(todoProgressFromRpcEvent(event([{ status: "completed" }]))).toEqual({ completed: 1, total: 1 });
});

test("ignores unrelated or malformed RPC state without erasing the last plan", () => {
	const valid = event([]);
	for (const invalid of [
		{ ...valid, method: "notify" }, { ...valid, widgetKey: "other" },
		{ ...valid, widgetLines: ["other", valid.widgetLines[1]] },
		{ ...valid, widgetLines: [valid.widgetLines[0], "{"] },
		{ ...valid, widgetLines: [valid.widgetLines[0], '{"version":2,"details":{"tasks":[]}}'] },
		event([null]), event([{ status: "unknown" }]), { type: "tool_execution_end" },
	]) expect(todoProgressFromRpcEvent(invalid)).toBeUndefined();
});

test("todo progress lives in the in-memory live state and clears with it (decision 0072)", () => {
	resetSubagentStoreForTest();
	const run = createBatch("/tmp/todo-progress-project", resolveScope(undefined), "todo");
	updateRecord(run, "worker", { cwd: "/tmp/todo-progress-project", status: "running", pid: process.pid, turn: 1 });
	updateLive(run, "worker", { active: true });
	expect(getAgentState(run, "worker", { includeLineCounts: false })?.todoProgress).toBeUndefined();
	updateLive(run, "worker", { todoProgress: { completed: 1, total: 5 } });
	expect(getAgentState(run, "worker", { includeLineCounts: false })?.todoProgress).toEqual({ completed: 1, total: 5 });
	updateLive(run, "worker", { todoProgress: { completed: 2, total: 6 } });
	expect(getAgentState(run, "worker", { includeLineCounts: false })?.todoProgress).toEqual({ completed: 2, total: 6 });
	// A relaunch resets live progress instead of showing the previous plan.
	updateLive(run, "worker", { todoProgress: undefined });
	expect(getAgentState(run, "worker", { includeLineCounts: false })?.todoProgress).toBeUndefined();
	resetSubagentStoreForTest();
});
