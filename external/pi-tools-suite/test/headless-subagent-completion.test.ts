import { expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { waitForHeadlessSubagentCompletion } from "./fixtures/headless-subagent-completion.js";

const artifacts = path.resolve(import.meta.dir, "../../../.pi/artifacts");
const SCOPE = "11111111-1111-4111-8111-111111111111";

async function fixture(): Promise<{ cwd: string; runDir: string; record: (data: Record<string, unknown>) => Promise<void> }> {
	await mkdir(artifacts, { recursive: true });
	const cwd = await mkdtemp(path.join(artifacts, "headless-completion-"));
	const scopeDir = path.join(cwd, ".pi", "subagents", SCOPE);
	await mkdir(scopeDir, { recursive: true });
	const record = (data: Record<string, unknown>) => appendFile(path.join(scopeDir, "headless-parent.jsonl"),
		`${JSON.stringify({ type: "custom", customType: "pi-tools-suite:subagent", data: { version: 1, scope: SCOPE, batch: "batch", agentId: "agent", ...data } })}\n`);
	return { cwd, runDir: path.join(scopeDir, "batch"), record };
}

test("headless completion waits through dead-PID status until the broker commits its receipt", async () => {
	const { cwd, runDir, record } = await fixture();
	try {
		await record({ status: "running" });
		let calls = 0;
		const result = await waitForHeadlessSubagentCompletion(runDir, "agent", async () => {
			if (++calls === 1) return "stopped";
			await record({ status: "done", exitCode: 0, finishedAt: new Date().toISOString() });
			return "done";
		}, { intervalMs: 0 });
		expect(result).toBe("done");
		expect(calls).toBe(3);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("headless completion ignores a failed attempt whose retry is pending", async () => {
	const { cwd, runDir, record } = await fixture();
	try {
		await record({ status: "retrying", exitCode: 1, finishedAt: new Date().toISOString() });
		await expect(waitForHeadlessSubagentCompletion(runDir, "agent", async () => "failed", { timeoutMs: 0 }))
			.rejects.toThrow("receipt=missing");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("headless completion preserves durable failure and stop outcomes", async () => {
	const { cwd, runDir, record } = await fixture();
	try {
		await record({ status: "failed", exitCode: 1, finishedAt: new Date().toISOString() });
		expect(await waitForHeadlessSubagentCompletion(runDir, "agent", async () => "failed")).toBe("failed");
		await record({ status: "stopped", exitCode: null });
		expect(await waitForHeadlessSubagentCompletion(runDir, "agent", async () => "stopped")).toBe("stopped");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("headless completion times out with diagnostics if its broker never commits", async () => {
	const { cwd, runDir } = await fixture();
	try {
		await expect(waitForHeadlessSubagentCompletion(runDir, "agent", async () => "stopped", { timeoutMs: 0 }))
			.rejects.toThrow("status=stopped, receipt=missing");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
