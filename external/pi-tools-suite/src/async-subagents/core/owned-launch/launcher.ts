// Owned-launch launcher — the parent-facing entry point. It spawns the
// native bridge as a detached process-group leader with piped stdio, so the
// parent (Pi) keeps exactly the interfaces it has today for a spawned
// sub-agent process: JSONL RPC over stdin/stdout and a PID/process-group
// handle. The parent never blocks on compilers or launchd here: native
// bootstrap runs in a child process, and every native actor enforces its
// own bounded watchdogs.
//
// Containment contract (README.md): the bridge bootstraps the launchd-owned
// UUID supervisor; the supervisor owns worker job creation, journals the
// worker's boot-bound coalition identity before release, and drains the
// whole coalition with exact-generation audit-token SIGKILLs on cancel,
// watchdog, natural completion cleanup, or its own restart. Nothing in this
// file ever signals or enumerates payload processes.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { ensureOwnedLaunchBinaries, type OwnedLaunchBinaries } from "./bootstrap.js";
import {
	createSecureDir,
	ensureSecureDir,
	nextOwnedLaunchGeneration,
	ownedLaunchLabel,
	OWNED_LAUNCH_GENERATION_FILE,
	resolveSocketsDir,
} from "./label.js";
import {
	OWNED_LAUNCH_CLAIM_PROTOCOL_CONTENT,
	OWNED_LAUNCH_CLAIM_PROTOCOL_FILE,
	writeOwnedLaunchCancelMarker,
} from "./marker.js";
import { writeOwnedLaunchSpec, type OwnedLaunchWorkerSpec } from "./spec.js";

export interface OwnedLaunchTimeouts {
	/** Supervisor liveness watchdog (monotonic, from supervisor start). */
	watchdogSeconds: number;
	/** Max seconds from worker job creation to the gate publishing identity. */
	releaseTimeoutSeconds: number;
	/** Max seconds for a full coalition drain. */
	drainDeadlineSeconds: number;
}

export const DEFAULT_OWNED_LAUNCH_TIMEOUTS: OwnedLaunchTimeouts = {
	watchdogSeconds: 30 * 60,
	releaseTimeoutSeconds: 20,
	drainDeadlineSeconds: 30,
};

export interface LaunchOwnedAgentOptions {
	/** Payload executable (e.g. the pi invocation command). */
	command: string;
	/** Payload argv (without argv[0]). */
	args: string[];
	/** Payload working directory. */
	cwd: string;
	/** Borrowed environment for the payload; defaults to process.env. */
	env?: NodeJS.ProcessEnv;
	/** Base directory for per-run artifacts (created 0700 if missing). */
	baseDir: string;
	/** Prebuilt native binaries (tests); built and cached otherwise. */
	binaries?: OwnedLaunchBinaries;
	/** Deterministic run id override (tests); defaults to a fresh UUID. */
	uuid?: string;
	timeouts?: Partial<OwnedLaunchTimeouts>;
	/** Persist the caller's ownership pointer before any native process exists. */
	beforeSpawn?: (prepared: { runDir: string; labelSupervisor: string; labelWorker: string }) => void;
}

export interface OwnedLaunchExit {
	code: number | null;
	signal: NodeJS.Signals | null;
}

export interface OwnedLaunchHandle {
	pid: number;
	process: ChildProcess;
	runDir: string;
	socketsDir: string;
	labelSupervisor: string;
	labelWorker: string;
	spec: OwnedLaunchWorkerSpec;
	/** Resolves when the bridge process has exited. */
	exited: Promise<OwnedLaunchExit>;
	/**
	 * Graceful stop: first the durable disk cancel marker (fsync + dir
	 * fsync — the supervisor polls it pre-release and on every monitoring
	 * iteration, so cancellation is ordered even when the bridge is already
	 * dead, kill() fails, or no live child handle exists), then SIGTERM to
	 * the bridge only (our own direct child, never a PID sweep and never
	 * the payload). Either leg alone makes the supervisor drain the owned
	 * coalition.
	 */
	stop(): void;
}

function resolveEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> {
	const source = env ?? process.env;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined) continue;
		if (!key || key.includes("=") || key.includes("\0") || value.includes("\0")) continue;
		out[key] = value;
	}
	return out;
}

/**
 * Hidden pre-launch staging prefix. Staging names are dot-prefixed and can
 * never match the UUID run-directory shape, so no reader (state, reuse
 * guards, cleanup, retirement) can mistake an in-progress preparation for
 * a launched run, and no launched actor ever references a staging path.
 */
export const OWNED_LAUNCH_STAGING_PREFIX = ".staging-";

let stagingCounter = 0;

function stagingDirName(uuid: string): string {
	return `${OWNED_LAUNCH_STAGING_PREFIX}${uuid}-${process.pid}-${Date.now().toString(36)}-${(stagingCounter++).toString(36)}`;
}

function writeSmallRecord(dir: string, name: string, content: string): void {
	const fd = openSync(join(dir, name), "wx", 0o600);
	try {
		writeSync(fd, content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function writeClaimProtocol(dir: string): void {
	writeSmallRecord(dir, OWNED_LAUNCH_CLAIM_PROTOCOL_FILE, OWNED_LAUNCH_CLAIM_PROTOCOL_CONTENT);
}

/**
 * Atomically publish the complete staged run directory under its UUID
 * name. Refuses any existing target (no overwrite, no symlink/traversal
 * reuse); the rename makes the whole prepared content (spec first) appear
 * in one step, so a crash can only leave either no visible UUID directory
 * or a complete one — never a visible UUID directory without its spec.
 */
function publishStagedRunDir(baseDir: string, stagingDir: string, runDir: string): void {
	if (existsSync(runDir)) throw new Error(`owned-launch run directory already exists: ${runDir}`);
	renameSync(stagingDir, runDir);
	const dirFd = openSync(baseDir, "r");
	try {
		fsyncSync(dirFd);
	} finally {
		closeSync(dirFd);
	}
}

/**
 * Launch one owned contained sub-agent process. Resolves once the bridge is
 * spawned (containment is enforced by the native actors from there); the
 * handle's stdio pipes behave like a normal spawned sub-agent process.
 */
export function launchOwnedAgentSync(options: LaunchOwnedAgentOptions & { binaries: OwnedLaunchBinaries }): OwnedLaunchHandle {
	if (process.platform !== "darwin") {
		throw new Error("owned-launch is macOS-only (launchd gui domain + coalition/audit-token primitives)");
	}
	const binaries = options.binaries;
	const uuid = options.uuid ?? randomUUID();
	const labelSupervisor = ownedLaunchLabel();
	const labelWorker = ownedLaunchLabel();
	ensureSecureDir(options.baseDir);
	const runDir = join(options.baseDir, uuid);
	if (existsSync(runDir)) throw new Error(`owned-launch run directory already exists: ${runDir}`);
	// Pre-spawn transaction, phase 1 — hidden staging: the run directory is
	// prepared under a dot-prefixed staging name no run-directory reader can
	// match and no launched actor ever references. Everything from here until
	// the atomic publish either succeeds completely or removes the staging
	// directory again. At this point no ownership pointer can exist (callers
	// persist it only inside beforeSpawn), no bridge has been exec'd, and no
	// launchd job can exist for this UUID — so rollback can never strand a
	// live or failed owned run. A process crash can only leave a hidden
	// staging leftover, which is RETAINED indefinitely: age alone is not
	// abandonment proof (a paused parent can still publish after an
	// arbitrarily long delay), and hidden staging leftovers hold no slot,
	// surface as no run, and are ignored by every reader. A crash AFTER the
	// publish (before the pointer or the bridge spawn) leaves a visible,
	// unclaimed run: restart recovery resolves it by winning the exclusive
	// launch claim (marker.ts), which a late bridge then refuses to run.
	let temporarySocketsDir: string | undefined;
	let spec: OwnedLaunchWorkerSpec;
	const stagingDir = createSecureDir(options.baseDir, stagingDirName(uuid));
	try {
		// Socket path semantics are computed for the FINAL run directory: the
		// spec is only ever read after publish, by which time the path exists.
		const sockets = resolveSocketsDir(runDir);
		if (sockets.temporary) {
			ensureSecureDir(sockets.dir);
			temporarySocketsDir = sockets.dir;
		}
		const timeouts = { ...DEFAULT_OWNED_LAUNCH_TIMEOUTS, ...options.timeouts };
		spec = {
			version: 1,
			command: options.command,
			args: options.args,
			cwd: options.cwd,
			env: resolveEnv(options.env),
			socketsDir: sockets.dir,
			supervisorBinary: binaries.supervisor,
			gateBinary: binaries.gate,
			labelSupervisor,
			labelWorker,
			watchdogSeconds: timeouts.watchdogSeconds,
			releaseTimeoutSeconds: timeouts.releaseTimeoutSeconds,
			drainDeadlineSeconds: timeouts.drainDeadlineSeconds,
		};
		writeOwnedLaunchSpec(stagingDir, spec);
		// Published together with the spec: declares that this run's bridge
		// takes the exclusive launch claim, which is what lets restart
		// recovery fence the run if the parent dies before the bridge starts.
		writeClaimProtocol(stagingDir);
		writeSmallRecord(stagingDir, OWNED_LAUNCH_GENERATION_FILE, `generation=${nextOwnedLaunchGeneration(options.baseDir)}\n`);
		// Phase 2 — atomic publish (refuses any collision): from this instant
		// a visible UUID directory always holds its complete spec, so restart
		// reconciliation can label and retire it even without a pointer.
		publishStagedRunDir(options.baseDir, stagingDir, runDir);
	} catch (error) {
		try {
			rmSync(stagingDir, { recursive: true, force: true });
			if (temporarySocketsDir) rmSync(temporarySocketsDir, { recursive: true, force: true });
		} catch {
			/* unwritable leftovers stay fail-closed pending, never terminal */
		}
		throw error;
	}
	options.beforeSpawn?.({ runDir, labelSupervisor, labelWorker });

	const proc = spawn(binaries.bridge, [runDir], {
		cwd: options.cwd,
		// Minimal bridge environment: the bridge reaches /bin/launchctl by
		// absolute path and reads everything else from the 0600 spec file.
		env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: process.env.TMPDIR },
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
	if (!proc.pid || typeof proc.pid !== "number") {
		// pid is only ever unset when the exec itself failed (uv_spawn error,
		// e.g. ENOENT): swallow the inevitable async 'error' emission so this
		// synchronous throw stays the single failure surface.
		proc.once("error", () => {});
		throw new Error(`owned-launch bridge failed to start: ${binaries.bridge}`);
	}
	const exited = new Promise<OwnedLaunchExit>((resolve) => {
		proc.once("exit", (code, signal) => resolve({ code, signal }));
		proc.once("error", () => resolve({ code: null, signal: null }));
	});
	let stopped = false;
	return {
		pid: proc.pid,
		process: proc,
		runDir,
		socketsDir: spec.socketsDir,
		labelSupervisor,
		labelWorker,
		spec,
		exited,
		stop() {
			if (stopped) return;
			stopped = true;
			// Durable disk cancel FIRST, before any liveness check: the
			// supervisor polls this marker pre-release and during monitoring,
			// so cancel is ordered even when the bridge already exited, the
			// handle is stale, or kill() itself fails.
			try {
				writeOwnedLaunchCancelMarker(runDir);
			} catch {
				/* run dir gone/unwritable: nothing left to protect (fault
				 * model excludes external tampering with the run dir) */
			}
			if (proc.exitCode !== null || proc.signalCode !== null) return;
			// Only ever our own direct child; the exit event guards against a
			// reused PID, and the supervisor owns all payload cleanup.
			try {
				proc.kill("SIGTERM");
			} catch {
				/* already exited */
			}
		},
	};
}

/** Prepare binaries asynchronously outside the synchronous spawn/UI path. */
export async function prepareOwnedLaunchBinaries(): Promise<OwnedLaunchBinaries> {
	return ensureOwnedLaunchBinaries();
}

/** Compatibility wrapper for asynchronous clients. */
export async function launchOwnedAgent(options: LaunchOwnedAgentOptions): Promise<OwnedLaunchHandle> {
	return launchOwnedAgentSync({ ...options, binaries: options.binaries ?? (await prepareOwnedLaunchBinaries()) });
}
