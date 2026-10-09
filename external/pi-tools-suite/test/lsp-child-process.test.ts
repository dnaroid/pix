import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { terminateChild } from "../src/lsp/child-process.js";

function spawnNode(script: string): ChildProcessWithoutNullStreams {
	return spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
}

function expectExitDelivered(child: ChildProcessWithoutNullStreams): void {
	// A signal-killed child keeps exitCode null but reports signalCode.
	expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
}

describe("terminateChild", () => {
	test("resolves only after the child exit event, including self-exited children", async () => {
		const child = spawnNode("process.exit(0)");
		// No external kill is required: whatever the signal outcome, awaiting
		// terminateChild must guarantee the exit event was delivered.
		await terminateChild(child);
		expectExitDelivered(child);
	});

	test("reaps a live child that ignores cooperative shutdown", async () => {
		const child = spawnNode("setInterval(() => {}, 1000)");
		await terminateChild(child);
		expectExitDelivered(child);
	});
});
