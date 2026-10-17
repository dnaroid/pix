import { expect, test } from "bun:test";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dir, "../../..");
const fixture = path.join(import.meta.dir, "fixtures/headless-broker-lifecycle.mjs");

const scenarios = [
	{ label: "dead-PID status until durable done receipt", status: "done", receipt: "0" },
	{ label: "dead-PID status until durable failed receipt", status: "failed", receipt: "1" },
	{ label: "dead-PID status until durable stopped receipt", status: "stopped", receipt: "stopped" },
	{ label: "retry backoff despite a stale failed receipt", status: "done", receipt: "0", mode: "retry" },
	{ label: "a stopped snapshot racing failure + retry receipt publication", status: "done", receipt: "0", mode: "stale-status" },
	{ label: "a temporarily missing agent", status: "done", receipt: "0", mode: "missing-agent" },
	{ label: "a transient poll failure", status: "done", receipt: "0", mode: "poll-error" },
	{ label: "all scheduled agents, not just the first receipt", status: "done", receipt: "0", mode: "multiple" },
	{ label: "optional request IDs using resolved task previews", status: "done", receipt: "0", mode: "resolved-id" },
	{ label: "external cleanup without leaking its referenced poll", status: "done", receipt: "0", mode: "cleanup" },
];
for (const { label, status, receipt, mode } of scenarios) {
	test(`broker stays alive through ${label}`, async () => {
		const artifacts = path.join(root, ".pi/artifacts");
		await mkdir(artifacts, { recursive: true });
		const scratch = await mkdtemp(path.join(artifacts, "headless-broker-lifecycle-"));
		try {
			await execFile("node", ["--import", "tsx", fixture, scratch, status, receipt, mode ?? ""], { cwd: root, timeout: 5_000 });
			const observed = await readFile(path.join(scratch, "observed-receipt"), "utf8").catch(() => "missing");
			if (mode === "cleanup") expect(observed).toBe("removed");
			else {
				expect(observed).toBe(receipt);
				const diagnostic = await readFile(path.join(scratch, ".pi/artifacts/subagents/broker-batch-headless-broker.log"), "utf8");
				expect(diagnostic).toContain("broker_pid=");
				expect(diagnostic).toContain(mode === "poll-error" ? "controlled transient wait failure" : "awaiting completion receipts");
			}
		} finally {
			await rm(scratch, { recursive: true, force: true });
		}
	});
}
