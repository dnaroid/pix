import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppTodoWidgetController } from "../src/app/todo/todo-widget-controller.js";
import type { TodoDetails } from "../src/app/types.js";

describe("todo widget controller", () => {
	it("caches the latest successful todo details", () => {
		let renders = 0;
		const controller = new AppTodoWidgetController({
			isRunning: () => true,
			render: () => {
				renders += 1;
			},
		});
		const details: TodoDetails = {
			action: "list",
			params: {},
			nextId: 2,
			tasks: [{ id: 1, subject: "Ship", status: "pending" }],
		};

		controller.observeToolResult("todo", details);

		assert.equal(controller.widgetDetails, details);
		assert.equal(renders, 1);
	});

	it("updates from live todo state events for the current session", () => {
		let renders = 0;
		const controller = new AppTodoWidgetController({
			sessionFile: () => "/tmp/project/session.jsonl",
			isRunning: () => true,
			render: () => {
				renders += 1;
			},
		});
		const details: TodoDetails = {
			action: "list",
			params: {},
			nextId: 2,
			tasks: [{ id: 1, subject: "Ship", status: "in_progress" }],
		};

		controller.observeLiveState({
			version: 1,
			details,
			sessionFile: "/tmp/project/session.jsonl",
			checkedAt: Date.now(),
		});

		assert.equal(controller.widgetDetails, details);
		assert.equal(renders, 1);
	});

	it("clears cached details when only completed tasks remain", () => {
		let renders = 0;
		const controller = new AppTodoWidgetController({
			isRunning: () => true,
			render: () => {
				renders += 1;
			},
		});
		controller.observeToolResult("todo", {
			action: "list",
			params: {},
			nextId: 2,
			tasks: [{ id: 1, subject: "Ship", status: "pending" }],
		});

		controller.observeToolResult("todo", {
			action: "update",
			params: {},
			nextId: 2,
			tasks: [{ id: 1, subject: "Ship", status: "completed" }],
		});

		assert.equal(controller.widgetDetails, undefined);
		assert.equal(renders, 2);
	});

	it("caches live todo state events for inactive sessions until they become current", () => {
		let currentSessionFile = "/tmp/project/current.jsonl";
		let renders = 0;
		const controller = new AppTodoWidgetController({
			sessionFile: () => currentSessionFile,
			isRunning: () => true,
			render: () => {
				renders += 1;
			},
		});
		const inactiveDetails: TodoDetails = {
			action: "list",
			params: {},
			nextId: 2,
			tasks: [{ id: 1, subject: "Foreign", status: "pending" }],
		};

		controller.observeLiveState({
			version: 1,
			details: inactiveDetails,
			sessionFile: "/tmp/project/other.jsonl",
			checkedAt: Date.now(),
		});

		assert.equal(controller.widgetDetails, undefined);
		assert.equal(renders, 0);

		currentSessionFile = "/tmp/project/other.jsonl";

		assert.equal(controller.widgetDetails, inactiveDetails);
	});

	it("keeps scoped todo details across session view resets", () => {
		let currentSessionFile = "/tmp/project/current.jsonl";
		const controller = new AppTodoWidgetController({
			sessionFile: () => currentSessionFile,
			isRunning: () => true,
			render: () => {},
		});
		const details: TodoDetails = {
			action: "list",
			params: {},
			nextId: 2,
			tasks: [{ id: 1, subject: "Ship", status: "pending" }],
		};

		controller.observeLiveState({
			version: 1,
			details,
			sessionFile: currentSessionFile,
			checkedAt: Date.now(),
		});

		controller.reset();

		assert.equal(controller.widgetDetails, details);

		currentSessionFile = "/tmp/project/other.jsonl";

		assert.equal(controller.widgetDetails, undefined);
	});

	it("ignores non-todo, invalid, and error results", () => {
		const controller = new AppTodoWidgetController({ isRunning: () => true, render: () => {} });
		const details: TodoDetails = {
			action: "list",
			params: {},
			nextId: 2,
			tasks: [{ id: 1, subject: "Ship", status: "pending" }],
		};

		controller.observeToolResult("shell", details);
		controller.observeToolResult("todo", { action: "list" });
		controller.observeToolResult("todo", details, true);
		controller.observeToolResult("todo", { ...details, error: "failed" });

		assert.equal(controller.widgetDetails, undefined);
	});

	it("clears cached details on reset", () => {
		const controller = new AppTodoWidgetController({ isRunning: () => false, render: () => {} });
		controller.observeToolResult("todo", {
			action: "list",
			params: {},
			nextId: 2,
			tasks: [{ id: 1, subject: "Ship", status: "pending" }],
		});

		controller.reset();

		assert.equal(controller.widgetDetails, undefined);
	});
});
