import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { AppSubagentsWidgetController } from "../src/app/subagents/subagents-widget-controller.js";
import type { SubagentRegistry } from "../src/app/types.js";

type RefreshableController = {
	refreshFromFiles(): Promise<void>;
};

type FileChangeController = {
	handleSubagentsFilesChanged(): void;
};

describe("subagents widget controller", () => {
	it("ignores active registry runs from other parent sessions", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pix-subagents-"));
		try {
			const currentSession = join(cwd, "current.jsonl");
			const foreignRunDir = await writeRun(cwd, "foreign-run", "agent-1", join(cwd, "foreign.jsonl"));
			await writeRegistry(cwd, [registryRun("foreign-run", foreignRunDir, "agent-1", "2026-05-30T11:00:00.000Z")], "foreign-run");

			const controller = newController(cwd, currentSession);
			await (controller as unknown as RefreshableController).refreshFromFiles();

			assert.equal(controller.widgetState, undefined);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("uses active registry runs owned by the current parent session even when latest is foreign", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pix-subagents-"));
		try {
			const currentSession = join(cwd, "current.jsonl");
			const ownedRunDir = await writeRun(cwd, "owned-run", "owned-agent", currentSession);
			const foreignRunDir = await writeRun(cwd, "foreign-run", "foreign-agent", join(cwd, "foreign.jsonl"));
			await writeRegistry(cwd, [
				registryRun("owned-run", ownedRunDir, "owned-agent", "2026-05-30T10:00:00.000Z"),
				registryRun("foreign-run", foreignRunDir, "foreign-agent", "2026-05-30T11:00:00.000Z"),
			], "foreign-run");

			const controller = newController(cwd, currentSession);
			await (controller as unknown as RefreshableController).refreshFromFiles();

			assert.equal(controller.widgetState?.runDir, ownedRunDir);
			assert.deepEqual(controller.widgetState?.agents.map((agent) => [agent.id, agent.status]), [["owned-agent", "planned"]]);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

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
		controller.stopPolling();
	});

	it("does not show historical subagent snapshots synchronously", () => {
		const controller = newController("/tmp/project", "/tmp/project/current.jsonl", false);

		controller.observeToolResult("subagents", {
			runDir: "/tmp/project/.pi/subagents/old-run",
			agents: [{ id: "agent-1", status: "running" }],
			mode: "status",
		}, { showSnapshot: false });

		assert.equal(controller.widgetState, undefined);
		controller.stopPolling();
	});

	it("clears active snapshot when its run directory disappears", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pix-subagents-"));
		try {
			const currentSession = join(cwd, "current.jsonl");
			const missingRunDir = join(cwd, ".pi", "subagents", "missing-run");
			const controller = newController(cwd, currentSession);

			controller.observeToolResult("subagents", {
				runDir: missingRunDir,
				agents: [{ id: "agent-1", status: "running" }],
				mode: "spawn",
			});
			assert.equal(controller.widgetState?.runDir, missingRunDir);

			await (controller as unknown as RefreshableController).refreshFromFiles();

			assert.equal(controller.widgetState, undefined);
			controller.stopPolling();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("keeps file-change refresh scoped to the active session tab", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pix-subagents-"));
		try {
			const currentSession = join(cwd, "current.jsonl");
			const foreignRunDir = await writeRun(cwd, "foreign-run", "foreign-agent", join(cwd, "foreign.jsonl"));
			await writeRegistry(cwd, [registryRun("foreign-run", foreignRunDir, "foreign-agent", "2026-05-30T11:00:00.000Z")], "foreign-run");

			const controller = newController(cwd, currentSession);
			(controller as unknown as FileChangeController).handleSubagentsFilesChanged();
			await delay(150);
			assert.equal(controller.widgetState, undefined);

			const ownedRunDir = await writeRun(cwd, "owned-run", "owned-agent", currentSession);
			await writeRegistry(cwd, [
				registryRun("owned-run", ownedRunDir, "owned-agent", "2026-05-30T10:00:00.000Z"),
				registryRun("foreign-run", foreignRunDir, "foreign-agent", "2026-05-30T11:00:00.000Z"),
			], "foreign-run");

			(controller as unknown as FileChangeController).handleSubagentsFilesChanged();
			await waitFor(() => controller.widgetState?.runDir === ownedRunDir);
			const state = controller.widgetState as unknown as { agents: { id: string; status: string }[] } | undefined;
			assert.ok(state);
			assert.deepEqual(state.agents.map((agent) => [agent.id, agent.status]), [["owned-agent", "planned"]]);
			controller.stopPolling();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

function newController(cwd: string, currentSession: string, running = true): AppSubagentsWidgetController {
	return new AppSubagentsWidgetController({
		cwd,
		sessionFile: () => currentSession,
		isRunning: () => running,
		render: () => {},
	});
}

async function writeRun(cwd: string, runId: string, agentId: string, parentSession: string): Promise<string> {
	const runDir = join(cwd, ".pi", "subagents", runId);
	const agentDir = join(runDir, agentId);
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "prompt.md"), "prompt", "utf8");
	await writeFile(join(agentDir, "parent_session"), parentSession, "utf8");
	return runDir;
}

function registryRun(runId: string, runDir: string, agentId: string, updatedAt: string): SubagentRegistry["runs"][string] {
	return {
		runId,
		runDir,
		agentIds: [agentId],
		createdAt: updatedAt,
		updatedAt,
	};
}

async function writeRegistry(cwd: string, runs: SubagentRegistry["runs"][string][], latestRunId: string): Promise<void> {
	const registry: SubagentRegistry = {
		version: 1,
		runs: Object.fromEntries(runs.map((run) => [run.runId, run])),
		agents: Object.fromEntries(runs.flatMap((run) => run.agentIds.map((agentId) => [agentId, {
			agentId,
			runId: run.runId,
			runDir: run.runDir,
			updatedAt: run.updatedAt,
		}]))),
		latestRunId,
		latestRunDir: runs.find((run) => run.runId === latestRunId)?.runDir,
	};

	const registryPath = join(cwd, ".pi", "subagents", "registry.json");
	await mkdir(join(cwd, ".pi", "subagents"), { recursive: true });
	await writeFile(registryPath, JSON.stringify(registry), "utf8");
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (predicate()) return;
		await delay(25);
	}
	assert.equal(predicate(), true);
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}
