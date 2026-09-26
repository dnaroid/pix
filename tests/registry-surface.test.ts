import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RegistryWorkspaceToolSurface } from "../src/app/workspace-tools/registry-surface.js";
import type { RegistryCommandResult } from "../src/app/workspace-tools/registry-command-runner.js";

const STATUS = [
	"Registry: ssh://example.test/registry.git (main)",
	"",
	"↓ pdf  [SKILL]  **OUTDATED**",
	"↑ tasks.jsonc  [PROJECT]  **LOCAL CHANGES**",
].join("\n");

describe("RegistryWorkspaceToolSurface", () => {
	it("maps clicked registry controls to foreground primary actions", async () => {
		const calls: string[] = [];
		const surface = new RegistryWorkspaceToolSurface({
			cwd: "/workspace",
			render: () => {},
			runRegistryCommand: async (args) => {
				calls.push(args);
				return result(args === "status" ? STATUS : undefined);
			},
		});

		await surface.open();
		assert.match(surface.snapshot().lines.map((line) => line.text).join("\n"), /pdf/u);
		assert.equal(surface.snapshot().lines.some((line) => line.action === "primary" && line.control === "button"), true);
		await surface.activate("primary");
		assert.deepEqual(calls.slice(0, 3), ["status", "update skill pdf", "status"]);

		await surface.activate("item:1");
		await surface.activate("primary");
		assert.deepEqual(calls.slice(-2), ["push tasks", "status"]);
	});

	it("requires an explicit mouse confirmation before destructive reusable-resource actions", async () => {
		const calls: string[] = [];
		const surface = new RegistryWorkspaceToolSurface({
			cwd: "/workspace",
			render: () => {},
			runRegistryCommand: async (args) => {
				calls.push(args);
				return result(STATUS);
			},
		});
		await surface.open();
		await surface.activate("danger-remove");
		assert.deepEqual(calls, ["status"]);
		assert.equal(surface.snapshot().lines.some((line) => line.action === "danger-confirm"), true);
		await surface.activate("danger-confirm");
		assert.equal(calls.includes("remove skill pdf"), true);
	});
});

function result(statusText?: string): RegistryCommandResult {
	return { lines: [], errors: [], ...(statusText ? { statusText } : {}) };
}
