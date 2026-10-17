import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { readTodoProgress, todoProgressFromRpcEvent, writeTodoProgress } from "../../src/async-subagents/core/todo-progress.js";
import { getAgentState } from "../../src/async-subagents/core/state.js";

const scratchRoot = path.resolve(import.meta.dir, "../../../../.pi/artifacts/subagent-progress-tests");
const workspaces: string[] = [];
afterEach(() => {
	for (const dir of workspaces.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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

test("latest atomic snapshot survives missing/truncated logs and clear replaces old counts", () => {
	fs.mkdirSync(scratchRoot, { recursive: true });
	const run = fs.mkdtempSync(path.join(scratchRoot, "run-"));
	workspaces.push(run);
	const dir = path.join(run, "worker");
	fs.mkdirSync(dir);
	fs.writeFileSync(path.join(dir, "prompt.md"), "task");
	expect(readTodoProgress(dir)).toBeUndefined();
	writeTodoProgress(dir, { completed: 1, total: 5 });
	fs.writeFileSync(path.join(dir, "progress.jsonl"), "[truncated]");
	expect(getAgentState(run, "worker", { includeLineCounts: false })?.todoProgress).toEqual({ completed: 1, total: 5 });
	writeTodoProgress(dir, { completed: 2, total: 6 });
	expect(readTodoProgress(dir)).toEqual({ completed: 2, total: 6 });
	// A cleared plan removes the snapshot instead of persisting 0/0.
	writeTodoProgress(dir, { completed: 0, total: 0 });
	expect(readTodoProgress(dir)).toBeUndefined();
	expect(fs.existsSync(path.join(dir, "todo-progress.json"))).toBe(false);
	for (const invalid of ['{"completed":2,"total":1}', '{"completed":-1,"total":5}',
		'{"completed":0.5,"total":5}', '{"completed":0,"total":9007199254740992}', "{", " ".repeat(257)]) {
		fs.writeFileSync(path.join(dir, "todo-progress.json"), invalid);
		expect(readTodoProgress(dir)).toBeUndefined();
	}
	writeTodoProgress(path.join(run, "removed"), { completed: 1, total: 5 });
	expect(fs.existsSync(path.join(run, "removed"))).toBe(false);
});
