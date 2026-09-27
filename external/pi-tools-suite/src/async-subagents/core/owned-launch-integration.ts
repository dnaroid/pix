/** Runtime boundary for the one provider requiring durable macOS ownership. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTask } from "./types.js";
import { ensureOwnedLaunchBinaries, type OwnedLaunchBinaries } from "./owned-launch/bootstrap.js";
import { launchOwnedAgentSync, type OwnedLaunchHandle } from "./owned-launch/launcher.js";
import { listOwnedLaunchRunDirs, readOwnedLaunchGeneration } from "./owned-launch/label.js";
import { normalizeProviderArgs, resolveFinalModel, selectsClaudeProvider, subagentEnvModel } from "./provider-extensions.js";
import { OWNED_NEVER_LAUNCHED_MARKER, ownedLaunchClaimProtocolSync, readOwnedLaunchClaimSync } from "./owned-launch/marker.js";

export const OWNED_PROVIDER = "pi-claude-code-provider";
export const OWNED_METADATA = "owned_launch";
const BRIDGE_LAUNCH_FAILED_MARKER = "bridge_launch_failed";
const MAX_RECEIPT = 2048;

function flag(args: string[], names: string[]): string | undefined {
	let value: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (names.includes(args[i])) value = args[++i];
		else for (const name of names) if (args[i].startsWith(`${name}=`)) value = args[i].slice(name.length + 1);
	}
	return value;
}

export function maySelectOwnedProvider(task: AgentTask, extraArgs: string[] = [], fallbackModels: string[] = []): boolean {
	return [task.model, flag(extraArgs, ["--model", "-m"]), flag(extraArgs, ["--models"]), ...fallbackModels]
		.some((model) => model?.split("/")[0] === OWNED_PROVIDER) || selectsOwnedProvider(task, extraArgs);
}

/** Same predicate spawnAgent uses for the owned launch and the provider dependency. */
export function selectsOwnedProvider(task: AgentTask, extraArgs: string[] = []): boolean {
	const args = normalizeProviderArgs(extraArgs);
	return selectsClaudeProvider(resolveFinalModel(task.model?.trim() || subagentEnvModel(), args), args);
}

export interface OwnedMetadata { runDir: string; labelSupervisor: string; labelWorker: string }

export function readOwnedMetadata(agentDir: string): OwnedMetadata | undefined {
	try {
		const file = path.join(agentDir, OWNED_METADATA);
		if (fs.statSync(file).size > 2048) return undefined;
		const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!data || typeof data !== "object") return undefined;
		const value = data as Partial<OwnedMetadata>;
		const base = path.resolve(agentDir, "owned-launch");
		if (typeof value.runDir !== "string" || path.dirname(path.resolve(value.runDir)) !== base ||
			! /^[0-9a-f-]{36}$/i.test(path.basename(value.runDir)) ||
			typeof value.labelSupervisor !== "string" || typeof value.labelWorker !== "string") return undefined;
		return value as OwnedMetadata;
	} catch { return undefined; }
}

/**
 * Receipt taxonomy shared with the native supervisor:
 * - `retry`            drain not confirmed — ownership stays pending, never terminal;
 * - `ok` + kernel proof drained-ok (cause `natural`/`leader_exit` must carry a
 *   valid 0..255 payload exit from payload-exit.json); an `ok` receipt that
 *   still carries an anomaly `note` (e.g. `worker_bootout_failed`) is self-
 *   contradicting and stays pending;
 * - `fail` + kernel proof drained-fail — terminal failure, coalition drained;
 * - `fail` without kernel proof unproven-fail — terminal only after the exact
 *   launchd labels are confirmed absent (retirement marker);
 * - `never-launched`: restart recovery won the exclusive launch claim
 *   (`claim` holds the fence record) of a run that declared the claim
 *   protocol, or the claim-owning bridge recorded `prelaunch_abort` before
 *   any launchctl action, and no journal or receipt exists — the bridge refuses a
 *   fenced run before any bind/launchctl action, so nothing can have been
 *   bootstrapped or released (retirement is still verified before deletion);
 * - a legacy `never_launched` marker is not proof: the rejected age-based
 *   recovery path did not exclude a paused launcher starting later;
 * - anything malformed, mismatched, or zero-cid/zero-boot pending.
 * Kernel proof means: a full-shape journal whose boot/cid bind the receipt,
 * a nonzero coalition id, and either journal-backed ESRCH or a strictly
 * positive tasks_started == tasks_exited oracle. A process exit, a numeric
 * PID, or an arbitrary zero cid is never proof.
 */
export type OwnedOutcomeKind = "none" | "pending" | "drained-ok" | "drained-fail" | "unproven-fail" | "launch-failed" | "never-launched";

export interface OwnedRunOutcome {
	kind: OwnedOutcomeKind;
	cause: string;
	/** Payload exit 0..255 when the receipt chain preserved it; otherwise null. */
	payloadCode: number | null;
}

function parseRecord(text: string): Record<string, string> | undefined {
	if (!text.endsWith("\n") || text.length > MAX_RECEIPT || text.includes("\r") || text.slice(0, -1).includes("\n")) return undefined;
	const record: Record<string, string> = Object.create(null);
	for (const part of text.slice(0, -1).split(" ")) {
		if (!/^[a-z_]+=[A-Za-z0-9_.-]+$/.test(part)) return undefined;
		const at = part.indexOf("=");
		const key = part.slice(0, at);
		if (key in record) return undefined;
		record[key] = part.slice(at + 1);
	}
	return record;
}

async function smallRecord(file: string): Promise<Record<string, string> | undefined> {
	try {
		const stat = await fs.promises.stat(file);
		if (stat.size > MAX_RECEIPT || stat.size < 2 || !stat.isFile()) return undefined;
		return parseRecord(await fs.promises.readFile(file, "utf8"));
	} catch { return undefined; }
}

function smallRecordSync(file: string): Record<string, string> | undefined {
	try {
		const size = fs.statSync(file).size;
		return size > 1 && size <= MAX_RECEIPT ? parseRecord(fs.readFileSync(file, "utf8")) : undefined;
	} catch { return undefined; }
}

function validJournal(journal: Record<string, string> | undefined): journal is Record<string, string> {
	// Full native shape: boot seconds and every identity counter must be
	// strictly positive; cid 0 is the kernel task and never a coalition the
	// supervisor could own or drain.
	return !!journal && journal.role === "owned" &&
		/^[1-9]\d*\.\d{6}$/.test(journal.boot ?? "") &&
		/^[0-9a-f]+$/.test(journal.cid ?? "") && journal.cid !== "0" &&
		/^[1-9]\d*$/.test(journal.worker_pid ?? "") &&
		/^[1-9]\d*$/.test(journal.worker_pidversion ?? "") &&
		/^[0-9a-f]{64}$/.test(journal.worker_token ?? "") &&
		/^[1-9]\d*$/.test(journal.journaled_at ?? "");
}

function validPayloadCode(payload?: Record<string, string>): number | null {
	if (!payload || payload.role !== "payload-exit" || !/^\d+$/.test(payload.code ?? "")) return null;
	const code = Number(payload.code);
	return code >= 0 && code <= 255 ? code : null;
}

function classifyReceipt(
	receipt: Record<string, string> | undefined,
	journal: Record<string, string> | undefined,
	payload: Record<string, string> | undefined,
	launchFailed: boolean,
	neverLaunched: boolean,
	fencedUnjournaled = false,
): OwnedRunOutcome {
	if (launchFailed) return { kind: "launch-failed", cause: "bridge_spawn_failed", payloadCode: null };
	if (!receipt && fencedUnjournaled) return { kind: "never-launched", cause: "never_launched", payloadCode: null };
	if (neverLaunched && !receipt) return { kind: "pending", cause: "unproven_never_launched", payloadCode: null };
	const pending: OwnedRunOutcome = { kind: "pending", cause: "", payloadCode: null };
	if (!receipt || receipt.role !== "drain") return pending;
	if (receipt.status === "retry") return { kind: "pending", cause: receipt.cause ?? "", payloadCode: null };
	if (receipt.status !== "ok" && receipt.status !== "fail") return pending;
	if (!/^[1-9]\d*\.\d{6}$/.test(receipt.boot ?? "") || !/^[0-9a-f]+$/.test(receipt.cid ?? "") || receipt.cid === "0" ||
		!/^\d+$/.test(receipt.started ?? "") || !/^\d+$/.test(receipt.exited ?? "") ||
		!/^\d+$/.test(receipt.mismatch ?? "") || !["0", "1"].includes(receipt.esrch ?? "")) return pending;
	const payloadCode = validPayloadCode(payload);
	const journalBound = journal !== undefined && validJournal(journal) && journal.boot === receipt.boot && journal.cid === receipt.cid;
	// ESRCH counts only journal-backed; the counted oracle requires a strictly
	// positive tasks_started so fabricated all-zero counters are never proof.
	const kernelZero = receipt.esrch === "1" ||
		(BigInt(receipt.started) > 0n && BigInt(receipt.started) === BigInt(receipt.exited));
	const proved = journalBound && kernelZero;
	if (receipt.status === "ok") {
		// A success receipt carrying an anomaly note (the supervisor rewrites
		// the receipt with `worker_bootout_failed` when job removal fails)
		// contradicts itself: stay pending until a clean receipt or an
		// independently confirmed retirement exists.
		if (receipt.note !== undefined) return pending;
		if (!proved) return pending;
		// A success claim for a payload run must preserve the payload's own
		// exit status; negative or missing payload codes are not success.
		if (["natural", "leader_exit"].includes(receipt.cause ?? "") && payloadCode === null) return pending;
		return { kind: "drained-ok", cause: receipt.cause ?? "", payloadCode };
	}
	return proved ? { kind: "drained-fail", cause: receipt.cause ?? "", payloadCode: null }
		: { kind: "unproven-fail", cause: receipt.cause ?? "", payloadCode: null };
}

/** Classify one owned-launch UUID run directory from its durable records. */
export function ownedOutcomeForRunDirSync(runDir: string): OwnedRunOutcome {
	return classifyReceipt(
		smallRecordSync(path.join(runDir, "drain.json")),
		smallRecordSync(path.join(runDir, "owned.json")),
		smallRecordSync(path.join(runDir, "payload-exit.json")),
		fs.existsSync(path.join(runDir, "bridge_launch_failed")),
		fs.existsSync(path.join(runDir, OWNED_NEVER_LAUNCHED_MARKER)),
		(ownedRunFencedSync(runDir) || ownedPrelaunchAbortedSync(runDir)) && !fs.existsSync(path.join(runDir, "owned.json")),
	);
}

/**
 * True when the claim-owning bridge durably recorded a deterministic failure
 * before any launchctl action (`prelaunch_abort`, exits 13/14/18): it owns
 * the exclusive claim, so no other bridge can ever start this run.
 */
export function ownedPrelaunchAbortedSync(runDir: string): boolean {
	if (!ownedLaunchClaimProtocolSync(runDir) || readOwnedLaunchClaimSync(runDir) !== "bridge") return false;
	const record = smallRecordSync(path.join(runDir, "prelaunch_abort"));
	return record?.role === "prelaunch-abort" && ["13", "14", "18"].includes(record.code ?? "") && Object.keys(record).length === 2;
}

/** True when restart recovery holds the exclusive launch claim of a claim-protocol run. */
export function ownedRunFencedSync(runDir: string): boolean {
	return ownedLaunchClaimProtocolSync(runDir) && readOwnedLaunchClaimSync(runDir) === "fence";
}

/**
 * The generation whose outcome is the agent's: the unique highest
 * `generation` record (published atomically with the spec, so it survives a
 * crash before the pointer write); otherwise, for legacy directories, the
 * pointer's directory or the only surviving directory. Ambiguity (ties,
 * several legacy pointerless directories) yields undefined — fail closed.
 */
export function ownedPrimaryRunDirSync(agentDir: string): string | undefined {
	const runDirs = listOwnedLaunchRunDirs(agentDir);
	let best: string | undefined;
	let bestGeneration = 0;
	let tie = false;
	for (const runDir of runDirs) {
		const generation = readOwnedLaunchGeneration(runDir) ?? 0;
		if (generation > bestGeneration) {
			best = runDir;
			bestGeneration = generation;
			tie = false;
		} else if (generation === bestGeneration && generation > 0) tie = true;
	}
	if (best && !tie) return best;
	const meta = readOwnedMetadata(agentDir);
	if (meta && runDirs.includes(path.resolve(meta.runDir))) return path.resolve(meta.runDir);
	return runDirs.length === 1 ? runDirs[0] : undefined;
}

/** Classify the primary (newest) owned-launch run of an agent directory. */
export function ownedOutcomeSync(agentDir: string): OwnedRunOutcome {
	const primary = ownedPrimaryRunDirSync(agentDir);
	return primary ? ownedOutcomeForRunDirSync(primary) : { kind: "none", cause: "", payloadCode: null };
}

function drainedTerminal(outcome: OwnedRunOutcome): boolean {
	return outcome.kind === "drained-ok" || outcome.kind === "drained-fail";
}

/** True when the metadata-pointed run holds a kernel-drained terminal receipt (ok or fail). */
export function verifiedOwnedDrainSync(agentDir: string): boolean {
	return drainedTerminal(ownedOutcomeSync(agentDir));
}

export async function verifiedOwnedDrain(agentDir: string): Promise<boolean> {
	const meta = readOwnedMetadata(agentDir);
	if (!meta) return false;
	const [receipt, journal, payload] = await Promise.all([
		smallRecord(path.join(meta.runDir, "drain.json")), smallRecord(path.join(meta.runDir, "owned.json")),
		smallRecord(path.join(meta.runDir, "payload-exit.json")),
	]);
	return drainedTerminal(classifyReceipt(receipt, journal, payload, fs.existsSync(path.join(meta.runDir, "bridge_launch_failed")),
		fs.existsSync(path.join(meta.runDir, OWNED_NEVER_LAUNCHED_MARKER))));
}

export async function waitForOwnedDrain(agentDir: string, deadlineMs: number): Promise<boolean> {
	while (Date.now() < deadlineMs) {
		if (verifiedOwnedDrainSync(agentDir)) return true;
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
	}
	return verifiedOwnedDrainSync(agentDir);
}

/**
 * Deterministic terminal-exit recovery for an owned run whose final receipt
 * exists but whose exit_code was never persisted (for example after a parent
 * restart). Precedence mirrors the in-process bridge semantics: user stop,
 * then the timeout marker (124), then the receipt's preserved payload exit,
 * then cancellation causes (SIGTERM-equivalent 143), then honest failure.
 */
export function ownedRecoveredExitSync(agentDir: string, outcome: OwnedRunOutcome): { exitCode: number } | { stopped: true } | undefined {
	if (outcome.kind === "drained-ok") {
		if (fs.existsSync(path.join(agentDir, "stop_requested"))) return { stopped: true };
		if (fs.existsSync(path.join(agentDir, "timeout_ms")) && fs.existsSync(path.join(agentDir, "timed_out_at"))) return { exitCode: 124 };
		if (outcome.payloadCode !== null) return { exitCode: outcome.payloadCode };
		if (["cancel", "watchdog", "restart_recovery", "startup-cancel"].includes(outcome.cause)) return { exitCode: 143 };
		return { exitCode: 1 };
	}
	if (outcome.kind === "drained-fail" || outcome.kind === "launch-failed" || outcome.kind === "unproven-fail" ||
		outcome.kind === "never-launched") return { exitCode: 1 };
	return undefined;
}

export function requestOwnedCancel(agentDir: string): void {
	const meta = readOwnedMetadata(agentDir);
	if (!meta) throw new Error("owned-launch metadata missing or invalid; refusing PID-based stop");
	const marker = path.join(meta.runDir, "cancel");
	let fd: number | undefined;
	try {
		fd = fs.openSync(marker, "wx", 0o600);
		fs.writeSync(fd, "cancel\n");
		fs.fsyncSync(fd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	} finally { if (fd !== undefined) fs.closeSync(fd); }
	const dirFd = fs.openSync(meta.runDir, "r");
	try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
	activeHandles.get(agentDir)?.stop();
}

/**
 * Durable record that the bridge process never started (the launcher only
 * throws before exec). No launchd job can therefore have existed for this
 * run; retirement still requires the marker so cleanup stays uniform.
 */
export function markBridgeLaunchFailed(runDir: string, reason: string): void {
	const file = path.join(runDir, BRIDGE_LAUNCH_FAILED_MARKER);
	let fd: number | undefined;
	try {
		fd = fs.openSync(file, "wx", 0o600);
		fs.writeSync(fd, `role=bridge-fail stage=spawn reason=${reason.replace(/[\r\n]/g, " ").slice(0, 180)}\n`);
		fs.fsyncSync(fd);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

const activeHandles = new Map<string, OwnedLaunchHandle>();

function writeOwnedMetadataAtomic(agentDir: string, meta: OwnedMetadata): void {
	// Durable, atomic ownership pointer: temp file + fsync + rename + dir
	// fsync, so a crash can only leave either no pointer or a complete one.
	const target = path.join(agentDir, OWNED_METADATA);
	const temp = path.join(agentDir, `${OWNED_METADATA}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	let fd: number | undefined;
	try {
		fd = fs.openSync(temp, "wx", 0o600);
		fs.writeSync(fd, JSON.stringify(meta));
		fs.fsyncSync(fd);
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	fs.renameSync(temp, target);
	const dirFd = fs.openSync(agentDir, "r");
	try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

export function launchPreparedOwnedAgent(options: {
	agentDir: string; command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; binaries: OwnedLaunchBinaries;
}): OwnedLaunchHandle {
	if (process.platform !== "darwin") throw new Error("owned launch requires macOS");
	let preparedRunDir: string | undefined;
	let handle: OwnedLaunchHandle;
	try {
		handle = launchOwnedAgentSync({
			...options,
			baseDir: path.join(options.agentDir, "owned-launch"),
			// The metadata pointer must exist BEFORE the bridge process can:
			// an exception here aborts the launch with nothing running.
			beforeSpawn: (prepared) => {
				preparedRunDir = prepared.runDir;
				writeOwnedMetadataAtomic(options.agentDir, {
					runDir: prepared.runDir, labelSupervisor: prepared.labelSupervisor, labelWorker: prepared.labelWorker,
				});
			},
		});
	} catch (error) {
		// The launcher only throws before exec: the bridge never started, so
		// no launchd job can exist. Record that durably so this run can never
		// masquerade as a pending owned launch, then surface the failure.
		if (preparedRunDir) {
			let marked = false;
			try {
				markBridgeLaunchFailed(preparedRunDir, String(error));
				marked = true;
			} catch {
				/* unwritable run dir: fall back to full rollback below */
			}
			if (!marked) {
				// No provable never-launched marker could be persisted. Roll the
				// whole attempt back instead of leaving artifacts no reader could
				// classify, which would hold the concurrency slot forever.
				try { fs.rmSync(preparedRunDir, { recursive: true, force: true }); } catch { /* best effort */ }
				try {
					const meta = readOwnedMetadata(options.agentDir);
					if (meta && path.resolve(meta.runDir) === path.resolve(preparedRunDir))
						fs.rmSync(path.join(options.agentDir, OWNED_METADATA), { force: true });
				} catch { /* best effort */ }
			}
		}
		throw error;
	}
	activeHandles.set(options.agentDir, handle);
	return handle;
}

export function forgetOwnedHandle(agentDir: string): void { activeHandles.delete(agentDir); }
/** True while this process holds the live launch handle of the agent directory. */
export function ownedHandleActiveSync(agentDir: string): boolean { return activeHandles.has(agentDir); }
export { ensureOwnedLaunchBinaries };
export type { OwnedLaunchBinaries, OwnedLaunchHandle };
