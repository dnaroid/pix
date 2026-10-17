import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { AppSubagentsWidgetController } from "../src/app/subagents/subagents-widget-controller.js";

describe("subagents widget controller", () => {
	it("clears current-session subagents on reset", () => {
		const controller = newController("/tmp/project", "/tmp/project/current.jsonl", false);

		controller.observeToolResult("subagents", {
			runDir: "/tmp/project/.pi/subagents/owned-run",
			agents: [{ id: "agent-1", status: "running" }],
			mode: "spawn",
		});
		assert.equal(controller.widgetState?.runDir, resolve("/tmp/project/.pi/subagents/owned-run"));

		controller.reset();

		assert.equal(controller.widgetState, undefined);
	});

	it("ignores late live-state events after the active runtime is detached for a draft tab", () => {
		let hasActiveRuntime = true;
		let currentSession: string | undefined = "/tmp/project/current.jsonl";
		const controller = new AppSubagentsWidgetController({
			cwd: "/tmp/project",
			hasActiveRuntime: () => hasActiveRuntime,
			sessionFile: () => currentSession,
			isRunning: () => false,
			render: () => {},
		});

		controller.observeLiveState({
			version: 1,
			count: 1,
			sessionFile: currentSession,
			checkedAt: Date.now(),
			runs: [{ runDir: "/tmp/project/.pi/subagents/run-a", agents: [{ id: "agent-a", status: "running" }] }],
		});
		assert.equal(controller.widgetState?.agents[0]?.id, "agent-a");

		controller.reset();
		hasActiveRuntime = false;
		currentSession = undefined;
		controller.observeLiveState({
			version: 1,
			count: 1,
			sessionFile: "/tmp/project/current.jsonl",
			checkedAt: Date.now(),
			runs: [{ runDir: "/tmp/project/.pi/subagents/run-a", agents: [{ id: "agent-a", status: "running" }] }],
		});

		assert.equal(controller.widgetState, undefined);

		hasActiveRuntime = true;
		currentSession = "/tmp/project/other.jsonl";
		assert.equal(controller.widgetState, undefined);
	});

	it("does not show historical subagent snapshots synchronously", () => {
		const controller = newController("/tmp/project", "/tmp/project/current.jsonl", false);

		controller.observeToolResult("subagents", {
			runDir: "/tmp/project/.pi/subagents/old-run",
			agents: [{ id: "agent-1", status: "running" }],
			mode: "status",
		}, { showSnapshot: false });

		assert.equal(controller.widgetState, undefined);
	});

	it("clears the active snapshot when a live-state event reports no active runs", () => {
		const controller = newController("/tmp/project", "/tmp/project/current.jsonl", false);

		controller.observeToolResult("subagents", {
			runDir: "/tmp/project/.pi/subagents/scope/batch-a",
			agents: [{ id: "agent-1", status: "running" }],
			mode: "spawn",
		});
		assert.equal(controller.widgetState?.runDir, resolve("/tmp/project/.pi/subagents/scope/batch-a"));

		controller.observeLiveState({
			version: 1,
			count: 0,
			sessionFile: "/tmp/project/current.jsonl",
			checkedAt: Date.now(),
			runs: [],
		});

		assert.equal(controller.widgetState, undefined);
	});

	it("shows all active runs from a live-state event instead of choosing only one", () => {
		const controller = newController("/tmp/project", "/tmp/project/current.jsonl", false);

		controller.observeLiveState({
			version: 1,
			count: 2,
			sessionFile: "/tmp/project/current.jsonl",
			checkedAt: Date.now(),
			runs: [
				{ runDir: "/tmp/project/.pi/subagents/run-a", agents: [{ id: "agent-a", status: "running" }] },
				{ runDir: "/tmp/project/.pi/subagents/run-b", agents: [{ id: "agent-b", status: "running" }] },
			],
		});

		assert.deepEqual(controller.widgetState?.runs?.map((run) => run.runDir), [
			resolve("/tmp/project/.pi/subagents/run-a"),
			resolve("/tmp/project/.pi/subagents/run-b"),
		]);
		assert.deepEqual(controller.widgetState?.agents.map((agent) => agent.id), ["agent-a", "agent-b"]);
	});

	it("sorts live-state runs by freshest startedAt", () => {
		const controller = newController("/tmp/project", "/tmp/project/current.jsonl", false);

		controller.observeLiveState({
			version: 1,
			count: 2,
			sessionFile: "/tmp/project/current.jsonl",
			checkedAt: Date.now(),
			runs: [
				{ runDir: "/tmp/project/.pi/subagents/run-a", agents: [{ id: "agent-a", status: "running", startedAt: "2026-05-30T10:00:00.000Z" }] },
				{ runDir: "/tmp/project/.pi/subagents/run-b", agents: [{ id: "agent-b", status: "running", startedAt: "2026-05-30T11:00:00.000Z" }] },
			],
		});

		assert.deepEqual(controller.widgetState?.runs?.map((run) => run.runDir), [
			resolve("/tmp/project/.pi/subagents/run-b"),
			resolve("/tmp/project/.pi/subagents/run-a"),
		]);
		assert.deepEqual(controller.widgetState?.agents.map((agent) => agent.id), ["agent-b", "agent-a"]);
	});
});

function newController(cwd: string, currentSession: string, running = true): AppSubagentsWidgetController {
	return new AppSubagentsWidgetController({
		cwd,
		hasActiveRuntime: () => true,
		sessionFile: () => currentSession,
		isRunning: () => running,
		render: () => {},
	});
}
