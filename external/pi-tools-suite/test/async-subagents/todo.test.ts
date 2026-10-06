import { afterEach, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import subagentTodo from "../../src/todo/subagent.js";
import { __resetState } from "../../src/todo/state/store.js";
import { TODO_STATE_ENTRY_TYPE } from "../../src/todo/state/replay.js";
import { SUBAGENT_COMMON_TOOLS, withSubagentCapabilities } from "../../src/async-subagents/core/child-tools.js";

const scratchRoot = resolve(import.meta.dir, "../../../../.pi/artifacts/subagent-todo-tests");
const workspaces: string[] = [];
afterEach(() => {
	__resetState();
	for (const cwd of workspaces.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

function harness(cwd: string, sessionId: string, active: string[] = []) {
	let tools = [...active];
	const registered: any[] = [];
	const branch: any[] = [];
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	const ctx = {
		cwd,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
	} as unknown as ExtensionContext;
	const pi = {
		registerTool: (tool: unknown) => registered.push(tool),
		on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		getActiveTools: () => tools,
		setActiveTools: (next: string[]) => { tools = next; },
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
	};
	subagentTodo(pi as unknown as ExtensionAPI);
	return {
		branch,
		registered,
		handlers,
		active: () => tools,
		restrict: (next: string[]) => { tools = next; },
		async emit(name: string) {
			for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
		},
		execute: (params: unknown) => registered[0].execute("call", params, undefined, undefined, ctx),
	};
}

function workspace(): string {
	mkdirSync(scratchRoot, { recursive: true });
	const cwd = mkdtempSync(join(scratchRoot, "run-"));
	workspaces.push(cwd);
	return cwd;
}

test("CLI restrictions retain allowed work tools plus common capabilities, including extra-arg overrides", () => {
	const common = SUBAGENT_COMMON_TOOLS.join(",");
	expect(withSubagentCapabilities(["--mode", "rpc"])).toEqual(["--mode", "rpc"]);
	expect(withSubagentCapabilities(["--tools", "read,grep", "--model", "m"])).toEqual(["--model", "m", "--tools", `read,grep,${common}`]);
	expect(withSubagentCapabilities(["--tools", "read", "-t", "grep,todo"])).toEqual(["--tools", `grep,${common}`]);
	expect(withSubagentCapabilities(["--tools", "read", "-nt"])).toEqual(["--tools", common]);
	expect(withSubagentCapabilities(["--no-tools", "--tools", "read"])).toEqual(["--tools", common]);
	expect(withSubagentCapabilities(["-xt", "todo,repo_search,write"])).toEqual(["--exclude-tools", "write"]);
	expect(withSubagentCapabilities(["-xt", "todo,write", "--exclude-tools", "todo,repo_context"])).toEqual([]);
});

test("todo is the only added tool, including empty work-tool selection and model changes", async () => {
	const child = harness(workspace(), "child", ["read"]);
	await child.emit("session_start");
	expect(child.active()).toEqual(["read", "todo"]);
	child.restrict([]);
	await child.emit("model_select");
	await child.emit("model_select");
	expect(child.active()).toEqual(["todo"]);
	expect(child.registered.map((tool) => tool.name)).toEqual(["todo"]);
	expect(child.registered[0].promptGuidelines.join("\n")).not.toContain("/todos persist");
	expect(child.handlers.has("agent_end")).toBe(false);
	expect(child.handlers.has("agent_settled")).toBe(false);
});

test("child attempts share neither todos nor the parent's persisted project plan", async () => {
	const cwd = workspace();
	mkdirSync(join(cwd, ".pi"));
	const plan = join(cwd, ".pi/todo-plan.json");
	const parentPlan = JSON.stringify({ version: 1, enabled: true, nextId: 2,
		tasks: [{ id: 1, subject: "Parent task", status: "pending" }] });
	writeFileSync(plan, parentPlan);
	const first = harness(cwd, "first");
	const second = harness(cwd, "second");
	await first.emit("session_start");
	await second.emit("session_start");
	expect((await first.execute({ action: "list" })).details.tasks).toEqual([]);
	await first.execute({ action: "create", subject: "Child task", status: "in_progress" });
	expect((await second.execute({ action: "list" })).details.tasks).toEqual([]);
	await second.execute({ action: "create", subject: "Other child task" });
	await second.execute({ action: "clear" });
	expect((await first.execute({ action: "list" })).details.tasks[0].subject).toBe("Child task");
	await first.execute({ action: "update", id: 1, status: "completed" });
	expect(readFileSync(plan, "utf8")).toBe(parentPlan);
	const retry = harness(cwd, "retry");
	await retry.emit("session_start");
	expect((await retry.execute({ action: "list" })).details.tasks).toEqual([]);
});

test("compaction retains unfinished tasks with a fresh branch snapshot; tree changes replay only that branch", async () => {
	const child = harness(workspace(), "child");
	await child.emit("session_start");
	await child.execute({ action: "create", subject: "Unfinished", status: "in_progress" });
	child.branch.length = 0; // old tool results/snapshots were pruned
	await child.emit("session_compact");
	expect(child.branch).toHaveLength(1);
	expect(child.branch[0].customType).toBe(TODO_STATE_ENTRY_TYPE);
	await child.emit("session_tree");
	expect((await child.execute({ action: "list" })).details.tasks[0].status).toBe("in_progress");
	child.branch.length = 0; // switch to an unrelated branch
	await child.emit("session_tree");
	expect((await child.execute({ action: "list" })).details.tasks).toEqual([]);
});
