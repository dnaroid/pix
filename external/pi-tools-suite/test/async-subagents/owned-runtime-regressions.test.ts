// Deterministic mocked regressions for the four G1/T3 runtime-review
// blockers. No launchd, no native binaries, no provider, no real owned
// bridge: the native launch boundary is replaced (ownedLaunchForTest /
// launchPreparedOwnedAgent with fake binaries) and the retirement
// verifier's launchctl boundary is replaced process-wide. The only real
// subprocess is this test's own /bin/sleep canary, which exists to prove
// that a pointerless owned stop NEVER signals the saved (possibly reused)
// PID; it is only ever read and killed by the test itself.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { launchPreparedOwnedAgent, ownedOutcomeSync, type OwnedLaunchHandle } from "../../src/async-subagents/core/owned-launch-integration.js";
import {
	ownedArtifactsPresentSync,
	ownedDeletableSync,
	ownedSlotReleasedSync,
	setOwnedRetirementPrintForTest,
	verifyOwnedRetirementAsync,
} from "../../src/async-subagents/core/owned-retirement.js";
import { spawnAgent } from "../../src/async-subagents/core/spawn.js";
import { spawnAgentWithRetry } from "../../src/async-subagents/core/retry.js";
import { getAgentState } from "../../src/async-subagents/core/state.js";
import { stopAgents } from "../../src/async-subagents/core/stop.js";
import { deleteRunDirs, findCleanupCandidates } from "../../src/async-subagents/core/cleanup.js";
import type { OwnedLaunchBinaries } from "../../src/async-subagents/core/owned-launch/bootstrap.js";
const CLAUDE_PROVIDER_STUB = fileURLToPath(new URL("./fixtures/claude-provider-stub", import.meta.url));

const LABEL_SUPERVISOR = "org.pix.owned-launch.22222222-2222-4222-8222-222222222222";
const LABEL_WORKER = "org.pix.owned-launch.33333333-3333-4333-8333-333333333333";
const WORKER_TOKEN = "ab".repeat(32);
const JOURNAL = `role=owned boot=1.000001 cid=abc worker_pid=1 worker_pidversion=1 worker_token=${WORKER_TOKEN} journaled_at=1\n`;
const FAKE_BINARIES: OwnedLaunchBinaries = { bridge: "/nonexistent/owned-bridge", gate: "/nonexistent/owned-gate", supervisor: "/nonexistent/owned-supervisor" };

const roots: string[] = [];
const originalPlatform = process.platform;
afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
	setOwnedRetirementPrintForTest(undefined);
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, ms: number, label: string): Promise<void> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (predicate()) return;
		await wait(25);
	}
	throw new Error(`deadline: ${label}`);
}

/** Owned agent directory with surviving UUID artifacts (journal present, no drain yet). */
function ownedFixture(options: { pointer?: "valid" | "garbage" | "none" } = { pointer: "valid" }) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-regress-"));
	roots.push(root);
	const runDir = path.join(root, "runs", "r1");
	const agentDir = path.join(runDir, "agent");
	const owner = path.join(agentDir, "owned-launch", "11111111-1111-4111-8111-111111111111");
	fs.mkdirSync(owner, { recursive: true });
	fs.mkdirSync(path.join(runDir, "prompts"));
	fs.writeFileSync(path.join(runDir, "prompts", "agent.md"), "task");
	fs.writeFileSync(path.join(agentDir, "prompt.md"), "task");
	fs.writeFileSync(path.join(agentDir, "pid"), "99999999");
	fs.writeFileSync(path.join(owner, "owned.json"), JOURNAL);
	fs.writeFileSync(path.join(owner, "payload-exit.json"), "role=payload-exit code=0\n");
	if (options.pointer === "valid")
		fs.writeFileSync(path.join(agentDir, "owned_launch"), JSON.stringify({ runDir: owner, labelSupervisor: LABEL_SUPERVISOR, labelWorker: LABEL_WORKER }));
	else if (options.pointer === "garbage") fs.writeFileSync(path.join(agentDir, "owned_launch"), "{ not json");
	const receipt = (value = `role=drain status=fail cause=x boot=1.000001 cid=abc sup_cid=def started=2 exited=1 esrch=0 signaled=0 iterations=1 mismatch=0 at=1\n`) =>
		fs.writeFileSync(path.join(owner, "drain.json"), value);
	const retire = () => fs.writeFileSync(path.join(owner, "retired"), `${JSON.stringify({ labels: [LABEL_SUPERVISOR, LABEL_WORKER], verifiedAt: new Date().toISOString() })}\n`);
	return { root, runDir, agentDir, owner, receipt, retire };
}

describe("blocker 1: public stop with pointerless owned artifacts", () => {
	test("never signals the saved PID nor writes terminal state; durable cancel only", () => {
		const f = ownedFixture({ pointer: "none" });
		const canary = Bun.spawn(["/bin/sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		try {
			// The saved PID now names an unrelated live process (parent-restart
			// scenario). The pointerless owned stop must reconstruct everything
			// from the surviving UUID artifacts alone.
			fs.writeFileSync(path.join(f.agentDir, "pid"), String(canary.pid));
			expect(getAgentState(f.runDir, "agent")?.status).toBe("running");
			const outcome = stopAgents(f.runDir, ["agent"])[0];
			expect(outcome.stopped).toBe(false);
			expect(outcome.message).toContain("without a readable pointer");
			// Durable intent + per-run-dir cancel marker are written...
			expect(fs.existsSync(path.join(f.agentDir, "stop_requested"))).toBe(true);
			expect(fs.readFileSync(path.join(f.agentDir, "stop_signal"), "utf8")).toBe("SIGTERM");
			expect(fs.existsSync(path.join(f.owner, "cancel"))).toBe(true);
			// ...but never the legacy terminal writes, and never a PID signal.
			expect(fs.existsSync(path.join(f.agentDir, "exit_code"))).toBe(false);
			expect(fs.existsSync(path.join(f.agentDir, "finished_at"))).toBe(false);
			expect(fs.existsSync(path.join(f.agentDir, "result.md"))).toBe(false);
			expect(canary.exitCode).toBeNull();
			expect(getAgentState(f.runDir, "agent")?.status).toBe("running");
		} finally {
			canary.kill();
			canary.kill("SIGKILL");
		}
	});

	test("unreadable pointer fails closed without legacy PID signal or stopped write", () => {
		const f = ownedFixture({ pointer: "garbage" });
		const canary = Bun.spawn(["/bin/sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		try {
			fs.writeFileSync(path.join(f.agentDir, "pid"), String(canary.pid));
			const outcome = stopAgents(f.runDir, ["agent"])[0];
			expect(outcome.stopped).toBe(false);
			expect(outcome.message).toContain("durable cancel requested");
			expect(fs.existsSync(path.join(f.owner, "cancel"))).toBe(true);
			expect(fs.existsSync(path.join(f.agentDir, "exit_code"))).toBe(false);
			expect(canary.exitCode).toBeNull();
			expect(getAgentState(f.runDir, "agent")?.status).toBe("running");
		} finally {
			canary.kill();
			canary.kill("SIGKILL");
		}
	});
});

describe("blocker 2: synchronous pre-spawn failure releases the concurrency slot", () => {
	test("spec write failure rolls the fresh UUID directory back completely", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-regress-"));
		roots.push(root);
		const agentDir = path.join(root, "runs", "r1", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		// Oversized arg: writeOwnedLaunchSpec throws after the UUID directory
		// was created but before beforeSpawn could persist any pointer.
		expect(() => launchPreparedOwnedAgent({
			agentDir, command: "/bin/true", args: ["x".repeat(5000)], cwd: root, env: {}, binaries: FAKE_BINARIES,
		})).toThrow(/bytes/);
		// Transactional cleanup: no surviving artifact can hold the slot.
		expect(fs.readdirSync(path.join(agentDir, "owned-launch"))).toEqual([]);
		expect(fs.existsSync(path.join(agentDir, "owned_launch"))).toBe(false);
		expect(ownedArtifactsPresentSync(agentDir)).toBe(false);
		// ownedLaunchHoldsSlot(runDir, id) === artifacts && !slotReleased:
		// false, so tools/spawn.ts releases the acquired semaphore slot.
		expect(ownedArtifactsPresentSync(agentDir) && !ownedSlotReleasedSync(agentDir)).toBe(false);
	});

	test("bridge spawn failure leaves a provable never-launched marker and releases the slot", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		setOwnedRetirementPrintForTest(async () => "absent");
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-regress-"));
		roots.push(root);
		const runDir = path.join(root, "runs", "r1");
		const agentDir = path.join(runDir, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(path.join(runDir, "prompts"));
		fs.writeFileSync(path.join(runDir, "prompts", "agent.md"), "task");
		fs.writeFileSync(path.join(agentDir, "prompt.md"), "task");
		// beforeSpawn ran (pointer persisted), then the bridge binary could
		// not be exec'd: the launcher throws before exec, so no launchd job
		// can exist and the durable marker proves it.
		expect(() => launchPreparedOwnedAgent({
			agentDir, command: "/bin/true", args: [], cwd: root, env: {}, binaries: FAKE_BINARIES,
		})).toThrow(/failed to start/);
		const owner = fs.readdirSync(path.join(agentDir, "owned-launch")).map((uuid) => path.join(agentDir, "owned-launch", uuid));
		expect(owner).toHaveLength(1);
		expect(fs.existsSync(path.join(agentDir, "owned_launch"))).toBe(true);
		expect(fs.existsSync(path.join(owner[0], "bridge_launch_failed"))).toBe(true);
		expect(ownedOutcomeSync(agentDir).kind).toBe("launch-failed");
		// The slot is provably released even before retirement is cached...
		expect(ownedSlotReleasedSync(agentDir)).toBe(true);
		expect(ownedArtifactsPresentSync(agentDir) && !ownedSlotReleasedSync(agentDir)).toBe(false);
		// ...state recovers a truthful terminal failure...
		expect(getAgentState(runDir, "agent")?.status).toBe("failed");
		expect(getAgentState(runDir, "agent")?.exitCode).toBe(1);
		// ...and once the (trivially absent) jobs are verified, reuse is safe.
		expect(ownedDeletableSync(agentDir)).toBe(false);
		expect(verifyOwnedRetirementAsync(agentDir)).resolves.toBe(true);
	});
});

describe("blocker 3: receipt before service retirement never relaunches into the reuse guard", () => {
	class FakeProcess extends EventEmitter {
		pid = 12345;
		stdin = new PassThrough();
		stdout = new PassThrough();
		stderr = new PassThrough();
		kill() { return true; }
		unref() {}
	}
	let launches = 0;
	let processes: FakeProcess[] = [];
	let ownerDirs: string[] = [];
	const launch = (options: { agentDir: string }): OwnedLaunchHandle => {
		launches++;
		const uuid = `11111111-1111-4111-8111-11111111111${launches}`;
		const ownerDir = path.join(options.agentDir, "owned-launch", uuid);
		fs.mkdirSync(ownerDir, { recursive: true });
		ownerDirs.push(ownerDir);
		fs.writeFileSync(path.join(options.agentDir, "owned_launch"), JSON.stringify({
			runDir: ownerDir, labelSupervisor: LABEL_SUPERVISOR, labelWorker: LABEL_WORKER,
		}));
		const proc = new FakeProcess();
		processes.push(proc);
		return {
			pid: proc.pid,
			process: proc as unknown as OwnedLaunchHandle["process"],
			runDir: ownerDir,
			socketsDir: ownerDir,
			labelSupervisor: LABEL_SUPERVISOR,
			labelWorker: LABEL_WORKER,
			spec: {} as OwnedLaunchHandle["spec"],
			exited: Promise.resolve({ code: 0, signal: null }),
			stop: () => {},
		};
	};
	const journal = (ownerDir: string) =>
		fs.writeFileSync(path.join(ownerDir, "owned.json"), JOURNAL);
	const drainFail = (ownerDir: string) =>
		fs.writeFileSync(path.join(ownerDir, "drain.json"), "role=drain status=fail cause=x boot=1.000001 cid=abc sup_cid=def started=2 exited=2 esrch=0 signaled=0 iterations=1 mismatch=0 at=1\n");
	const drainOk = (ownerDir: string) =>
		fs.writeFileSync(path.join(ownerDir, "drain.json"), "role=drain status=ok cause=cancel boot=1.000001 cid=abc sup_cid=def started=2 exited=2 esrch=0 signaled=0 iterations=1 mismatch=0 at=1\n");
	const endAttempt = (proc: FakeProcess, agentEnd: boolean) => {
		if (agentEnd) proc.stdout.write('{"type":"agent_end","messages":[]}\n');
		proc.stdout.end();
		proc.emit("exit", agentEnd ? 0 : 1, null);
	};

	afterEach(() => {
		launches = 0;
		processes = [];
		ownerDirs = [];
	});

	test("drained attempt stays open while the exact UUID jobs are still present", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		let presence: "present" | "absent" = "present";
		setOwnedRetirementPrintForTest(async () => presence);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-regress-"));
		roots.push(root);
		const completions: number[] = [];
		const spawned = spawnAgent(root, { id: "agent", task: "regress", model: "pi-claude-code-provider/sonnet" }, root, [], undefined, (c) => completions.push(c.exitCode), {
			ownedBinaries: FAKE_BINARIES, timeoutMs: 300_000, locateProviderPackagesForTest: () => [CLAUDE_PROVIDER_STUB], ownedLaunchForTest: launch,
		});
		const agentDir = spawned.agentDir;
		// A journal-bound kernel-drained failure receipt exists, but the exact
		// launchd jobs are still booting out (receipt-before-bootout ordering).
		journal(ownerDirs[0]);
		drainFail(ownerDirs[0]);
		endAttempt(processes[0], false);
		// Cross at least one full settle cycle: no completion, no terminal
		// write — and (with retry) no relaunch into the reuse guard.
		await wait(1_400);
		expect(completions).toEqual([]);
		expect(launches).toBe(1);
		expect(fs.existsSync(path.join(agentDir, "exit_code"))).toBe(false);
		// Receipt visible but jobs still present: state/wait must stay
		// nonterminal so the polling loop keeps retrying the retirement proof.
		expect(getAgentState(root, "agent")?.status).toBe("running");
		// Jobs confirmed absent: the retirement marker is cached and only now
		// does the attempt finish.
		presence = "absent";
		await until(() => completions.length > 0, 4_000, "completion after retirement");
		expect(completions).toEqual([1]);
		expect(fs.existsSync(path.join(agentDir, "exit_code"))).toBe(true);
	}, 20_000);

	test("retry waits for retirement instead of dying at the reuse guard", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		let presence: "present" | "absent" = "present";
		setOwnedRetirementPrintForTest(async () => presence);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-regress-"));
		roots.push(root);
		const completions: number[] = [];
		const retry = spawnAgentWithRetry(root, { id: "agent", task: "regress", model: "pi-claude-code-provider/sonnet" }, root, (c) => completions.push(c.exitCode), {
			retry: { maxRetries: 1, backoffMs: 25 },
			ownedBinaries: FAKE_BINARIES,
			timeoutMs: 300_000,
			locateProviderPackagesForTest: () => [CLAUDE_PROVIDER_STUB], ownedLaunchForTest: launch,
		});
		const agentDir = retry.initial.agentDir;
		journal(ownerDirs[0]);
		drainFail(ownerDirs[0]);
		endAttempt(processes[0], false);
		await wait(1_400);
		// Receipt drained but jobs present: neither a completion nor a retry
		// relaunch may happen (the old behavior relaunched after ~1s and the
		// reuse guard killed the whole retry chain with an error).
		expect(completions).toEqual([]);
		expect(launches).toBe(1);
		expect(fs.existsSync(path.join(agentDir, "retry_pending"))).toBe(false);
		// Retirement proven: the retry chain proceeds into a clean relaunch.
		presence = "absent";
		await until(() => launches === 2, 6_000, "retry relaunch after retirement");
		expect(fs.existsSync(path.join(agentDir, "retry_count"))).toBe(true);
		journal(ownerDirs[1]);
		drainOk(ownerDirs[1]);
		endAttempt(processes[1], true);
		await until(() => completions.length > 0, 6_000, "final retry completion");
		expect(completions).toEqual([0]);
		await retry.done;
		expect(getAgentState(root, "agent")?.status).toBe("done");
	}, 30_000);
});

describe("blocker 4: unproven failure plus service absence is not kernel-zero", () => {
	test("retired unproven-fail never authorizes deletion; slot release needs never-released proof", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const f = ownedFixture();
		f.receipt(); // journal-bound? no: started=2 exited=1, esrch=0 => unproven-fail
		await verifyOwnedRetirementAsync(f.agentDir, { printServiceForTest: async () => "absent" });
		expect(ownedOutcomeSync(f.agentDir).kind).toBe("unproven-fail");
		expect(fs.existsSync(path.join(f.owner, "retired"))).toBe(true);
		// Both jobs confirmed absent, yet the failure is unproven and a
		// journal exists (a payload WAS released): retain the artifacts and
		// keep the concurrency slot held.
		expect(ownedDeletableSync(f.agentDir)).toBe(false);
		expect(ownedSlotReleasedSync(f.agentDir)).toBe(false);
		expect(() => deleteRunDirs([f.runDir])).toThrow("not verified drained");
		expect(findCleanupCandidates(path.dirname(f.runDir), 0, 0)).toEqual([]);
		// Removing the journal proves this failure never released a payload:
		// the slot may release, but deletion stays refused (artifacts retained).
		fs.rmSync(path.join(f.owner, "owned.json"));
		expect(ownedSlotReleasedSync(f.agentDir)).toBe(true);
		expect(ownedDeletableSync(f.agentDir)).toBe(false);
		expect(() => deleteRunDirs([f.runDir])).toThrow("not verified drained");
		// Truthful terminal state recovery is unaffected.
		expect(getAgentState(f.runDir, "agent")?.status).toBe("failed");
		expect(getAgentState(f.runDir, "agent")?.exitCode).toBe(1);
	});

	test("kernel-drained failures remain deletable after retirement (guard against over-tightening)", () => {
		const f = ownedFixture();
		f.receipt("role=drain status=fail cause=x boot=1.000001 cid=abc sup_cid=def started=2 exited=2 esrch=0 signaled=0 iterations=1 mismatch=0 at=1\n");
		f.retire();
		expect(ownedOutcomeSync(f.agentDir).kind).toBe("drained-fail");
		expect(ownedDeletableSync(f.agentDir)).toBe(true);
		expect(ownedSlotReleasedSync(f.agentDir)).toBe(true);
	});
});
