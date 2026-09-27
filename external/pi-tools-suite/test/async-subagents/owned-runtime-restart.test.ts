// Deterministic mocked restart regressions for the two runtime-review
// restart blockers. No launchd, no native binaries, no provider, no real
// owned bridge: the retirement verifier's launchctl boundary is replaced
// process-wide and the native launch boundary is either faked binaries
// (bridge exec always fails after publish) or never reached at all.
//
// Blocker 1 — receipt before bootout: after a parent restart the recovered
// exit_code exists while the exact UUID jobs are still present; the run
// must stay nonterminal and reconciliation must keep retrying the
// retirement proof even though exit_code exists (no permanent leak).
//
// Blocker 2 — pre-exec crash: hidden pre-launch staging keeps incomplete
// directories invisible, the atomic publish guarantees every visible UUID
// directory is complete (spec + claim protocol), and restart recovery
// resolves an unclaimed run ONLY by winning its exclusive launch claim
// (fence). Age, journal absence, and job absence are never proof on their
// own: a bridge-claimed, legacy, or in-process-live run is never fenced.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchOwnedAgentSync } from "../../src/async-subagents/core/owned-launch/launcher.js";
import {
	listOwnedLaunchRunDirs,
	ownedArtifactsPresentSync,
	ownedDeletableSync,
	ownedRetiredSync,
	ownedSlotReleasedSync,
	reconcileOwnedRuns,
	setOwnedFenceGraceForTest,
	setOwnedRetirementPrintForTest,
} from "../../src/async-subagents/core/owned-retirement.js";
import {
	fenceOwnedLaunchRunAsync,
	OWNED_LAUNCH_CLAIM_PROTOCOL_CONTENT,
	OWNED_LAUNCH_CLAIM_PROTOCOL_FILE,
	readOwnedLaunchClaimSync,
} from "../../src/async-subagents/core/owned-launch/marker.js";
import { forgetOwnedHandle, launchPreparedOwnedAgent, ownedOutcomeSync } from "../../src/async-subagents/core/owned-launch-integration.js";
import { writeOwnedLaunchSpec, type OwnedLaunchWorkerSpec } from "../../src/async-subagents/core/owned-launch/spec.js";
import { getAgentState, waitForAgents } from "../../src/async-subagents/core/state.js";
import { pollRunWithUpdates } from "../../src/async-subagents/polling.js";
import { deleteRunDirs } from "../../src/async-subagents/core/cleanup.js";
import type { OwnedLaunchBinaries } from "../../src/async-subagents/core/owned-launch/bootstrap.js";
const describeOwnedRuntime = process.platform === "win32" ? describe.skip : describe;

const WORKER_TOKEN = "ab".repeat(32);
const JOURNAL = `role=owned boot=1.000001 cid=abc worker_pid=1 worker_pidversion=1 worker_token=${WORKER_TOKEN} journaled_at=1\n`;
const FAKE_BINARIES: OwnedLaunchBinaries = { bridge: "/nonexistent/owned-bridge", gate: "/nonexistent/owned-gate", supervisor: "/nonexistent/owned-supervisor" };
const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const LABELS_A = {
	supervisor: "org.pix.owned-launch.aaaaaaaa-0000-4000-8000-000000000001",
	worker: "org.pix.owned-launch.aaaaaaaa-0000-4000-8000-000000000002",
};
const LABELS_B = {
	supervisor: "org.pix.owned-launch.bbbbbbbb-0000-4000-8000-000000000001",
	worker: "org.pix.owned-launch.bbbbbbbb-0000-4000-8000-000000000002",
};

interface Labels {
	supervisor: string;
	worker: string;
}

function specFor(labels: Labels): OwnedLaunchWorkerSpec {
	return {
		version: 1,
		command: "/bin/true",
		args: [],
		cwd: "/tmp",
		env: {},
		socketsDir: "/tmp/olsockets",
		supervisorBinary: FAKE_BINARIES.supervisor,
		gateBinary: FAKE_BINARIES.gate,
		labelSupervisor: labels.supervisor,
		labelWorker: labels.worker,
		watchdogSeconds: 60,
		releaseTimeoutSeconds: 20,
		drainDeadlineSeconds: 30,
	};
}

const roots: string[] = [];
const originalPlatform = process.platform;
afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
	setOwnedRetirementPrintForTest(undefined);
	setOwnedFenceGraceForTest(undefined);
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

const BRIDGE_CLAIM = "role=bridge-claim pid=4242\n";
const FENCE_CLAIM = "role=fence stage=restart-recovery\n";
const LONG_AGO = new Date(Date.now() - 60 * 60 * 1000);

/** Agent directory shaped like a parent restart leftover. */
function restartFixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-restart-"));
	roots.push(root);
	const runDir = path.join(root, "runs", "r1");
	const agentDir = path.join(runDir, "agent");
	fs.mkdirSync(path.join(runDir, "prompts"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	fs.writeFileSync(path.join(runDir, "prompts", "agent.md"), "task");
	fs.writeFileSync(path.join(agentDir, "prompt.md"), "task");
	fs.writeFileSync(path.join(agentDir, "pid"), "99999999");
	fs.writeFileSync(path.join(agentDir, "started_at"), LONG_AGO.toISOString());
	/**
	 * Complete published UUID run directory (spec with exact labels and, by
	 * default, the claim protocol declaration), published long ago.
	 */
	const makeRunDir = (uuid: string, labels: Labels, options: { protocol?: boolean; publishedAt?: Date; generation?: number } = {}): string => {
		const dir = path.join(agentDir, "owned-launch", uuid);
		fs.mkdirSync(dir, { recursive: true });
		writeOwnedLaunchSpec(dir, specFor(labels));
		if (options.protocol ?? true) fs.writeFileSync(path.join(dir, OWNED_LAUNCH_CLAIM_PROTOCOL_FILE), OWNED_LAUNCH_CLAIM_PROTOCOL_CONTENT);
		if (options.generation !== undefined) fs.writeFileSync(path.join(dir, "generation"), `generation=${options.generation}\n`);
		const at = options.publishedAt ?? LONG_AGO;
		fs.utimesSync(path.join(dir, "spec.txt"), at, at);
		return dir;
	};
	const pointer = (runDirOf: string, labels: Labels) =>
		fs.writeFileSync(path.join(agentDir, "owned_launch"), JSON.stringify({
			runDir: runDirOf, labelSupervisor: labels.supervisor, labelWorker: labels.worker,
		}));
	const drainedOk = (dir: string) => {
		fs.writeFileSync(path.join(dir, "owned.json"), JOURNAL);
		fs.writeFileSync(path.join(dir, "payload-exit.json"), "role=payload-exit code=0\n");
		fs.writeFileSync(path.join(dir, "drain.json"), "role=drain status=ok cause=leader_exit boot=1.000001 cid=abc sup_cid=def started=2 exited=2 esrch=0 signaled=0 iterations=1 mismatch=0 at=1\n");
	};
	return { root, runDir, agentDir, makeRunDir, pointer, drainedOk };
}

describeOwnedRuntime("blocker 1: receipt before bootout after a parent restart", () => {
	test("exit_code exists, jobs present: nonterminal state and continuous reconciliation retry", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const f = restartFixture();
		const owner = f.makeRunDir(UUID_A, LABELS_A);
		f.pointer(owner, LABELS_A);
		f.drainedOk(owner);
		let presence: "present" | "absent" = "present";
		let prints = 0;
		setOwnedRetirementPrintForTest(async () => {
			prints++;
			return presence;
		});
		reconcileOwnedRuns(f.runDir);
		await until(() => fs.existsSync(path.join(f.agentDir, "exit_code")), 4_000, "exit_code recovered before bootout");
		// The receipt was final, so the exit is recovered — but the jobs are
		// still present: no retirement marker, and state must stay NONTERMINAL
		// so wait/poll keep driving the retirement proof.
		expect(fs.existsSync(path.join(owner, "retired"))).toBe(false);
		expect(ownedRetiredSync(f.agentDir)).toBe(false);
		expect(getAgentState(f.runDir, "agent")?.status).toBe("running");
		expect(ownedDeletableSync(f.agentDir)).toBe(false);
		// Continuous retry even though exit_code exists (the old gate skipped
		// here, which stranded the artifacts forever).
		const before = prints;
		reconcileOwnedRuns(f.runDir);
		await until(() => prints > before, 4_000, "reconciliation retried after exit_code");
		// Delayed bootout: the wait loop keeps running and drives retirement.
		const waiting = waitForAgents(f.runDir, ["agent"], { interval: 0.05, timeout: 15 });
		await wait(300);
		presence = "absent";
		const state = await waiting;
		expect(state.agents[0]?.status).toBe("done");
		expect(state.agents[0]?.exitCode).toBe(0);
		expect(fs.existsSync(path.join(owner, "retired"))).toBe(true);
		expect(ownedRetiredSync(f.agentDir)).toBe(true);
		expect(ownedDeletableSync(f.agentDir)).toBe(true);
	}, 25_000);

	test("pollRunWithUpdates reconciles inside the loop and returns only after retirement", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const f = restartFixture();
		const owner = f.makeRunDir(UUID_A, LABELS_A);
		f.pointer(owner, LABELS_A);
		f.drainedOk(owner);
		let presence: "present" | "absent" = "present";
		setOwnedRetirementPrintForTest(async () => presence);
		reconcileOwnedRuns(f.runDir);
		await until(() => fs.existsSync(path.join(f.agentDir, "exit_code")), 4_000, "exit_code recovered before bootout");
		let resolved = false;
		const polling = pollRunWithUpdates(f.runDir, ["agent"], { mode: "wait", timeoutSeconds: 15, intervalSeconds: 0.25 });
		void polling.then(() => {
			resolved = true;
		});
		// Jobs still present: the poll must NOT return on the drained receipt.
		await wait(600);
		expect(resolved).toBe(false);
		expect(getAgentState(f.runDir, "agent")?.status).toBe("running");
		presence = "absent";
		const state = await polling;
		expect(state.agents[0]?.status).toBe("done");
		// The in-loop reconciliation cached the retirement marker after the
		// exit_code already existed — the recurring route the old poll lacked.
		expect(fs.existsSync(path.join(owner, "retired"))).toBe(true);
	}, 25_000);
});

describeOwnedRuntime("blocker 2: pre-exec crash staging and publish", () => {
	test("staging stays hidden, publish is atomic with the claim protocol, and leftovers are retained", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-restart-"));
		roots.push(root);
		const agentDir = path.join(root, "agent");
		const baseDir = path.join(agentDir, "owned-launch");
		fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
		// A crashed parent's abandoned staging directory with a partial spec.
		const stale = path.join(baseDir, ".staging-11111111-1111-4111-8111-111111111111-999999-1");
		fs.mkdirSync(stale);
		fs.writeFileSync(path.join(stale, "spec.txt"), "label_super");
		fs.utimesSync(stale, LONG_AGO, LONG_AGO);
		// Hidden partial staging never holds the slot or surfaces as a run.
		expect(listOwnedLaunchRunDirs(agentDir)).toEqual([]);
		expect(ownedArtifactsPresentSync(agentDir)).toBe(false);
		let published: string | undefined;
		let protocolAtPointer = false;
		expect(() => launchOwnedAgentSync({
			command: "/bin/true", args: [], cwd: root, env: {}, baseDir, binaries: FAKE_BINARIES, uuid: UUID_C,
			beforeSpawn: (prepared) => {
				published = prepared.runDir;
				protocolAtPointer = fs.readFileSync(path.join(prepared.runDir, OWNED_LAUNCH_CLAIM_PROTOCOL_FILE), "utf8") === OWNED_LAUNCH_CLAIM_PROTOCOL_CONTENT;
			},
		})).toThrow(/failed to start/);
		// The bridge exec failed, but only AFTER the complete UUID directory
		// (spec + claim protocol) was published and the pointer callback ran.
		expect(published).toBe(path.join(baseDir, UUID_C));
		expect(protocolAtPointer).toBe(true);
		expect(fs.existsSync(path.join(baseDir, UUID_C, "spec.txt"))).toBe(true);
		expect(readOwnedLaunchClaimSync(path.join(baseDir, UUID_C))).toBe("none");
		expect(listOwnedLaunchRunDirs(agentDir)).toEqual([path.join(baseDir, UUID_C)]);
		// Age is not abandonment proof: the stale staging leftover is retained.
		const names = fs.readdirSync(baseDir).sort();
		expect(names).toContain(path.basename(stale));
		expect(names.filter((name) => name.startsWith(".staging-"))).toEqual([path.basename(stale)]);
	});

	test("publish refuses an existing UUID directory and never calls the pointer callback", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-restart-"));
		roots.push(root);
		const baseDir = path.join(root, "agent", "owned-launch");
		fs.mkdirSync(path.join(baseDir, UUID_C), { recursive: true, mode: 0o700 }); // collision target
		let called = false;
		expect(() => launchOwnedAgentSync({
			command: "/bin/true", args: [], cwd: root, env: {}, baseDir, binaries: FAKE_BINARIES, uuid: UUID_C,
			beforeSpawn: () => {
				called = true;
			},
		})).toThrow(/already exists/);
		expect(called).toBe(false);
		expect(fs.readdirSync(baseDir).filter((name) => name.startsWith(".staging-"))).toEqual([]);
	});
});

describeOwnedRuntime("exclusive launch claim", () => {
	test("fence wins an unclaimed run exactly once and is idempotent under concurrent recovery", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-claim-"));
		roots.push(root);
		const results = await Promise.all([fenceOwnedLaunchRunAsync(root), fenceOwnedLaunchRunAsync(root), fenceOwnedLaunchRunAsync(root)]);
		expect(results).toEqual(["fence", "fence", "fence"]);
		expect(fs.readFileSync(path.join(root, "claim"), "utf8")).toBe(FENCE_CLAIM);
		// No temp leftovers; a later bridge-style link(2) publication loses.
		expect(fs.readdirSync(root)).toEqual(["claim"]);
		fs.writeFileSync(path.join(root, ".claim.bridge.1"), BRIDGE_CLAIM);
		expect(() => fs.linkSync(path.join(root, ".claim.bridge.1"), path.join(root, "claim"))).toThrow(/EEXIST/);
		expect(readOwnedLaunchClaimSync(root)).toBe("fence");
	});

	test("a bridge claim defeats the fence and is never overwritten", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-claim-"));
		roots.push(root);
		fs.writeFileSync(path.join(root, "claim"), BRIDGE_CLAIM);
		expect(await fenceOwnedLaunchRunAsync(root)).toBe("bridge");
		expect(fs.readFileSync(path.join(root, "claim"), "utf8")).toBe(BRIDGE_CLAIM);
	});

	test("malformed or non-regular claims are invalid, never a fence", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-claim-"));
		roots.push(root);
		fs.writeFileSync(path.join(root, "claim"), "role=fence\n");
		expect(readOwnedLaunchClaimSync(root)).toBe("invalid");
		expect(await fenceOwnedLaunchRunAsync(root)).toBe("invalid");
		fs.rmSync(path.join(root, "claim"));
		fs.symlinkSync(path.join(root, "elsewhere"), path.join(root, "claim"));
		expect(readOwnedLaunchClaimSync(root)).toBe("invalid");
	});
});

describeOwnedRuntime("blocker 2: unclaimed runs after a parent crash are fenced", () => {
	test("pointerless complete UUID dir: fenced, terminal only after both jobs retire, then deletable", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const f = restartFixture();
		const owner = f.makeRunDir(UUID_A, LABELS_A);
		let presence: "present" | "absent" = "present";
		setOwnedRetirementPrintForTest(async () => presence);
		expect(getAgentState(f.runDir, "agent")?.status).toBe("running");
		expect(ownedSlotReleasedSync(f.agentDir)).toBe(false);
		reconcileOwnedRuns(f.runDir);
		await until(() => readOwnedLaunchClaimSync(owner) === "fence", 4_000, "fence won");
		expect(ownedOutcomeSync(f.agentDir).kind).toBe("never-launched");
		await until(() => fs.existsSync(path.join(f.agentDir, "exit_code")), 4_000, "exit recovered");
		// Jobs still reported present: fencing alone never skips retirement.
		expect(getAgentState(f.runDir, "agent")?.status).toBe("running");
		expect(ownedDeletableSync(f.agentDir)).toBe(false);
		expect(() => deleteRunDirs([f.runDir])).toThrow("not verified drained");
		presence = "absent";
		const state = await waitForAgents(f.runDir, ["agent"], { interval: 0.05, timeout: 15 });
		expect(state.agents[0]?.status).toBe("failed");
		expect(state.agents[0]?.exitCode).toBe(1);
		expect(ownedSlotReleasedSync(f.agentDir)).toBe(true);
		expect(ownedDeletableSync(f.agentDir)).toBe(true);
		deleteRunDirs([f.runDir]);
		expect(fs.existsSync(f.runDir)).toBe(false);
	}, 25_000);

	test("pointer present, bridge never spawned: fenced and retired", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const f = restartFixture();
		const owner = f.makeRunDir(UUID_A, LABELS_A);
		f.pointer(owner, LABELS_A);
		setOwnedRetirementPrintForTest(async () => "absent");
		const state = await waitForAgents(f.runDir, ["agent"], { interval: 0.05, timeout: 15 });
		expect(readOwnedLaunchClaimSync(owner)).toBe("fence");
		expect(state.agents[0]?.status).toBe("failed");
		expect(fs.readFileSync(path.join(f.agentDir, "exit_code"), "utf8")).toBe("1");
		expect(fs.existsSync(path.join(owner, "retired"))).toBe(true);
		expect(ownedDeletableSync(f.agentDir)).toBe(true);
	}, 25_000);

	test("negative race: a bridge-claimed run is never fenced, even journal-less with both jobs absent", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const f = restartFixture();
		const owner = f.makeRunDir(UUID_A, LABELS_A);
		f.pointer(owner, LABELS_A);
		fs.writeFileSync(path.join(owner, "claim"), BRIDGE_CLAIM);
		let prints = 0;
		setOwnedRetirementPrintForTest(async () => {
			prints++;
			return "absent";
		});
		const state = await waitForAgents(f.runDir, ["agent"], { interval: 0.05, timeout: 0.6 });
		expect(state.agents[0]?.status).toBe("running");
		expect(fs.readFileSync(path.join(owner, "claim"), "utf8")).toBe(BRIDGE_CLAIM);
		expect(prints).toBe(0); // pending never reaches the launchctl boundary
		expect(fs.existsSync(path.join(owner, "retired"))).toBe(false);
		expect(fs.existsSync(path.join(f.agentDir, "exit_code"))).toBe(false);
		expect(ownedSlotReleasedSync(f.agentDir)).toBe(false);
		expect(() => deleteRunDirs([f.runDir])).toThrow("not verified drained");
	}, 10_000);

	test("runs inside the fence grace are left to their live launcher", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const f = restartFixture();
		const owner = f.makeRunDir(UUID_A, LABELS_A, { publishedAt: new Date() });
		setOwnedRetirementPrintForTest(async () => "absent");
		reconcileOwnedRuns(f.runDir);
		await wait(300);
		expect(readOwnedLaunchClaimSync(owner)).toBe("none");
		expect(fs.existsSync(path.join(f.agentDir, "exit_code"))).toBe(false);
		expect(getAgentState(f.runDir, "agent")?.status).toBe("running");
	});

	test("legacy runs without the claim protocol, spec-less dirs, and legacy never_launched markers stay pending", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const f = restartFixture();
		const legacy = f.makeRunDir(UUID_A, LABELS_A, { protocol: false });
		fs.writeFileSync(path.join(legacy, "never_launched"), "role=never-launched stage=restart-recovery\n");
		const specless = path.join(f.agentDir, "owned-launch", UUID_B);
		fs.mkdirSync(specless, { recursive: true });
		setOwnedRetirementPrintForTest(async () => "absent");
		reconcileOwnedRuns(f.runDir);
		await wait(300);
		expect(readOwnedLaunchClaimSync(legacy)).toBe("none");
		expect(readOwnedLaunchClaimSync(specless)).toBe("none");
		expect(ownedSlotReleasedSync(f.agentDir)).toBe(false);
		expect(getAgentState(f.runDir, "agent")?.status).toBe("running");
		// Even a fence record cannot resolve a run that never declared the protocol.
		fs.writeFileSync(path.join(legacy, "claim"), FENCE_CLAIM);
		expect(ownedOutcomeSync(f.agentDir).kind).toBe("none");
	});

	test("a fenced run holding a journal stays pending (contradiction fails closed)", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const f = restartFixture();
		const owner = f.makeRunDir(UUID_A, LABELS_A);
		f.pointer(owner, LABELS_A);
		fs.writeFileSync(path.join(owner, "claim"), FENCE_CLAIM);
		fs.writeFileSync(path.join(owner, "owned.json"), JOURNAL);
		setOwnedRetirementPrintForTest(async () => "absent");
		reconcileOwnedRuns(f.runDir);
		await wait(300);
		expect(ownedOutcomeSync(f.agentDir).kind).toBe("pending");
		expect(fs.existsSync(path.join(f.agentDir, "exit_code"))).toBe(false);
		expect(getAgentState(f.runDir, "agent")?.status).toBe("running");
	});

	test("an interrupted fence (temp written, never linked) is completed by the next reconciliation", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const f = restartFixture();
		const owner = f.makeRunDir(UUID_A, LABELS_A);
		f.pointer(owner, LABELS_A);
		fs.writeFileSync(path.join(owner, ".claim.fence.1.1.0"), FENCE_CLAIM);
		setOwnedRetirementPrintForTest(async () => "absent");
		const state = await waitForAgents(f.runDir, ["agent"], { interval: 0.05, timeout: 15 });
		expect(readOwnedLaunchClaimSync(owner)).toBe("fence");
		expect(state.agents[0]?.status).toBe("failed");
	}, 25_000);
});

describeOwnedRuntime("blocker 2: older generations are never hidden by the metadata pointer", () => {
	test("retry crash: two pointerless generations resolve to the newest, fenced, and terminate", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const f = restartFixture();
		// Generation 1 drained and retired earlier; the reuse cleanup then
		// unlinked the pointer. Generation 2 was published, then the parent
		// crashed before writing its pointer.
		const older = f.makeRunDir(UUID_A, LABELS_A, { generation: 1 });
		f.drainedOk(older);
		const newer = f.makeRunDir(UUID_B, LABELS_B, { generation: 2 });
		setOwnedRetirementPrintForTest(async () => "absent");
		const state = await waitForAgents(f.runDir, ["agent"], { interval: 0.05, timeout: 15 });
		expect(readOwnedLaunchClaimSync(newer)).toBe("fence");
		// The newest attempt's outcome, not the older drained success.
		expect(state.agents[0]?.status).toBe("failed");
		expect(state.agents[0]?.exitCode).toBe(1);
		expect(fs.existsSync(path.join(older, "retired"))).toBe(true);
		expect(fs.existsSync(path.join(newer, "retired"))).toBe(true);
		expect(ownedDeletableSync(f.agentDir)).toBe(true);
	}, 25_000);

	test("a stale pointer never outranks a newer generation; legacy ties fail closed", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const f = restartFixture();
		const legacy = f.makeRunDir(UUID_A, LABELS_A); // no generation record
		f.drainedOk(legacy);
		f.pointer(legacy, LABELS_A);
		const newer = f.makeRunDir(UUID_B, LABELS_B, { generation: 1 });
		fs.writeFileSync(path.join(newer, "claim"), BRIDGE_CLAIM);
		expect(ownedOutcomeSync(f.agentDir).kind).toBe("pending");
		// Two legacy pointerless directories: ambiguous, never guessed.
		const g = restartFixture();
		g.makeRunDir(UUID_A, LABELS_A);
		g.makeRunDir(UUID_B, LABELS_B);
		expect(ownedOutcomeSync(g.agentDir).kind).toBe("none");
	});

	test("launcher numbers generations strictly above every surviving directory", () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const f = restartFixture();
		f.makeRunDir(UUID_A, LABELS_A, { generation: 4 });
		f.makeRunDir(UUID_B, LABELS_B); // legacy
		const baseDir = path.join(f.agentDir, "owned-launch");
		fs.chmodSync(baseDir, 0o700);
		let published: string | undefined;
		expect(() => launchOwnedAgentSync({
			command: "/bin/true", args: [], cwd: f.root, env: {}, baseDir, binaries: FAKE_BINARIES, uuid: UUID_C,
			beforeSpawn: (prepared) => {
				published = prepared.runDir;
			},
		})).toThrow(/failed to start/);
		expect(fs.readFileSync(path.join(published!, "generation"), "utf8")).toBe("generation=5\n");
	});

	test("a bridge-claimed pending generation blocks terminal state and deletion", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const f = restartFixture();
		const other = f.makeRunDir(UUID_B, LABELS_B);
		fs.writeFileSync(path.join(other, "claim"), BRIDGE_CLAIM);
		const current = f.makeRunDir(UUID_A, LABELS_A);
		f.drainedOk(current);
		f.pointer(current, LABELS_A);
		setOwnedRetirementPrintForTest(async () => "absent");
		const state = await waitForAgents(f.runDir, ["agent"], { interval: 0.05, timeout: 0.8 });
		expect(state.agents[0]?.status).toBe("running");
		expect(ownedDeletableSync(f.agentDir)).toBe(false);
		expect(readOwnedLaunchClaimSync(other)).toBe("bridge");
	}, 10_000);
});

describeOwnedRuntime("in-process live launch is never fenced", () => {
	test("an active handle blocks fencing even past the grace; a reaped bridge lifts it", async () => {
		if (originalPlatform !== "darwin") return;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-live-"));
		roots.push(root);
		const runDir = path.join(root, "runs", "r1");
		const agentDir = path.join(runDir, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "prompt.md"), "task");
		// A slow bridge that has not claimed yet: a plain sleeping script.
		const bridge = path.join(root, "slow-bridge.sh");
		fs.writeFileSync(bridge, "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
		setOwnedFenceGraceForTest(0);
		setOwnedRetirementPrintForTest(async () => "absent");
		const handle = launchPreparedOwnedAgent({
			agentDir, command: "/bin/true", args: [], cwd: root, env: {},
			binaries: { ...FAKE_BINARIES, bridge },
		});
		try {
			reconcileOwnedRuns(runDir);
			await wait(300);
			expect(readOwnedLaunchClaimSync(handle.runDir)).toBe("none");
			expect(ownedOutcomeSync(agentDir).kind).toBe("pending");
			// Even a final receipt of the live run is never turned into a
			// recovered exit by reconciliation: the live settle loop owns it.
			fs.writeFileSync(path.join(handle.runDir, "claim"), BRIDGE_CLAIM);
			fs.writeFileSync(path.join(handle.runDir, "owned.json"), JOURNAL);
			fs.writeFileSync(path.join(handle.runDir, "drain.json"), "role=drain status=ok cause=cancel boot=1.000001 cid=abc sup_cid=def started=2 exited=2 esrch=0 mismatch=0 at=1\n");
			expect(ownedOutcomeSync(agentDir).kind).toBe("drained-ok");
			reconcileOwnedRuns(runDir);
			await wait(300);
			expect(fs.existsSync(path.join(agentDir, "exit_code"))).toBe(false);
			expect(fs.existsSync(path.join(handle.runDir, "retired"))).toBe(false);
			expect(getAgentState(runDir, "agent")?.status).toBe("running");
		} finally {
			handle.process.kill("SIGKILL");
			await handle.exited;
			forgetOwnedHandle(agentDir);
		}
		// After the handle is gone, restart-style recovery takes over.
		reconcileOwnedRuns(runDir);
		await until(() => fs.existsSync(path.join(handle.runDir, "retired")), 4_000, "retired after handle release");
		expect(fs.readFileSync(path.join(agentDir, "exit_code"), "utf8")).toBe("143");
	}, 15_000);

	test("an unclaimed run whose handle was released is fenced", async () => {
		if (originalPlatform !== "darwin") return;
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "owned-live-"));
		roots.push(root);
		const runDir = path.join(root, "runs", "r1");
		const agentDir = path.join(runDir, "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "prompt.md"), "task");
		const bridge = path.join(root, "slow-bridge.sh");
		fs.writeFileSync(bridge, "#!/bin/sh\nexec /bin/sleep 30\n", { mode: 0o755 });
		setOwnedFenceGraceForTest(0);
		setOwnedRetirementPrintForTest(async () => "absent");
		const handle = launchPreparedOwnedAgent({ agentDir, command: "/bin/true", args: [], cwd: root, env: {}, binaries: { ...FAKE_BINARIES, bridge } });
		handle.process.kill("SIGKILL");
		await handle.exited;
		forgetOwnedHandle(agentDir);
		reconcileOwnedRuns(runDir);
		await until(() => readOwnedLaunchClaimSync(handle.runDir) === "fence", 4_000, "fence after reap");
		expect(ownedOutcomeSync(agentDir).kind).toBe("never-launched");
	}, 15_000);
});

describeOwnedRuntime("bridge prelaunch abort after winning the claim", () => {
	const prelaunch = (code: string, options: { protocol?: boolean; journal?: boolean; claim?: string } = {}) => {
		const f = restartFixture();
		const owner = f.makeRunDir(UUID_A, LABELS_A, { protocol: options.protocol });
		f.pointer(owner, LABELS_A);
		fs.writeFileSync(path.join(owner, "claim"), options.claim ?? BRIDGE_CLAIM);
		fs.writeFileSync(path.join(owner, "prelaunch_abort"), `role=prelaunch-abort code=${code}\n`);
		if (options.journal) fs.writeFileSync(path.join(owner, "owned.json"), JOURNAL);
		return f;
	};

	test("exits 13/14/18 with a bridge claim are never-launched and terminate after retirement", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		for (const code of ["13", "14", "18"]) expect(ownedOutcomeSync(prelaunch(code).agentDir).kind).toBe("never-launched");
		const f = prelaunch("13");
		setOwnedRetirementPrintForTest(async () => "absent");
		const state = await waitForAgents(f.runDir, ["agent"], { interval: 0.05, timeout: 15 });
		expect(state.agents[0]?.status).toBe("failed");
		expect(ownedSlotReleasedSync(f.agentDir)).toBe(true);
	}, 25_000);

	test("post-launchctl codes, legacy runs, journals, or a missing bridge claim never qualify", () => {
		expect(ownedOutcomeSync(prelaunch("15").agentDir).kind).toBe("pending");
		expect(ownedOutcomeSync(prelaunch("16").agentDir).kind).toBe("pending");
		expect(ownedOutcomeSync(prelaunch("13", { protocol: false }).agentDir).kind).toBe("pending");
		expect(ownedOutcomeSync(prelaunch("13", { journal: true }).agentDir).kind).toBe("pending");
		expect(ownedOutcomeSync(prelaunch("13", { claim: "role=bridge-claim pid=x\n" }).agentDir).kind).toBe("pending");
	});
});

describeOwnedRuntime("owned retry backoff", () => {
	test("a terminal, retired owned attempt with a pending retry reports retrying", async () => {
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
		const f = restartFixture();
		const owner = f.makeRunDir(UUID_A, LABELS_A, { generation: 1 });
		f.pointer(owner, LABELS_A);
		f.drainedOk(owner);
		fs.writeFileSync(path.join(owner, "payload-exit.json"), "role=payload-exit code=1\n");
		setOwnedRetirementPrintForTest(async () => "absent");
		fs.writeFileSync(path.join(f.agentDir, "retry_pending"), new Date().toISOString());
		const state = await waitForAgents(f.runDir, ["agent"], { interval: 0.05, timeout: 1 });
		expect(fs.existsSync(path.join(owner, "retired"))).toBe(true);
		expect(state.agents[0]?.status).toBe("retrying");
		fs.rmSync(path.join(f.agentDir, "retry_pending"));
		expect(getAgentState(f.runDir, "agent")?.status).toBe("failed");
	}, 10_000);
});
