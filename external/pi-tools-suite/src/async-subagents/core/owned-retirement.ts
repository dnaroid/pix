// Retirement boundary for owned-launch runs. Kernel drain (the receipt's
// coalition oracle) and launchd job retirement are distinct facts: a drain
// receipt alone never authorizes deleting or reusing owner artifacts,
// because the native supervisor historically wrote receipts before booting
// out its jobs. Retirement proof is acquired exclusively through bounded,
// asynchronous `launchctl print` lookups of the exact per-run UUID service
// targets (exit 113 is the only accepted absence verdict; exit 0 means the
// job still exists; anything else is ambiguous and refuses), and is then
// cached as a durable `retired` marker that synchronous readers may trust.
// Nothing in this module ever invokes launchctl synchronously or blocks the
// UI/main thread, and every scan covers ALL owned-launch UUID directories
// of an agent, not just the latest metadata pointer.
//
// Pending directories (no durable outcome record) are never classified from
// age, journal absence, or job absence: none of those proves that a paused
// launcher/bridge will not still release the payload later. The only way a
// pending directory is resolved here is FENCING: restart recovery tries to
// win the run's exclusive launch claim (owned-launch/marker.ts). Winning it
// is the proof — the bridge takes the same claim before any bind or
// launchctl action and refuses a fenced run — so the directory becomes a
// durable `never-launched` outcome. Losing it (a bridge claim exists) keeps
// the directory pending until the supervisor's receipt appears. The fence
// grace below is only a liveness courtesy toward a slow live launch; safety
// never depends on it. Only actual outcome records — a journal-bound kernel
// drain receipt, a fail receipt, the launcher's synchronous
// bridge-spawn-failure marker, or a won fence — open a retirement pathway.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { OWNED_LAUNCH_SPEC_FILE } from "./owned-launch/spec.js";
import { isValidOwnedLaunchLabel, listOwnedLaunchRunDirs } from "./owned-launch/label.js";
import { fenceOwnedLaunchRunAsync, ownedLaunchClaimProtocolSync, readOwnedLaunchClaimSync } from "./owned-launch/marker.js";
import {
	OWNED_METADATA,
	ownedHandleActiveSync,
	ownedOutcomeForRunDirSync,
	ownedPrimaryRunDirSync,
	ownedRecoveredExitSync,
	readOwnedMetadata,
	type OwnedRunOutcome,
} from "./owned-launch-integration.js";

const RETIRED_MARKER = "retired";
const LAUNCHCTL_PATH = "/bin/launchctl";
/** `launchctl print` exit status when the exact service target is unknown. */
const LAUNCHCTL_ABSENT_EXIT = 113;
const PRINT_TIMEOUT_MS = 5_000;
const PRINT_MAX_BUFFER = 1024 * 1024;
const PRINT_UNKNOWN_ATTEMPTS = 3;
const PRINT_UNKNOWN_RETRY_DELAY_MS = 150;
const SPEC_HEAD_BYTES = 64 * 1024;
const MARKER_MAX_BYTES = 512;
/** Minimum age of an unclaimed run before recovery fences it (liveness only, not safety). */
const FENCE_GRACE_MS = 60_000;

export { listOwnedLaunchRunDirs };

export interface OwnedLaunchLabels {
	supervisor: string;
	worker: string;
}

export type OwnedServicePresence = "present" | "absent" | "unknown";

export interface RetirementVerificationOptions {
	/** Overall wall-clock budget for ambiguous launchctl answers (default 15s). */
	overallDeadlineMs?: number;
	/** Test injection for the launchctl boundary; never supplied in production. */
	printServiceForTest?: (label: string) => Promise<OwnedServicePresence>;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let printServiceForTestOverride: ((label: string) => Promise<OwnedServicePresence>) | undefined;

/**
 * Test-only process-wide replacement for the launchctl boundary so unit
 * tests can exercise every retirement path (settlement, reconciliation,
 * polling) without ever executing launchctl. Production never calls this.
 */
export function setOwnedRetirementPrintForTest(
	print: ((label: string) => Promise<OwnedServicePresence>) | undefined,
): void {
	printServiceForTestOverride = print;
}

/**
 * True when an agent directory holds any owned-launch artifact: the
 * ownership pointer or at least one UUID run directory. Unknown ownership
 * (for example a lost or unreadable pointer with surviving run
 * directories) must fail closed everywhere deletion, reuse, or slot
 * release is authorized.
 */
export function ownedArtifactsPresentSync(agentDir: string): boolean {
	if (fs.existsSync(path.join(agentDir, OWNED_METADATA))) return true;
	return listOwnedLaunchRunDirs(agentDir).length > 0;
}

function readSpecLabels(runDir: string): OwnedLaunchLabels | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(path.join(runDir, OWNED_LAUNCH_SPEC_FILE), "r");
		const size = fs.fstatSync(fd).size;
		const head = Buffer.allocUnsafe(Math.min(size, SPEC_HEAD_BYTES));
		const bytesRead = fs.readSync(fd, head, 0, head.length, 0);
		const labels: Partial<OwnedLaunchLabels> = {};
		for (const line of head.toString("utf8", 0, bytesRead).split("\n")) {
			const supervisor = /^label_supervisor=(.+)$/.exec(line);
			if (supervisor) labels.supervisor = supervisor[1].trim();
			const worker = /^label_worker=(.+)$/.exec(line);
			if (worker) labels.worker = worker[1].trim();
			if (labels.supervisor && labels.worker) break;
		}
		if (!labels.supervisor || !labels.worker) return undefined;
		if (!isValidOwnedLaunchLabel(labels.supervisor) || !isValidOwnedLaunchLabel(labels.worker) || labels.supervisor === labels.worker) {
			return undefined;
		}
		return labels as OwnedLaunchLabels;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/** Resolve the exact launchd labels a UUID run directory created (spec first, metadata pointer fallback). */
export function ownedLabelsForRunDir(runDir: string, agentDir: string): OwnedLaunchLabels | undefined {
	const spec = readSpecLabels(runDir);
	if (spec) return spec;
	const meta = readOwnedMetadata(agentDir);
	if (meta && path.resolve(meta.runDir) === path.resolve(runDir) &&
		isValidOwnedLaunchLabel(meta.labelSupervisor) && isValidOwnedLaunchLabel(meta.labelWorker) &&
		meta.labelSupervisor !== meta.labelWorker) {
		return { supervisor: meta.labelSupervisor, worker: meta.labelWorker };
	}
	return undefined;
}

interface RetiredMarker {
	labels: string[];
	verifiedAt: string;
}

function readRetiredMarker(runDir: string): RetiredMarker | undefined {
	try {
		const file = path.join(runDir, RETIRED_MARKER);
		if (fs.statSync(file).size > MARKER_MAX_BYTES) return undefined;
		const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!data || typeof data !== "object") return undefined;
		const value = data as Partial<RetiredMarker>;
		if (!Array.isArray(value.labels) || value.labels.length < 2 ||
			!value.labels.every((label) => typeof label === "string" && isValidOwnedLaunchLabel(label)) ||
			typeof value.verifiedAt !== "string" || Number.isNaN(Date.parse(value.verifiedAt))) return undefined;
		return value as RetiredMarker;
	} catch {
		return undefined;
	}
}

function writeRetiredMarker(runDir: string, labels: string[]): void {
	// Atomic replace (temp + fsync + rename + dir fsync): a crash can only
	// leave the previous marker or the complete new one, so a truncated or
	// corrupt marker from an earlier crash always remains repairable by
	// re-running the launchd verification instead of blocking retirement
	// forever. Rename-over is safe: the content is always the exact labels
	// whose absence was just independently confirmed.
	const file = path.join(runDir, RETIRED_MARKER);
	const temp = path.join(runDir, `${RETIRED_MARKER}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	let fd: number | undefined;
	try {
		fd = fs.openSync(temp, "wx", 0o600);
		fs.writeSync(fd, `${JSON.stringify({ labels, verifiedAt: new Date().toISOString() })}\n`);
		fs.fsyncSync(fd);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	fs.renameSync(temp, file);
	const dirFd = fs.openSync(runDir, "r");
	try {
		fs.fsyncSync(dirFd);
	} finally {
		fs.closeSync(dirFd);
	}
}

/** A UUID directory is retired only when a validated durable marker covers its exact spec labels. */
function retiredDirSync(runDir: string, agentDir: string): boolean {
	const marker = readRetiredMarker(runDir);
	if (!marker) return false;
	const labels = ownedLabelsForRunDir(runDir, agentDir);
	if (!labels) return true; // spec unreadable: trust the shape-validated marker only
	const set = new Set(marker.labels);
	return set.has(labels.supervisor) && set.has(labels.worker);
}

/**
 * Asynchronous `launchctl print` of the exact UUID service target.
 * Exit 0 => present; exit 113 => absent (the only accepted absence proof);
 * any other outcome is ambiguous and never authorizes anything.
 */
function launchctlServicePresence(label: string): Promise<OwnedServicePresence> {
	if (process.platform !== "darwin") return Promise.resolve("unknown");
	const target = `gui/${process.getuid!()}/${label}`;
	return new Promise((resolve) => {
		execFile(LAUNCHCTL_PATH, ["print", target], { timeout: PRINT_TIMEOUT_MS, maxBuffer: PRINT_MAX_BUFFER }, (error) => {
			if (!error) return resolve("present");
			if (typeof error.code === "number") {
				if (error.code === 0) return resolve("present");
				if (error.code === LAUNCHCTL_ABSENT_EXIT) return resolve("absent");
			}
			resolve("unknown");
		});
	});
}

async function labelsAbsent(labels: OwnedLaunchLabels, print: (label: string) => Promise<OwnedServicePresence>): Promise<boolean | "unknown"> {
	for (const label of [labels.supervisor, labels.worker]) {
		let verdict: OwnedServicePresence = "unknown";
		for (let attempt = 0; attempt < PRINT_UNKNOWN_ATTEMPTS && verdict === "unknown"; attempt++) {
			verdict = await print(label);
			if (verdict !== "unknown") break;
			await delay(PRINT_UNKNOWN_RETRY_DELAY_MS);
		}
		if (verdict === "present") return false;
		if (verdict === "unknown") return "unknown";
	}
	return true;
}

/**
 * Outcomes that authorize artifact deletion: a kernel-drained receipt
 * (drained-ok/drain-fail), a synchronous bridge spawn failure, or a run
 * restart recovery fenced before its bridge claimed it. An unproven failure is deliberately
 * excluded: launchd job absence alone does not establish that the
 * coalition drained (the spec's two-fact contract), so those artifacts
 * are retained.
 */
function deletableOutcome(kind: OwnedRunOutcome["kind"]): boolean {
	return kind === "drained-ok" || kind === "drained-fail" || kind === "launch-failed" || kind === "never-launched";
}

/**
 * Outcomes backed by an actual durable record that may open the
 * asynchronous retirement pathway: kernel-drained receipts, failure
 * receipts (proven or unproven), the launcher's explicit synchronous
 * bridge-spawn-failure marker, and a won restart fence. A pending directory holds no such record,
 * so the mere absence of its jobs must never be cached as retirement — a
 * paused launcher/bridge can still release the payload later.
 */
function retirementEligibleOutcome(kind: OwnedRunOutcome["kind"]): boolean {
	return deletableOutcome(kind) || kind === "unproven-fail";
}

/**
 * Verify — asynchronously, bounded, and never on the UI/main thread — that
 * BOTH exact UUID launchd labels of EVERY owned-launch run directory are
 * absent, then cache a durable retirement marker per directory. Returns
 * false whenever any job is present, any answer stays ambiguous, or any
 * directory is still pending (no outcome record to gate retirement on).
 */
export async function verifyOwnedRetirementAsync(agentDir: string, options: RetirementVerificationOptions = {}): Promise<boolean> {
	const deadline = Date.now() + (options.overallDeadlineMs ?? 15_000);
	const print = options.printServiceForTest ?? printServiceForTestOverride ?? launchctlServicePresence;
	const runDirs = listOwnedLaunchRunDirs(agentDir);
	if (runDirs.length === 0) return false;
	for (const runDir of runDirs) {
		if (retiredDirSync(runDir, agentDir)) continue;
		if (!retirementEligibleOutcome(ownedOutcomeForRunDirSync(runDir).kind)) return false;
		const labels = ownedLabelsForRunDir(runDir, agentDir);
		if (!labels) return false; // unknown targets can never be proven retired
		let result = await labelsAbsent(labels, print);
		while (result === "unknown" && Date.now() < deadline) {
			await delay(500);
			result = await labelsAbsent(labels, print);
		}
		if (result !== true) return false;
		try {
			writeRetiredMarker(runDir, [labels.supervisor, labels.worker]);
		} catch {
			return false; // unwritable marker: stay unretired (fail closed), retried later
		}
	}
	return true;
}

/** Synchronous retirement trust: only validated durable markers count (no launchctl here). */
export function ownedRetiredSync(agentDir: string): boolean {
	const runDirs = listOwnedLaunchRunDirs(agentDir);
	if (runDirs.length === 0) return false;
	return runDirs.every((runDir) => retiredDirSync(runDir, agentDir));
}

/**
 * Deletion/reuse authorization: every UUID dir kernel-drained (or provably
 * never launched) AND durably retired. An unproven failure is never
 * deletable, even retired: service absence is not kernel-zero proof, so the
 * artifacts are retained unless the failure is separately proven never
 * released — which authorizes only slot release, never deletion.
 */
export function ownedDeletableSync(agentDir: string): boolean {
	const runDirs = listOwnedLaunchRunDirs(agentDir);
	if (runDirs.length === 0) return false;
	return runDirs.every((runDir) => retiredDirSync(runDir, agentDir) && deletableOutcome(ownedOutcomeForRunDirSync(runDir).kind));
}

/**
 * Concurrency-slot authorization: an actual outcome record — kernel
 * drainage (receipt), a synchronous never-started bridge, or a won restart
 * fence — releases the slot. An unproven failure releases it only when it
 * is durably retired AND its directory never held the ownership journal:
 * the supervisor journals before any release and, once its terminal fail
 * receipt exists, a KeepAlive restart only retires the jobs, so a
 * journal-less fail receipt with both jobs gone is a pre-release failure.
 * Deletion still requires kernel-drained proof. Mere journal absence or job
 * absence without an outcome record (a pending run) never releases it.
 */
export function ownedSlotReleasedSync(agentDir: string): boolean {
	const runDirs = listOwnedLaunchRunDirs(agentDir);
	if (runDirs.length === 0) return false;
	return runDirs.every((runDir) => {
		const kind = ownedOutcomeForRunDirSync(runDir).kind;
		if (deletableOutcome(kind)) return true;
		return kind === "unproven-fail" && retiredDirSync(runDir, agentDir) && !fs.existsSync(path.join(runDir, "owned.json"));
	});
}

/** Persist a deterministically recovered terminal exit (never overwrites an existing record). */
export function persistOwnedRecoveredExit(agentDir: string, exit: { exitCode: number } | { stopped: true }): void {
	try {
		const value = "stopped" in exit ? "stopped" : String(exit.exitCode);
		fs.writeFileSync(path.join(agentDir, "exit_code"), value, { encoding: "utf8", flag: "wx" });
		fs.writeFileSync(path.join(agentDir, "finished_at"), new Date().toISOString(), { encoding: "utf8", flag: "wx" });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
}

const inFlightReconcile = new Set<string>();

/**
 * Parent-restart reconciliation: recover truthful terminal state for owned
 * runs whose receipts are final, and cache retirement markers for them.
 * Reconciliation is CONTINUOUS: a recovered exit_code alone is not a
 * retirement proof, so a run keeps being reconciled (every wait/poll
 * iteration re-invokes this) until each of its UUID directories holds a
 * durable retirement marker — a receipt written before the jobs booted out
 * can therefore never leave a permanent artifact leak. Pointerless runs
 * (a crash between the atomic UUID publish and the pointer write, or a
 * lost pointer) are reconciled directory by directory. Unclaimed pending
 * directories are fenced (see fenceAbandonedRunDir); bridge-claimed pending
 * directories stay nonterminal and nondeletable and never have retirement
 * cached from job absence. Fire-and-forget safe; never blocks the caller and never runs
 * launchctl synchronously.
 */
export function reconcileOwnedRuns(runDir: string, agentIds?: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(runDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (agentIds && !agentIds.includes(entry.name)) continue;
		const agentDir = path.join(runDir, entry.name);
		if (inFlightReconcile.has(agentDir) || ownedHandleActiveSync(agentDir)) continue;
		try {
			if (!ownedArtifactsPresentSync(agentDir)) continue;
			// Continuous retry even when exit_code exists: only the durable
			// retirement markers (or a fully reconciled terminal state) stop
			// the reconciliation loop.
			if (fs.existsSync(path.join(agentDir, "exit_code")) && ownedRetiredSync(agentDir)) continue;
		} catch {
			continue;
		}
		inFlightReconcile.add(agentDir);
		void reconcileOwnedAgent(agentDir)
			.catch(() => {})
			.finally(() => inFlightReconcile.delete(agentDir));
	}
}

async function reconcileOwnedAgent(agentDir: string): Promise<void> {
	// Every surviving UUID directory is examined, not just the pointer: a
	// crash between the atomic publish and the pointer write leaves the
	// newest run unpointed (the pointer, if any, still names an older run).
	for (const runDir of listOwnedLaunchRunDirs(agentDir)) await fenceAbandonedRunDir(agentDir, runDir);
	// A live in-process launch owns its own completion (settle loop): never
	// persist a recovered exit for it, including when a launch started while
	// this reconciliation was awaiting.
	if (ownedHandleActiveSync(agentDir)) return;
	const primary = ownedPrimaryRunDirSync(agentDir);
	const outcome = primary ? ownedOutcomeForRunDirSync(primary) : undefined;
	if (outcome && deletableOutcome(outcome.kind)) {
		const recovered = ownedRecoveredExitSync(agentDir, outcome);
		if (recovered) persistOwnedRecoveredExit(agentDir, recovered);
	}
	// Keep retrying the retirement proof even though the exit may already be
	// recovered: state/wait stay nonterminal until it is cached for EVERY
	// directory (pending ones make it fail closed).
	const retired = await verifyOwnedRetirementAsync(agentDir).catch(() => false);
	// Terminal failure without kernel proof: only the exact-label launchd
	// absence may settle it.
	if (retired && outcome?.kind === "unproven-fail" && !ownedHandleActiveSync(agentDir) &&
		ownedPrimaryRunDirSync(agentDir) === primary) persistOwnedRecoveredExit(agentDir, { exitCode: 1 });
}

/**
 * Resolve a pending, unclaimed claim-protocol directory by winning its
 * exclusive launch claim. Skipped while this process holds the live launch
 * handle (the bridge may simply not have claimed yet) and before the fence
 * grace elapses; neither condition is needed for safety, because a fenced
 * bridge refuses to start anything. Runs from launchers that predate the
 * claim protocol are never fenced (their bridges would not honor it).
 */
async function fenceAbandonedRunDir(agentDir: string, runDir: string): Promise<void> {
	if (ownedOutcomeForRunDirSync(runDir).kind !== "pending") return;
	if (ownedHandleActiveSync(agentDir) || !ownedLaunchClaimProtocolSync(runDir)) return;
	if (readOwnedLaunchClaimSync(runDir) !== "none") return;
	try {
		const published = fs.statSync(path.join(runDir, OWNED_LAUNCH_SPEC_FILE)).mtimeMs;
		if (Date.now() - published < fenceGraceMs) return;
	} catch {
		return;
	}
	await fenceOwnedLaunchRunAsync(runDir);
}

let fenceGraceMs = FENCE_GRACE_MS;

/** Test-only override of the fence grace; production never calls this. */
export function setOwnedFenceGraceForTest(ms: number | undefined): void {
	fenceGraceMs = ms ?? FENCE_GRACE_MS;
}
