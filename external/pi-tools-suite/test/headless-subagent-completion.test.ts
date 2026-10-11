import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { waitForHeadlessSubagentCompletion } from "./fixtures/headless-subagent-completion.js";

const artifacts = path.resolve(import.meta.dir, "../../../.pi/artifacts");

test("headless completion waits through dead-PID status until the broker commits its receipt", async () => {
	await mkdir(artifacts, { recursive: true });
	const runDir = await mkdtemp(path.join(artifacts, "headless-completion-"));
	try {
		await mkdir(path.join(runDir, "agent"));
		let calls = 0;
		const result = await waitForHeadlessSubagentCompletion(runDir, "agent", async () => {
			if (++calls === 1) return "stopped";
			await writeFile(path.join(runDir, "agent", "exit_code"), "0");
			return "done";
		}, { intervalMs: 0 });
		expect(result).toBe("done");
		expect(calls).toBe(3);
	} finally {
		await rm(runDir, { recursive: true, force: true });
	}
});

test("headless completion preserves durable failure and stop outcomes", async () => {
	await mkdir(artifacts, { recursive: true });
	const runDir = await mkdtemp(path.join(artifacts, "headless-completion-"));
	try {
		await mkdir(path.join(runDir, "agent"));
		for (const [status, receipt] of [["failed", "1"], ["stopped", "stopped"]] as const) {
			await writeFile(path.join(runDir, "agent", "exit_code"), receipt);
			expect(await waitForHeadlessSubagentCompletion(runDir, "agent", async () => status)).toBe(status);
		}
	} finally {
		await rm(runDir, { recursive: true, force: true });
	}
});

test("headless completion times out with diagnostics if its broker never commits", async () => {
	await mkdir(artifacts, { recursive: true });
	const runDir = await mkdtemp(path.join(artifacts, "headless-completion-"));
	try {
		await expect(waitForHeadlessSubagentCompletion(runDir, "agent", async () => "stopped", { timeoutMs: 0 }))
			.rejects.toThrow("status=stopped, exit_code=missing");
	} finally {
		await rm(runDir, { recursive: true, force: true });
	}
});
