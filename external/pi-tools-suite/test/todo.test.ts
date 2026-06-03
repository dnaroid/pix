import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPiAiMock } from "./support/pi-ai-mock.js";

mock.module("typebox", () => ({
	Type: {
		Object: (properties: any, options?: any) => ({ kind: "object", properties, options }),
		Optional: (schema: any) => ({ kind: "optional", schema }),
		String: (options?: any) => ({ kind: "string", options }),
		Array: (items: any, options?: any) => ({ kind: "array", items, options }),
		Number: (options?: any) => ({ kind: "number", options }),
		Boolean: (options?: any) => ({ kind: "boolean", options }),
		Record: (key: any, value: any, options?: any) => ({ kind: "record", key, value, options }),
		Unknown: (options?: any) => ({ kind: "unknown", options }),
	},
}));

mock.module("@earendil-works/pi-ai", () => createPiAiMock());

class FakePi {
	tools = new Map<string, any>();
	commands = new Map<string, any>();
	events = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
	sentMessages: string[] = [];

	registerTool(tool: any) { this.tools.set(tool.name, tool); }
	registerCommand(name: string, command: any) { this.commands.set(name, command); }
	on(name: string, handler: (event: unknown, ctx: any) => unknown) {
		const handlers = this.events.get(name) ?? [];
		handlers.push(handler);
		this.events.set(name, handlers);
	}
	sendUserMessage(message: string) { this.sentMessages.push(message); }
	async emit(name: string, event: unknown, ctx: any = {}) {
		for (const handler of this.events.get(name) ?? []) await handler(event, ctx);
	}
}

async function loadTodoModule() {
	const mod = await import("../src/todo/todo.js");
	mod.__resetState();
	return mod;
}

async function expectToolError(promise: Promise<unknown>, message: string) {
	try {
		await promise;
		expect.unreachable(`expected todo tool to throw: ${message}`);
	} catch (err) {
		expect((err as Error).message).toContain(message);
	}
}

afterEach(async () => {
	const mod = await import("../src/todo/todo.js");
	mod.__resetState();
});

describe.serial("todo tool", () => {
	test.serial("registers metadata and performs create/list/get/update/delete/clear", async () => {
		const { registerTodoTool, getTodos } = await loadTodoModule();
		const pi = new FakePi();
		registerTodoTool(pi as any);
		const tool = pi.tools.get("todo");
		const promptGuidelines = tool.promptGuidelines.join("\n");
		expect(tool.promptGuidelines.length).toBeGreaterThan(3);
		expect(promptGuidelines).toContain("synchronize the plan");
		expect(promptGuidelines).toContain("goal, scope, requirements");
		expect(tool.promptSnippet).toContain("Track/sync");

		const created = await tool.execute("call", { action: "create", subject: "Write tests", description: "cover tools" }, undefined, undefined, {});
		expect(created.content[0].text).toContain("Created #1");
		expect(created.content[0].text).toContain("none is in_progress");
		expect(getTodos()).toMatchObject([{ id: 1, subject: "Write tests", status: "pending" }]);

		const listed = await tool.execute("call", { action: "list" }, undefined, undefined, {});
		expect(listed.content[0].text).toContain("[pending] #1 Write tests");

		const updated = await tool.execute("call", { action: "update", id: 1, status: "in_progress", activeForm: "writing tests" }, undefined, undefined, {});
		expect(updated.content[0].text).toContain("pending → in_progress");
		expect(updated.content[0].text).not.toContain("none is in_progress");

		const got = await tool.execute("call", { action: "get", id: 1 }, undefined, undefined, {});
		expect(got.content[0].text).toContain("writing tests");

		const deleted = await tool.execute("call", { action: "delete", id: 1 }, undefined, undefined, {});
		expect(deleted.content[0].text).toContain("Deleted #1");
		expect((await tool.execute("call", { action: "list" }, undefined, undefined, {})).content[0].text).toContain("No tasks");
		expect((await tool.execute("call", { action: "list", includeDeleted: true }, undefined, undefined, {})).content[0].text).toContain("[deleted]");

		const cleared = await tool.execute("call", { action: "clear" }, undefined, undefined, {});
		expect(cleared.content[0].text).toContain("Cleared");
		expect(getTodos()).toEqual([]);
	});

	test.serial("publishes live todo state events after commits", async () => {
		const { registerTodoTool, TODO_STATE_EVENT } = await loadTodoModule();
		const pi = new FakePi();
		const emitted: Array<{ channel: string; data: any }> = [];
		(pi.events as any).emit = (channel: string, data: any) => emitted.push({ channel, data });
		registerTodoTool(pi as any);

		await pi.tools.get("todo").execute(
			"call",
			{ action: "create", subject: "Update widget" },
			undefined,
			undefined,
			{ sessionManager: { getSessionFile: () => "/tmp/session.jsonl" } },
		);

		expect(emitted).toHaveLength(1);
		expect(emitted[0].channel).toBe(TODO_STATE_EVENT);
		expect(emitted[0].data).toMatchObject({
			version: 1,
			sessionFile: "/tmp/session.jsonl",
			details: {
				action: "create",
				tasks: [{ id: 1, subject: "Update widget", status: "pending" }],
				nextId: 2,
			},
		});
		expect(typeof emitted[0].data.checkedAt).toBe("number");
	});

	test.serial("throws Pi tool errors without committing invalid mutations", async () => {
		const { registerTodoTool, getTodos } = await loadTodoModule();
		const pi = new FakePi();
		registerTodoTool(pi as any);
		const tool = pi.tools.get("todo");

		await expectToolError(tool.execute("call", { action: "create" }, undefined, undefined, {}), "subject required for create");
		expect(getTodos()).toEqual([]);

		await tool.execute("call", { action: "create", subject: "Valid" }, undefined, undefined, {});
		await expectToolError(tool.execute("call", { action: "update", id: 1 }, undefined, undefined, {}), "update requires at least one mutable field");
		expect(getTodos()).toMatchObject([{ id: 1, subject: "Valid", status: "pending" }]);
	});

	test.serial("automatically clears todo state when all visible tasks are completed", async () => {
		const { registerTodoTool, getTodos } = await loadTodoModule();
		const pi = new FakePi();
		registerTodoTool(pi as any);
		const tool = pi.tools.get("todo");

		await tool.execute("call", { action: "create", subject: "One" }, undefined, undefined, {});
		await tool.execute("call", { action: "create", subject: "Two" }, undefined, undefined, {});
		await tool.execute("call", { action: "update", id: 1, status: "completed" }, undefined, undefined, {});
		expect(getTodos()).toMatchObject([{ id: 1, status: "completed" }, { id: 2, status: "pending" }]);

		const completed = await tool.execute("call", { action: "update", id: 2, status: "completed" }, undefined, undefined, {});
		expect(completed.content[0].text).toContain("Updated #2 (pending → completed)");
		expect(completed.content[0].text).toContain("All todos completed; cleared automatically.");
		expect(completed.details.tasks).toEqual([]);
		expect(completed.details.nextId).toBe(1);
		expect(getTodos()).toEqual([]);
	});

	test.serial("validates dependency invariants", async () => {
		const { registerTodoTool, detectCycle, getTodos } = await loadTodoModule();
		const pi = new FakePi();
		registerTodoTool(pi as any);
		const tool = pi.tools.get("todo");
		await tool.execute("call", { action: "create", subject: "Task one" }, undefined, undefined, {});
		await tool.execute("call", { action: "create", subject: "Task two", blockedBy: [1] }, undefined, undefined, {});
		await tool.execute("call", { action: "update", id: 1, status: "in_progress", activeForm: "doing one" }, undefined, undefined, {});

		await expectToolError(
			tool.execute("call", { action: "update", id: 1, addBlockedBy: [1], activeForm: "doing one" }, undefined, undefined, {}),
			"cannot block #1 on itself",
		);
		await expectToolError(tool.execute("call", { action: "delete", id: 1 }, undefined, undefined, {}), "cannot delete #1; still blocks #2");
		expect(detectCycle(getTodos(), 1, [2])).toBe(true);
		await tool.execute("call", { action: "update", id: 2, removeBlockedBy: [1] }, undefined, undefined, {});
		expect((await tool.execute("call", { action: "delete", id: 1 }, undefined, undefined, {})).content[0].text).toContain("Deleted #1");
	});

	test.serial("filters list output and formats get output with inverse blocks", async () => {
		const { registerTodoTool } = await loadTodoModule();
		const pi = new FakePi();
		registerTodoTool(pi as any);
		const tool = pi.tools.get("todo");
		await tool.execute("call", { action: "create", subject: "Parent", owner: "agent" }, undefined, undefined, {});
		await tool.execute("call", { action: "create", subject: "Child", blockedBy: [1] }, undefined, undefined, {});
		await tool.execute("call", { action: "update", id: 1, status: "in_progress", activeForm: "doing parent" }, undefined, undefined, {});

		const pendingOnly = await tool.execute("call", { action: "list", status: "pending" }, undefined, undefined, {});
		expect(pendingOnly.content[0].text).toContain("[pending] #2 Child ⛓ #1");
		expect(pendingOnly.content[0].text).not.toContain("Parent");

		const got = await tool.execute("call", { action: "get", id: 1 }, undefined, undefined, {});
		expect(got.content[0].text).toContain("activeForm: doing parent");
		expect(got.content[0].text).toContain("blocks: #2");
		expect(got.content[0].text).toContain("owner: agent");
	});

	test.serial("supports priorities, tags, hierarchy, batch operations, and import/export", async () => {
		const { registerTodoTool, getTodos } = await loadTodoModule();
		const pi = new FakePi();
		registerTodoTool(pi as any);
		const tool = pi.tools.get("todo");

		const batch = await tool.execute(
			"call",
			{
				action: "batch_create",
				items: [
					{ subject: "Plan release", priority: "urgent", tags: ["release", "v1"] },
					{ subject: "Write migration", parentId: 1, priority: "high", tags: ["release"], blockedBy: [1] },
				],
			},
			undefined,
			undefined,
			{},
		);
		expect(batch.content[0].text).toContain("Created 2 tasks: #1, #2");
		expect(getTodos()).toMatchObject([
			{ id: 1, priority: "urgent", tags: ["release", "v1"] },
			{ id: 2, parentId: 1, blockedBy: [1], priority: "high", tags: ["release"] },
		]);

		const filtered = await tool.execute("call", { action: "list", priority: "high", tag: "release", blockedOnly: true }, undefined, undefined, {});
		expect(filtered.content[0].text).toContain("[pending] #2 Write migration (high) ↳ #1 ⛓ #1 #release");
		expect(filtered.content[0].text).not.toContain("Plan release");

		await expectToolError(tool.execute("call", { action: "delete", id: 1 }, undefined, undefined, {}), "cannot delete #1; still blocks #2");
		await expectToolError(tool.execute("call", { action: "update", id: 1, parentId: 2 }, undefined, undefined, {}), "parentId would create a cycle");

		const updated = await tool.execute(
			"call",
			{ action: "batch_update", items: [{ id: 2, removeBlockedBy: [1], addTags: ["docs"], removeTags: ["release"] }, { id: 1, status: "in_progress", activeForm: "planning" }] },
			undefined,
			undefined,
			{},
		);
		expect(updated.content[0].text).toContain("Updated 2 tasks: #2, #1");
		expect(getTodos()[1]).toMatchObject({ tags: ["docs"] });

		const exported = await tool.execute("call", { action: "export", format: "json" }, undefined, undefined, {});
		expect(exported.content[0].text).toContain('"subject": "Plan release"');
		expect(exported.content[0].text).toContain('"parentId": 1');

		await tool.execute("call", { action: "clear" }, undefined, undefined, {});
		const imported = await tool.execute("call", { action: "import", content: exported.content[0].text, replace: true }, undefined, undefined, {});
		expect(imported.content[0].text).toContain("Imported 2 tasks (replaced existing tasks)");
		expect(getTodos()).toHaveLength(2);

		const markdown = await tool.execute("call", { action: "export", format: "markdown" }, undefined, undefined, {});
		expect(markdown.content[0].text).toContain("- [ ] #1 (urgent) Plan release [#release #v1]");
		expect(markdown.content[0].text).toContain("  - [ ] #2 (high) Write migration [#docs]");
	});
});

describe.serial("todo reducer", () => {
	test.serial("validates create blockedBy references", async () => {
		const { applyTaskMutation } = await import("../src/todo/state/state-reducer.js");
		const state = { tasks: [{ id: 1, subject: "Deleted", status: "deleted" as const }], nextId: 2 };

		expect(applyTaskMutation(state, "create", { action: "create" } as any).op).toMatchObject({ kind: "error", message: "subject required for create" });
		expect(applyTaskMutation(state, "create", { action: "create", subject: "Blocked", blockedBy: [99] } as any).op).toMatchObject({ kind: "error", message: "blockedBy: #99 not found" });
		expect(applyTaskMutation(state, "create", { action: "create", subject: "Blocked", blockedBy: [1] } as any).op).toMatchObject({ kind: "error", message: "blockedBy: #1 is deleted" });
	});

	test.serial("enforces status transitions and deleted terminal behavior", async () => {
		const { applyTaskMutation } = await import("../src/todo/state/state-reducer.js");
		const state = {
			tasks: [
				{ id: 1, subject: "Done", status: "completed" as const },
				{ id: 2, subject: "Tombstone", status: "deleted" as const },
			],
			nextId: 3,
		};

		expect(applyTaskMutation(state, "update", { action: "update", id: 1, status: "pending" } as any).op).toMatchObject({ kind: "error", message: "illegal transition completed → pending" });
		expect(applyTaskMutation(state, "update", { action: "update", id: 2, status: "pending" } as any).op).toMatchObject({ kind: "error", message: "illegal transition deleted → pending" });
		expect(applyTaskMutation(state, "update", { action: "update", id: 1, status: "completed" } as any).op).toMatchObject({ kind: "update", fromStatus: "completed", toStatus: "completed" });
		expect(applyTaskMutation(state, "update", { action: "update", id: 1, status: "deleted" } as any).op).toMatchObject({ kind: "update", fromStatus: "completed", toStatus: "deleted" });
	});

	test.serial("merges metadata, removes blockedBy, and catches graph edge cases", async () => {
		const { applyTaskMutation } = await import("../src/todo/state/state-reducer.js");
		const state = {
			tasks: [
				{ id: 1, subject: "A", status: "pending" as const, blockedBy: [2], metadata: { keep: true, drop: "old" } },
				{ id: 2, subject: "B", status: "pending" as const },
				{ id: 3, subject: "Deleted", status: "deleted" as const },
			],
			nextId: 4,
		};

		expect(applyTaskMutation(state, "update", { action: "update", id: 99, subject: "x" } as any).op).toMatchObject({ kind: "error", message: "#99 not found" });
		expect(applyTaskMutation(state, "update", { action: "update", id: 1, addBlockedBy: [99] } as any).op).toMatchObject({ kind: "error", message: "addBlockedBy: #99 not found" });
		expect(applyTaskMutation(state, "update", { action: "update", id: 1, addBlockedBy: [3] } as any).op).toMatchObject({ kind: "error", message: "addBlockedBy: #3 is deleted" });

		const cycleState = { tasks: [{ id: 1, subject: "A", status: "pending" as const, blockedBy: [2] }, { id: 2, subject: "B", status: "pending" as const }], nextId: 3 };
		expect(applyTaskMutation(cycleState, "update", { action: "update", id: 2, addBlockedBy: [1] } as any).op).toMatchObject({ kind: "error", message: "addBlockedBy would create a cycle in the blockedBy graph" });

		const updated = applyTaskMutation(state, "update", { action: "update", id: 1, removeBlockedBy: [2], metadata: { drop: null, added: 42 } } as any).state.tasks[0];
		expect(updated.blockedBy).toBeUndefined();
		expect(updated.metadata).toEqual({ keep: true, added: 42 });
	});

	test.serial("handles missing ids and delete edge cases", async () => {
		const { applyTaskMutation } = await import("../src/todo/state/state-reducer.js");
		const state = { tasks: [{ id: 1, subject: "Gone", status: "deleted" as const }], nextId: 2 };

		expect(applyTaskMutation(state, "get", { action: "get" } as any).op).toMatchObject({ kind: "error", message: "id required for get" });
		expect(applyTaskMutation(state, "get", { action: "get", id: 2 } as any).op).toMatchObject({ kind: "error", message: "#2 not found" });
		expect(applyTaskMutation(state, "delete", { action: "delete" } as any).op).toMatchObject({ kind: "error", message: "id required for delete" });
		expect(applyTaskMutation(state, "delete", { action: "delete", id: 2 } as any).op).toMatchObject({ kind: "error", message: "#2 not found" });
		expect(applyTaskMutation(state, "delete", { action: "delete", id: 1 } as any).op).toMatchObject({ kind: "error", message: "#1 is already deleted" });
	});
});

describe.serial("todo replay", () => {
	test.serial("replays the last valid todo branch snapshot and clones task objects", async () => {
		const { isTaskDetails, replayFromBranch } = await import("../src/todo/state/replay.js");
		const first = { action: "create", params: {}, tasks: [{ id: 1, subject: "Old", status: "pending" as const }], nextId: 2 };
		const second = { action: "update", params: { id: 1 }, tasks: [{ id: 1, subject: "New", status: "in_progress" as const }], nextId: 3 };
		const branch = [
			{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: "bad", nextId: 2 } } },
			{ type: "message", message: { role: "toolResult", toolName: "other", details: second } },
			{ type: "message", message: { role: "toolResult", toolName: "todo", details: first } },
			{ type: "message", message: { role: "toolResult", toolName: "todo", details: second } },
		];

		expect(isTaskDetails(undefined)).toBe(false);
		expect(isTaskDetails(second)).toBe(true);
		const replayed = replayFromBranch({ sessionManager: { getBranch: () => branch } });
		expect(replayed).toEqual({ tasks: second.tasks, nextId: 3 });
		expect(replayed.tasks[0]).not.toBe(second.tasks[0]);
		replayed.tasks[0].subject = "Mutated clone";
		expect(second.tasks[0].subject).toBe("New");
	});

});

describe.serial("/todos command", () => {
	test.serial("/todos command renders empty and grouped UI summaries and handles non-interactive mode", async () => {
		const { registerTodoTool, registerTodosCommand } = await loadTodoModule();
		const pi = new FakePi();
		registerTodoTool(pi as any);
		registerTodosCommand(pi as any);
		const notifications: Array<{ message: string; level: string }> = [];
		const ui = { notify: (message: string, level: string) => notifications.push({ message, level }) };

		const consoleError = mock(() => {});
		const originalConsoleError = console.error;
		console.error = consoleError;
		try {
			await pi.commands.get("todos").handler([], { hasUI: false });
		} finally {
			console.error = originalConsoleError;
		}
		expect(notifications).toHaveLength(0);
		expect(consoleError).toHaveBeenCalledWith("/todos requires interactive mode");

		await pi.commands.get("todos").handler([], { hasUI: true, ui });
		expect(notifications[notifications.length - 1]).toEqual({ message: "No todos yet. Ask the agent to add some!", level: "info" });

		await pi.tools.get("todo").execute("call", { action: "create", subject: "Pending" }, undefined, undefined, {});
		await pi.tools.get("todo").execute("call", { action: "create", subject: "Active" }, undefined, undefined, {});
		await pi.tools.get("todo").execute("call", { action: "create", subject: "Done" }, undefined, undefined, {});
		await pi.tools.get("todo").execute("call", { action: "update", id: 2, status: "in_progress", activeForm: "working" }, undefined, undefined, {});
		await pi.tools.get("todo").execute("call", { action: "update", id: 3, status: "completed" }, undefined, undefined, {});

		await pi.commands.get("todos").handler([], { hasUI: true, ui });
		const summary = notifications[notifications.length - 1]?.message ?? "";
		expect(summary).toContain("1/3 completed · 1 in progress · 1 pending");
		expect(summary).toContain("── Pending ──\n  ○ #1 Pending");
		expect(summary).toContain("── In Progress ──\n  ◐ #2 Active (working)");
		expect(summary).toContain("── Completed ──\n  ✓ #3 Done");
	});

		test.serial("/todos command supports filters, tree view, and export", async () => {
		const { registerTodoTool, registerTodosCommand } = await loadTodoModule();
		const pi = new FakePi();
		registerTodoTool(pi as any);
		registerTodosCommand(pi as any);
		expect(pi.commands.get("todos").getArgumentCompletions("persist ").map((item: any) => item.value)).toContain("persist on");
		expect(pi.commands.get("todos").getArgumentCompletions("--e").map((item: any) => item.value)).toContain("--export markdown");
		expect(pi.commands.get("todos").getArgumentCompletions("--r").map((item: any) => item.value)).toContain("--ready");
		const notifications: Array<{ message: string; level: string }> = [];
		const ui = { notify: (message: string, level: string) => notifications.push({ message, level }) };
		const tool = pi.tools.get("todo");

		await tool.execute("call", { action: "create", subject: "Epic", priority: "urgent", tags: ["big"] }, undefined, undefined, {});
		await tool.execute("call", { action: "create", subject: "Child", parentId: 1, blockedBy: [1], priority: "high", tags: ["big", "blocked"] }, undefined, undefined, {});
		await tool.execute("call", { action: "create", subject: "Other", tags: ["small"] }, undefined, undefined, {});

		await pi.commands.get("todos").handler("--blocked --tag big --priority high", { hasUI: true, ui });
		const blocked = notifications[notifications.length - 1]?.message ?? "";
		expect(blocked).toContain("1 pending");
		expect(blocked).toContain("#2 Child (high)    ↳ #1    ⛓ #1    #big #blocked");
		expect(blocked).not.toContain("Epic");

		await pi.commands.get("todos").handler("--ready", { hasUI: true, ui });
		const readyBeforeDependencyCompletes = notifications[notifications.length - 1]?.message ?? "";
		expect(readyBeforeDependencyCompletes).toContain("#1 Epic");
		expect(readyBeforeDependencyCompletes).toContain("#3 Other");
		expect(readyBeforeDependencyCompletes).not.toContain("#2 Child");

		await tool.execute("call", { action: "update", id: 1, status: "completed" }, undefined, undefined, {});
		await pi.commands.get("todos").handler("--ready --tag big", { hasUI: true, ui });
		const readyAfterDependencyCompletes = notifications[notifications.length - 1]?.message ?? "";
		expect(readyAfterDependencyCompletes).toContain("#2 Child");
		expect(readyAfterDependencyCompletes).not.toContain("#1 Epic");

		await pi.commands.get("todos").handler("--tree --tag big", { hasUI: true, ui });
		const tree = notifications[notifications.length - 1]?.message ?? "";
		expect(tree).toContain("── Tree ──");
		expect(tree).toContain("✓ #1 Epic (urgent)");
		expect(tree).toContain("  ○ #2 Child (high)");

		await pi.commands.get("todos").handler("--export markdown --tag big", { hasUI: true, ui });
		const exported = notifications[notifications.length - 1]?.message ?? "";
		expect(exported).toContain("- [x] #1 (urgent) Epic [#big]");
		expect(exported).toContain("  - [ ] #2 (high) Child ⛓ #1 [#big #blocked]");
		expect(exported).not.toContain("Other");
	});

	test.serial("/todos persist controls project plan file and scope defers out-of-scope tasks", async () => {
		const { registerTodoTool, registerTodosCommand } = await loadTodoModule();
		const cwd = mkdtempSync(join(tmpdir(), "todo-persist-"));
		const planPath = join(cwd, ".pi", "todo-plan.json");
		const pi = new FakePi();
		const emitted: Array<{ channel: string; data: any }> = [];
		(pi.events as any).emit = (channel: string, data: any) => emitted.push({ channel, data });
		registerTodoTool(pi as any);
		registerTodosCommand(pi as any);
		expect(pi.commands.has("todos-persist")).toBe(true);
		expect(pi.commands.has("todos-scope")).toBe(true);
		expect(pi.commands.get("todos-persist").getArgumentCompletions("o").map((item: any) => item.value)).toContain("on");
		const notifications: Array<{ message: string; level: string }> = [];
		const ui = { notify: (message: string, level: string) => notifications.push({ message, level }) };
		const tool = pi.tools.get("todo");

		try {
			await tool.execute("call", { action: "create", subject: "Selected" }, undefined, undefined, { cwd });
			await tool.execute("call", { action: "create", subject: "Later" }, undefined, undefined, { cwd });
			expect(existsSync(planPath)).toBe(false);

			await pi.commands.get("todos-persist").handler("on", { cwd, hasUI: true, ui });
			expect(existsSync(planPath)).toBe(true);
			expect(notifications[notifications.length - 1]?.message).toContain("Todo persistence enabled");

			await pi.commands.get("todos-scope").handler("1", { cwd, hasUI: true, ui });
			const scoped = JSON.parse(readFileSync(planPath, "utf8"));
			expect(scoped.tasks.find((task: any) => task.id === 1).status).toBe("pending");
			expect(scoped.tasks.find((task: any) => task.id === 2).status).toBe("deferred");
			expect(emitted[emitted.length - 1]?.data.details.tasks.find((task: any) => task.id === 2).status).toBe("deferred");
			expect(notifications[notifications.length - 1]?.message).toContain("Deferred out-of-scope active tasks: 1");

			await pi.commands.get("todos-persist").handler("status", { cwd, hasUI: true, ui });
			expect(notifications[notifications.length - 1]?.message).toContain("Todo persistence is on");

			await pi.commands.get("todos").handler("persist off", { cwd, hasUI: true, ui });
			expect(existsSync(planPath)).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test.serial("todo tool autosaves while persistence is enabled and removes complete plans", async () => {
		const { registerTodoTool } = await loadTodoModule();
		const { savePersistedPlan, syncPersistedPlan } = await import("../src/todo/state/persistence.js");
		const cwd = mkdtempSync(join(tmpdir(), "todo-autosave-"));
		const planPath = join(cwd, ".pi", "todo-plan.json");
		const pi = new FakePi();
		registerTodoTool(pi as any, {
			afterCommit: (state: any, ctx: any) => { syncPersistedPlan(ctx.cwd, state); },
		});
		const tool = pi.tools.get("todo");

		try {
			savePersistedPlan(cwd, { tasks: [], nextId: 1 });
			await tool.execute("call", { action: "create", subject: "Persisted" }, undefined, undefined, { cwd });
			expect(JSON.parse(readFileSync(planPath, "utf8")).tasks[0].subject).toBe("Persisted");

			await tool.execute("call", { action: "update", id: 1, status: "completed" }, undefined, undefined, { cwd });
			expect(existsSync(planPath)).toBe(false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

});

describe.serial("todo extension lifecycle", () => {
	test.serial("loads persisted plans on startup, prompts for scope, and suppresses duplicate auto-nudge", async () => {
		const extension = (await import("../src/todo/index.js")).default;
		const { savePersistedPlan } = await import("../src/todo/state/persistence.js");
		const cwd = mkdtempSync(join(tmpdir(), "todo-startup-"));
		const pi = new FakePi();
		const ctx = {
			cwd,
			hasUI: true,
			ui: {},
			sessionManager: { getBranch: () => [] },
			isIdle: () => true,
			hasPendingMessages: () => false,
		};
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		globalThis.setTimeout = ((callback: TimerHandler) => {
			if (typeof callback === "function") callback();
			return 1 as any;
		}) as any;
		globalThis.clearTimeout = (() => {}) as any;
		try {
			savePersistedPlan(cwd, {
				nextId: 3,
				tasks: [
					{ id: 1, subject: "Continue now", status: "pending", priority: "high" },
					{ id: 2, subject: "Later", status: "deferred" },
				],
			});
			extension(pi as any);
			await pi.emit("session_start", {}, ctx);
			expect(pi.sentMessages).toHaveLength(1);
			expect(pi.sentMessages[0]).toContain("Persisted todo plan loaded");
			expect(pi.sentMessages[0]).toContain("/todos scope <id...>");
			expect(pi.sentMessages[0]).toContain("synchronize the loaded plan");
			expect(pi.sentMessages[0]).toContain("#2 [deferred] Later");

			await pi.emit("agent_end", {}, ctx);
			expect(pi.sentMessages).toHaveLength(1);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test.serial("auto-nudges unfinished tasks once per signature and resets after branch replay", async () => {
		const extension = (await import("../src/todo/index.js")).default;
		const pi = new FakePi();
		const snapshot = { action: "create", params: {}, tasks: [{ id: 1, subject: "Unfinished", status: "pending" }, { id: 2, subject: "Later", status: "deferred" }], nextId: 3 };
		const ctx = {
			hasUI: false,
			sessionManager: { getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "todo", details: snapshot } }] },
			isIdle: () => true,
			hasPendingMessages: () => false,
		};
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		globalThis.setTimeout = ((callback: TimerHandler) => {
			if (typeof callback === "function") callback();
			return 1 as any;
		}) as any;
		globalThis.clearTimeout = (() => {}) as any;
		try {
			extension(pi as any);
			await pi.emit("session_start", {}, ctx);
			await pi.emit("agent_end", {}, ctx);
			expect(pi.sentMessages).toHaveLength(1);
			expect(pi.sentMessages[0]).toContain("#1 [pending] Unfinished");
			expect(pi.sentMessages[0]).toContain("synchronize todos first");
			expect(pi.sentMessages[0]).not.toContain("Later");

			await pi.emit("agent_end", {}, ctx);
			expect(pi.sentMessages).toHaveLength(1);

			await pi.emit("session_start", {}, ctx);
			await pi.emit("agent_end", {}, ctx);
			expect(pi.sentMessages).toHaveLength(2);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		}
	});

	test.serial("auto-nudge ignores active tasks whose blockers are incomplete", async () => {
		const extension = (await import("../src/todo/index.js")).default;
		const pi = new FakePi();
		let snapshot = {
			action: "create",
			params: {},
			tasks: [
				{ id: 1, subject: "Finish prerequisite", status: "pending" },
				{ id: 2, subject: "Blocked follow-up", status: "pending", blockedBy: [1] },
			],
			nextId: 3,
		};
		const ctx = {
			hasUI: false,
			sessionManager: { getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "todo", details: snapshot } }] },
			isIdle: () => true,
			hasPendingMessages: () => false,
		};
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		globalThis.setTimeout = ((callback: TimerHandler) => {
			if (typeof callback === "function") callback();
			return 1 as any;
		}) as any;
		globalThis.clearTimeout = (() => {}) as any;
		try {
			extension(pi as any);
			await pi.emit("session_start", {}, ctx);
			await pi.emit("agent_end", {}, ctx);
			expect(pi.sentMessages).toHaveLength(1);
			expect(pi.sentMessages[0]).toContain("#1 [pending] Finish prerequisite");
			expect(pi.sentMessages[0]).not.toContain("Blocked follow-up");

			snapshot = {
				action: "update",
				params: {},
				tasks: [
					{ id: 1, subject: "Finish prerequisite", status: "completed" },
					{ id: 2, subject: "Blocked follow-up", status: "pending", blockedBy: [1] },
				],
				nextId: 3,
			};
			await pi.emit("session_start", {}, ctx);
			await pi.emit("agent_end", {}, ctx);
			expect(pi.sentMessages).toHaveLength(2);
			expect(pi.sentMessages[1]).toContain("#2 [pending] Blocked follow-up");
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		}
	});

	test.serial("defers auto-nudge while ask_user is pending", async () => {
		const extension = (await import("../src/todo/index.js")).default;
		const pi = new FakePi();
		const snapshot = { action: "create", params: {}, tasks: [{ id: 1, subject: "Need answer", status: "in_progress", activeForm: "waiting" }], nextId: 2 };
		const ctx = {
			hasUI: false,
			sessionManager: { getBranch: () => [{ type: "message", message: { role: "toolResult", toolName: "todo", details: snapshot } }] },
			isIdle: () => true,
			hasPendingMessages: () => false,
		};
		const originalSetTimeout = globalThis.setTimeout;
		const originalClearTimeout = globalThis.clearTimeout;
		globalThis.setTimeout = ((callback: TimerHandler) => {
			if (typeof callback === "function") callback();
			return 1 as any;
		}) as any;
		globalThis.clearTimeout = (() => {}) as any;
		try {
			extension(pi as any);
			await pi.emit("session_start", {}, ctx);
			await pi.emit("tool_execution_start", { toolName: "ask_user", toolCallId: "ask-1" }, ctx);
			await pi.emit("agent_end", {}, ctx);
			expect(pi.sentMessages).toHaveLength(0);

			await pi.emit("tool_execution_end", { toolName: "ask_user", toolCallId: "ask-1", isError: false }, ctx);
			await pi.emit("agent_end", {}, ctx);
			expect(pi.sentMessages).toHaveLength(1);
			expect(pi.sentMessages[0]).toContain("#1 [in_progress] Need answer — waiting");
		} finally {
			globalThis.setTimeout = originalSetTimeout;
			globalThis.clearTimeout = originalClearTimeout;
		}
	});
});
