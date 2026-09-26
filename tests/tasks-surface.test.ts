import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { TasksWorkspaceToolSurface } from "../src/app/workspace-tools/tasks-surface.js";

describe("TasksWorkspaceToolSurface", () => {
	it("loads JSONC on open and persists explicit mouse actions only", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pix-tasks-surface-"));
		try {
			await mkdir(join(cwd, ".pi"));
			await writeFile(join(cwd, ".pi", "tasks.jsonc"), `{
				// project task fixture
				"version": 1,
				"tasks": [{
					"id": "task-1",
					"title": "Port panels",
					"type": "feature",
					"status": "todo",
					"priority": "medium",
					"createdAt": "2026-09-26T00:00:00.000Z",
					"updatedAt": "2026-09-26T00:00:00.000Z",
				}],
			}\n`);
			let runTitle = "";
			const surface = new TasksWorkspaceToolSurface({
				cwd,
				render: () => {},
				runTask: (task) => { runTitle = task.title; },
			});

			await surface.open();
			assert.match(surface.snapshot().lines.map((line) => line.text).join("\n"), /Port panels/);
			assert.equal(surface.snapshot().lines.some((line) => line.action === "status-next" && line.control === "button"), true);
			await surface.activate("status-next");
			const saved = JSON.parse(await readFile(join(cwd, ".pi", "tasks.jsonc"), "utf8"));
			assert.equal(saved.tasks[0].status, "in-progress");

			await surface.activate("run-selected");
			assert.equal(runTitle, "Port panels");
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	it("requires initialized .pi state before creating tasks", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pix-tasks-uninitialized-"));
		try {
			const surface = new TasksWorkspaceToolSurface({ cwd, render: () => {}, runTask: () => {} });
			await surface.open();
			surface.handleInput("a");
			surface.handleInput("New task");
			surface.handleInput("\r");
			surface.handleInput("\r");
			surface.handleInput("\r");
			surface.handleInput("\r");
			surface.handleInput("\r");
			await settle();
			assert.match(surface.snapshot().lines.map((line) => line.text).join("\n"), /not initialized/i);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 20));
}
