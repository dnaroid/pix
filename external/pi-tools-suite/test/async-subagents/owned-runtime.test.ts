import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnAgent } from "../../src/async-subagents/core/spawn.js";
import { getAgentState } from "../../src/async-subagents/core/state.js";
import { stopAgents } from "../../src/async-subagents/core/stop.js";
import { deleteRunDirs, findCleanupCandidates } from "../../src/async-subagents/core/cleanup.js";
import { maySelectOwnedProvider, selectsOwnedProvider, verifiedOwnedDrain, verifiedOwnedDrainSync, waitForOwnedDrain } from "../../src/async-subagents/core/owned-launch-integration.js";
import { ownedDeletableSync, ownedRetiredSync, ownedSlotReleasedSync, verifyOwnedRetirementAsync } from "../../src/async-subagents/core/owned-retirement.js";
const describeOwnedRuntime = process.platform === "win32" ? describe.skip : describe;

const LABEL_SUPERVISOR = "org.pix.owned-launch.22222222-2222-4222-8222-222222222222";
const LABEL_WORKER = "org.pix.owned-launch.33333333-3333-4333-8333-333333333333";
const WORKER_TOKEN = "ab".repeat(32);
// Full native journal shape: the receipt chain only binds to a journal with
// every identity counter present and strictly positive.
const JOURNAL = `role=owned boot=1.000001 cid=abc worker_pid=1 worker_pidversion=1 worker_token=${WORKER_TOKEN} journaled_at=1\n`;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-runtime-"));
	roots.push(root);
	const runDir = path.join(root, "runs", "old-run");
	const agentDir = path.join(runDir, "agent");
	const owner = path.join(agentDir, "owned-launch", "11111111-1111-4111-8111-111111111111");
	fs.mkdirSync(owner, { recursive: true });
	fs.mkdirSync(path.join(runDir, "prompts"));
	fs.writeFileSync(path.join(runDir, "prompts", "agent.md"), "task");
	fs.writeFileSync(path.join(agentDir, "prompt.md"), "task");
	fs.writeFileSync(path.join(agentDir, "pid"), "99999999");
	fs.writeFileSync(path.join(agentDir, "owned_launch"), JSON.stringify({
		runDir: owner, labelSupervisor: LABEL_SUPERVISOR, labelWorker: LABEL_WORKER,
	}));
	fs.writeFileSync(path.join(owner, "owned.json"), JOURNAL);
	fs.writeFileSync(path.join(owner, "payload-exit.json"), "role=payload-exit code=0\n");
	const receipt = (value = `role=drain status=ok cause=leader_exit boot=1.000001 cid=abc sup_cid=def started=2 exited=2 esrch=0 signaled=0 iterations=1 mismatch=0 at=1\n`) =>
		fs.writeFileSync(path.join(owner, "drain.json"), value);
	// Simulates the durable marker the async launchd verifier caches after it
	// independently confirmed BOTH exact UUID labels absent.
	const retire = () => fs.writeFileSync(path.join(owner, "retired"), `${JSON.stringify({ labels: [LABEL_SUPERVISOR, LABEL_WORKER], verifiedAt: new Date().toISOString() })}\n`);
	return { root, runDir, agentDir, owner, receipt, retire };
}

describeOwnedRuntime("owned runtime boundary", () => {
	test("model flags, provider flag and fallback are eligible; direct unprepared launch fails before spawn", () => {
		const task = { id: "agent", task: "test", model: "other/model" };
		expect(selectsOwnedProvider(task, ["--model=pi-claude-code-provider/sonnet"])).toBe(true);
		expect(selectsOwnedProvider(task, ["-m", "pi-claude-code-provider/sonnet"])).toBe(true);
		expect(selectsOwnedProvider(task, ["--provider", "pi-claude-code-provider"])).toBe(true);
		expect(maySelectOwnedProvider(task, [], ["pi-claude-code-provider/sonnet"])).toBe(true);
		expect(selectsOwnedProvider(task, ["--model", "other/override"])).toBe(false);
		const { runDir } = fixture();
		expect(() => spawnAgent(runDir, { ...task, model: "pi-claude-code-provider/sonnet" }, runDir)).toThrow("prepared macOS");
		expect(fs.existsSync(path.join(runDir, "agent", "process_group"))).toBe(false);
	});

	test("invalid, failed, missing and mismatched receipts never settle or authorize reuse", async () => {
		const f = fixture();
		fs.writeFileSync(path.join(f.agentDir, "exit_code"), "0");
		const bad = [
			"role=drain status=ok cause=x boot=1.000001 cid=abc started=2 exited=1 esrch=0 mismatch=0\n",
			"role=drain status=ok cause=x boot=2.000001 cid=abc started=2 exited=2 esrch=0 mismatch=0\n",
			"role=drain status=ok cause=x boot=1.000001 cid=bad started=2 exited=2 esrch=0 mismatch=0\n",
			"role=drain status=ok cause=x boot=1.000001 cid=abc started=2 exited=2 esrch=0 mismatch=0 note=worker_bootout_failed\n",
			"role=drain status=ok cause=x boot=1.000001 cid=abc started=2 exited=2 esrch=0 mismatch=0\ntrailing\n",
		];
		for (const record of bad) {
			f.receipt(record);
			expect(await verifiedOwnedDrain(f.agentDir)).toBe(false);
			expect(verifiedOwnedDrainSync(f.agentDir)).toBe(false);
			expect(getAgentState(f.runDir, "agent")?.status).toBe("running");
			expect(findCleanupCandidates(path.dirname(f.runDir), 0, 0)).toEqual([]);
			expect(() => deleteRunDirs([f.runDir])).toThrow("not verified drained");
			expect(() => spawnAgent(f.runDir, { id: "agent", task: "new" }, f.root)).toThrow("not verified drained");
		}
		// A journal-bound failure receipt is truthful kernel proof (the
		// stale numeric 0 exit record cannot contradict it), but until the
		// retirement marker is cached the run stays NONTERMINAL — that is
		// what keeps reconciliation retrying the launchd proof — and it
		// authorizes neither deletion nor reuse.
		f.receipt("role=drain status=fail cause=x boot=1.000001 cid=abc started=2 exited=2 esrch=0 mismatch=0\n");
		expect(await verifiedOwnedDrain(f.agentDir)).toBe(true);
		expect(getAgentState(f.runDir, "agent")?.status).toBe("running");
		expect(findCleanupCandidates(path.dirname(f.runDir), 0, 0)).toEqual([]);
		expect(() => deleteRunDirs([f.runDir])).toThrow("not verified drained");
		expect(() => spawnAgent(f.runDir, { id: "agent", task: "new" }, f.root)).toThrow("not verified drained");
		fs.rmSync(path.join(f.owner, "drain.json"));
		expect(await waitForOwnedDrain(f.agentDir, Date.now() + 120)).toBe(false);
		f.receipt();
		fs.rmSync(path.join(f.owner, "payload-exit.json"));
		expect(await verifiedOwnedDrain(f.agentDir)).toBe(false);
		fs.writeFileSync(path.join(f.owner, "payload-exit.json"), "role=payload-exit code=0\n");
		expect(await verifiedOwnedDrain(f.agentDir)).toBe(true);
		// Drained success without retirement is still nonterminal state...
		expect(getAgentState(f.runDir, "agent")?.status).toBe("running");
		// A drained receipt alone still does not authorize deletion or reuse.
		expect(findCleanupCandidates(path.dirname(f.runDir), 0, 0)).toEqual([]);
		expect(() => deleteRunDirs([f.runDir])).toThrow("not verified drained");
		expect(() => spawnAgent(f.runDir, { id: "agent", task: "new" }, f.root)).toThrow("not verified drained");
		f.retire();
		// ...and only the cached retirement proof makes it terminal.
		expect(getAgentState(f.runDir, "agent")?.status).toBe("done");
		expect(getAgentState(f.runDir, "agent")?.exitCode).toBe(0);
		expect(findCleanupCandidates(path.dirname(f.runDir), 0, 0)).toEqual([f.runDir]);
	});

	test("pending owned runs stay running despite a dead bridge pid and rpc prompt failure", () => {
		const f = fixture();
		fs.writeFileSync(path.join(f.agentDir, "events.jsonl"), JSON.stringify({ type: "response", command: "prompt", success: false }) + "\n");
		const state = getAgentState(f.runDir, "agent", { checkRpcPromptFailure: true });
		expect(state?.status).toBe("running");
		expect(state?.exitCode).toBeUndefined();
	});

	test("drain receipts and retirement markers recover truthful terminal state without exit_code", () => {
		const f = fixture();
		f.receipt(`role=drain status=fail cause=boot_mismatch boot=9.000001 cid=abc sup_cid=def started=2 exited=1 esrch=0 signaled=0 iterations=1 mismatch=0 at=1\n`);
		f.retire();
		// Unproven failure: terminal state only with the retirement marker.
		expect(ownedRetiredSync(f.agentDir)).toBe(true);
		const state = getAgentState(f.runDir, "agent");
		expect(state?.status).toBe("failed");
		expect(state?.exitCode).toBe(1);
		// A stale numeric 0 exit record cannot contradict a failure receipt.
		fs.writeFileSync(path.join(f.agentDir, "exit_code"), "0");
		expect(getAgentState(f.runDir, "agent")?.status).toBe("failed");
		// Service absence is not kernel-zero: with a journal (a payload was
		// released) the artifacts are retained and the slot stays held...
		expect(ownedDeletableSync(f.agentDir)).toBe(false);
		expect(ownedSlotReleasedSync(f.agentDir)).toBe(false);
		expect(() => deleteRunDirs([f.runDir])).toThrow("not verified drained");
		// ...and only a provably never-released run (no journal) releases the
		// slot — while deletion stays refused (artifacts retained) regardless.
		fs.rmSync(path.join(f.owner, "owned.json"));
		expect(ownedSlotReleasedSync(f.agentDir)).toBe(true);
		expect(ownedDeletableSync(f.agentDir)).toBe(false);
		expect(() => deleteRunDirs([f.runDir])).toThrow("not verified drained");
	});

	test("truncated retirement markers are repairable, present jobs are not", async () => {
		const f = fixture();
		f.receipt();
		// Crash-truncated marker: shape-invalid, so nothing trusts it...
		fs.writeFileSync(path.join(f.owner, "retired"), '{"labels":["org.pix.own');
		expect(ownedRetiredSync(f.agentDir)).toBe(false);
		expect(ownedDeletableSync(f.agentDir)).toBe(false);
		// ...and re-verification with confirmed absence repairs it durably.
		expect(await verifyOwnedRetirementAsync(f.agentDir, { printServiceForTest: async () => "absent" })).toBe(true);
		expect(ownedRetiredSync(f.agentDir)).toBe(true);
		expect(ownedDeletableSync(f.agentDir)).toBe(true);
		// A present (or ambiguous) job answer never retires or repairs.
		const g = fixture();
		g.receipt(`role=drain status=fail cause=x boot=1.000001 cid=abc sup_cid=def started=2 exited=1 esrch=0 signaled=0 iterations=1 mismatch=0 at=1\n`);
		fs.writeFileSync(path.join(g.owner, "retired"), '{"labels":["org.pix.own');
		expect(await verifyOwnedRetirementAsync(g.agentDir, { printServiceForTest: async () => "present" })).toBe(false);
		expect(ownedRetiredSync(g.agentDir)).toBe(false);
		expect(ownedDeletableSync(g.agentDir)).toBe(false);
		// Ambiguous answers stay ambiguous until the overall budget expires.
		expect(await verifyOwnedRetirementAsync(g.agentDir, { printServiceForTest: async () => "unknown", overallDeadlineMs: 250 })).toBe(false);
		expect(ownedRetiredSync(g.agentDir)).toBe(false);
	});

	test("stop is durable pending, does not signal stale PID or write terminal state", () => {
		const f = fixture();
		fs.writeFileSync(path.join(f.agentDir, "process_group"), "1");
		const outcome = stopAgents(f.runDir, ["agent"])[0];
		expect(outcome.stopped).toBe(false);
		expect(outcome.message).toContain("drain pending");
		expect(fs.existsSync(path.join(f.owner, "cancel"))).toBe(true);
		expect(fs.existsSync(path.join(f.agentDir, "stop_requested"))).toBe(true);
		expect(fs.existsSync(path.join(f.agentDir, "exit_code"))).toBe(false);
		expect(getAgentState(f.runDir, "agent")?.status).toBe("running");
	});

	test("owned artifacts without a pointer fail closed for reuse and deletion", () => {
		const f = fixture();
		fs.rmSync(path.join(f.agentDir, "owned_launch"));
		f.receipt();
		f.retire();
		// Retired + terminal artifacts are safe to reuse/delete even pointerless...
		expect(ownedDeletableSync(f.agentDir)).toBe(true);
		const pending = fixture();
		fs.rmSync(path.join(pending.agentDir, "owned_launch"));
		// ...but live-or-unknown ones never are, and never release the slot.
		expect(ownedDeletableSync(pending.agentDir)).toBe(false);
		expect(ownedSlotReleasedSync(pending.agentDir)).toBe(false);
		expect(() => deleteRunDirs([pending.runDir])).toThrow("not verified drained");
		expect(() => spawnAgent(pending.runDir, { id: "agent", task: "new" }, pending.root)).toThrow("not verified drained");
	});
});
