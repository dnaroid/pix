import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnAgent } from "../../src/async-subagents/core/spawn.js";
import { getAgentState } from "../../src/async-subagents/core/state.js";
import { setOwnedRetirementPrintForTest } from "../../src/async-subagents/core/owned-retirement.js";
const CLAUDE_PROVIDER_STUB = fileURLToPath(new URL("./fixtures/claude-provider-stub", import.meta.url));

// Inject only the native launch boundary; spawn/state/receipt integration
// runs unchanged. No real process, provider, or launchd is used: the
// retirement verifier's launchctl boundary is replaced process-wide.
let currentProcess: FakeProcess;
let ownerDir: string;
let bridgeStops = 0;
/** Whether the fake launch publishes the claim-protocol declaration. */
let claimProtocol = false;
// Valid label shapes are required: completion now settles only at the
// retirement boundary, whose proof resolves the exact labels from the
// metadata pointer.
const LABEL_SUPERVISOR = "org.pix.owned-launch.22222222-2222-4222-8222-222222222222";
const LABEL_WORKER = "org.pix.owned-launch.33333333-3333-4333-8333-333333333333";
class FakeProcess extends EventEmitter {
	pid = 12345;
	stdin = new PassThrough();
	stdout = new PassThrough();
	stderr = new PassThrough();
	kill() { bridgeStops++; return true; }
	unref() {}
}
const launch = (options: { agentDir: string }) => {
		ownerDir = path.join(options.agentDir, "owned-launch", "11111111-1111-4111-8111-111111111111");
		fs.mkdirSync(ownerDir, { recursive: true });
		if (claimProtocol) fs.writeFileSync(path.join(ownerDir, "claim_protocol"), "claim_protocol=1\n");
		fs.writeFileSync(path.join(options.agentDir, "owned_launch"), JSON.stringify({
			runDir: ownerDir, labelSupervisor: LABEL_SUPERVISOR, labelWorker: LABEL_WORKER,
		}));
		currentProcess = new FakeProcess();
		return {
			pid: currentProcess.pid, process: currentProcess, runDir: ownerDir,
			labelSupervisor: LABEL_SUPERVISOR, labelWorker: LABEL_WORKER,
			stop: () => { currentProcess.kill(); },
		};
	};
const roots: string[] = [];
const originalPlatform = process.platform;
afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform });
	setOwnedRetirementPrintForTest(undefined);
	claimProtocol = false;
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function start(timeoutMs = 5_000) {
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	setOwnedRetirementPrintForTest(async () => "absent");
	bridgeStops = 0;
	const run = fs.mkdtempSync(path.join(os.tmpdir(), "owned-early-"));
	roots.push(run);
	const task = { id: "agent", task: "offline", model: "pi-claude-code-provider/sonnet" };
	const completions: number[] = [];
	const spawned = spawnAgent(run, task, run, [], undefined, (completion) => completions.push(completion.exitCode), {
		ownedBinaries: { bridge: "fake", gate: "fake", supervisor: "fake" }, timeoutMs,
		locateProviderPackagesForTest: () => [CLAUDE_PROVIDER_STUB], ownedLaunchForTest: launch as any,
	});
	const agentDir = spawned.agentDir;
	const drain = () => {
		fs.writeFileSync(path.join(ownerDir, "owned.json"), `role=owned boot=1.000001 cid=abc worker_pid=1 worker_pidversion=1 worker_token=${"ab".repeat(32)} journaled_at=1\n`);
		fs.writeFileSync(path.join(ownerDir, "drain.json"), "role=drain status=ok cause=cancel boot=1.000001 cid=abc sup_cid=def started=2 exited=2 esrch=0 mismatch=0 at=1\n");
	};
	return { run, agentDir, completions, drain };
}

// The background settle loop polls on a 1s interval; waits must cross it.
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SETTLE_WAIT_MS = 1_300;

describe("owned runtime early completion", () => {
	test("agent_settled cannot finalize early; callback waits for journal-bound receipt", async () => {
		const f = start();
		currentProcess.stdout.write('{"type":"agent_end","result":"done"}\n{"type":"agent_settled"}\n');
		await wait(1150); // existing 1s fallback would have reported success
		expect(f.completions).toEqual([]);
		expect(fs.existsSync(path.join(f.agentDir, "exit_code"))).toBe(false);
		expect(fs.existsSync(path.join(ownerDir, "cancel"))).toBe(true);
		expect(bridgeStops).toBe(0);
		currentProcess.stdout.end();
		currentProcess.emit("exit", 143, null);
		await wait(40);
		expect(f.completions).toEqual([]);
		f.drain();
		await wait(SETTLE_WAIT_MS);
		expect(f.completions).toEqual([0]);
		expect(getAgentState(f.run, "agent")?.status).toBe("done");
		expect(fs.existsSync(path.join(f.agentDir, "process_group"))).toBe(false);
	});

	test("intentional settled cancellation preserves the RPC failure instead of reporting 143", async () => {
		const f = start();
		const message = { role: "assistant", stopReason: "error", errorMessage: "offline provider failure", content: [] };
		currentProcess.stdout.write(JSON.stringify({ type: "message_end", message }) + "\n" +
			JSON.stringify({ type: "agent_end", messages: [message] }) + '\n{"type":"agent_settled"}\n');
		await wait(1150);
		currentProcess.stdout.end();
		currentProcess.emit("exit", 143, null);
		await wait(40);
		expect(f.completions).toEqual([]);
		f.drain();
		await wait(SETTLE_WAIT_MS);
		expect(f.completions).toEqual([1]);
		expect(getAgentState(f.run, "agent")?.status).toBe("failed");
	});

	test("prompt failure and bridge exit cannot release without receipt", async () => {
		const f = start();
		currentProcess.stdout.write('{"type":"response","command":"prompt","success":false,"error":"rejected"}\n');
		await wait(30);
		currentProcess.stdout.end();
		currentProcess.emit("exit", 125, null);
		await wait(70);
		expect(f.completions).toEqual([]);
		expect(fs.existsSync(path.join(f.agentDir, "exit_code"))).toBe(false);
		expect(getAgentState(f.run, "agent")?.status).toBe("running");
		f.drain();
		await wait(SETTLE_WAIT_MS);
		expect(f.completions).toEqual([1]);
	});

	test("timeout cannot publish 124 without a verified drain", async () => {
		const f = start(50);
		await wait(95);
		expect(fs.existsSync(path.join(ownerDir, "cancel"))).toBe(true);
		currentProcess.stdout.end();
		currentProcess.emit("exit", 125, null);
		await wait(50);
		expect(f.completions).toEqual([]);
		f.drain();
		await wait(SETTLE_WAIT_MS);
		expect(f.completions).toEqual([124]);
	});

	test("own reaped bridge that never claimed: settle fences the run and completes after retirement", async () => {
		claimProtocol = true;
		const f = start();
		currentProcess.stdout.end();
		currentProcess.emit("exit", 18, null);
		await wait(70);
		expect(f.completions).toEqual([]);
		// Bridge-end grace (2s) plus settle intervals: fence, then retirement.
		const end = Date.now() + 6_000;
		while (f.completions.length === 0 && Date.now() < end) await wait(100);
		expect(fs.readFileSync(path.join(ownerDir, "claim"), "utf8")).toBe("role=fence stage=restart-recovery\n");
		expect(f.completions.length).toBe(1);
		expect(f.completions[0]).not.toBe(0);
		expect(fs.existsSync(path.join(ownerDir, "retired"))).toBe(true);
	}, 10_000);

	test("own reaped bridge that DID claim stays pending without a receipt", async () => {
		claimProtocol = true;
		const f = start();
		fs.writeFileSync(path.join(ownerDir, "claim"), "role=bridge-claim pid=12345\n");
		currentProcess.stdout.end();
		currentProcess.emit("exit", 16, null);
		await wait(3_600);
		expect(f.completions).toEqual([]);
		expect(fs.readFileSync(path.join(ownerDir, "claim"), "utf8")).toBe("role=bridge-claim pid=12345\n");
		expect(getAgentState(f.run, "agent")?.status).toBe("running");
		f.drain();
		await wait(SETTLE_WAIT_MS);
		expect(f.completions.length).toBe(1);
	}, 10_000);
});
