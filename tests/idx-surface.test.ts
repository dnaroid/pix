import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { IdxWorkspaceToolSurface, type IdxSurfaceDeps } from "../src/app/workspace-tools/idx-surface.js";
import type { AsyncProcessResult } from "../src/app/process.js";

describe("IdxWorkspaceToolSurface", () => {
	it("loads only on open and keeps a user-started operation visible until its foreground refresh completes", async () => {
		const calls: string[][] = [];
		let resolveIndex!: (result: AsyncProcessResult) => void;
		const indexResult = new Promise<AsyncProcessResult>((resolve) => { resolveIndex = resolve; });
		let statusReads = 0;
		const deps: IdxSurfaceDeps = {
			commandExists: async () => true,
			exists: async () => true,
			runProcess: async (_command, args = []) => {
				calls.push([...args]);
				if (args[0] === "--version") return ok("idx 1.2.3");
				if (args[0] === "index" && args[1] === "--status") {
					statusReads += 1;
					return ok(`status-${statusReads}`);
				}
				if (args.length === 1 && args[0] === "index") return await indexResult;
				return ok();
			},
		};
		const surface = new IdxWorkspaceToolSurface({ cwd: "/workspace", render: () => {} }, deps);

		await surface.open();
		assert.deepEqual(calls, [["--version"], ["index", "--status"]]);
		assert.equal(surface.canClose(), true);

		assert.equal(surface.snapshot().lines.some((line) => line.action === "index-update" && line.control === "button"), true);
		void surface.activate("index-update");
		assert.equal(surface.canClose(), false);
		resolveIndex(ok("indexed"));
		await settle();
		assert.equal(surface.canClose(), true);
		assert.equal(statusReads, 2, "maintenance performs exactly one linked status refresh");
	});
});

function ok(stdout = ""): AsyncProcessResult {
	return { status: 0, signal: null, stdout, stderr: "" };
}

async function settle(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 10));
}
