import { execFileSync, spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export type BackgroundJobStatus = "starting" | "running" | "exited" | "killed" | "failed";

export interface BackgroundJobSnapshot {
	readonly id: string;
	readonly sessionKey: string;
	readonly command: string;
	readonly description?: string;
	readonly cwd: string;
	readonly pid?: number;
	readonly status: BackgroundJobStatus;
	readonly exitCode?: number | null;
	readonly signal?: string | null;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly logPath: string;
	readonly totalBytes: number;
	readonly error?: string;
}

export interface BackgroundJobOutput {
	readonly job: BackgroundJobSnapshot;
	readonly text: string;
	/** Absolute byte offset where the returned text starts. */
	readonly from: number;
	/** Next absolute cursor; equals totalBytes when everything was read. */
	readonly cursor: number;
	/** True when requested bytes were dropped from the ring buffer or max_bytes limited the read. */
	readonly truncated: boolean;
}

export interface OrphanRecord {
	readonly pid: number;
	readonly command: string;
	readonly startedAt: number;
	readonly processStart?: string;
	readonly sessionKey: string;
	readonly jobId: string;
	readonly logPath: string;
	readonly metaPath: string;
}

export interface StartJobOptions {
	readonly sessionKey: string;
	readonly command: string;
	readonly cwd: string;
	/** Project root that owns the log/pid files; defaults to cwd. */
	readonly projectCwd?: string;
	readonly env: NodeJS.ProcessEnv;
	readonly shell: string;
	readonly shellArgs: readonly string[];
	readonly description?: string;
	/** Optional wall-clock limit; the job group is terminated when it elapses. */
	readonly maxRuntimeMs?: number;
}

export interface ProcessInspector {
	/** Platform start-time string for pid, or undefined when the process does not exist. */
	startTime(pid: number): string | undefined;
	/** Full command line for pid, or undefined. */
	commandLine(pid: number): string | undefined;
}

export interface BackgroundShellManagerOptions {
	readonly artifactsRoot: (cwd: string) => string;
	readonly maxJobsPerSession?: number;
	readonly bufferBytes?: number;
	readonly killGraceMs?: number;
	readonly retainFinishedJobs?: number;
	readonly spawn?: typeof nodeSpawn;
	readonly inspector?: ProcessInspector;
	readonly ownerPid?: number;
	readonly now?: () => number;
}

export type JobEvent =
	| { type: "status"; job: BackgroundJobSnapshot }
	| { type: "output"; job: BackgroundJobSnapshot };

export const DEFAULT_MAX_JOBS_PER_SESSION = 8;
export const DEFAULT_BUFFER_BYTES = 256 * 1024;
export const DEFAULT_KILL_GRACE_MS = 3000;
const META_SUFFIX = ".json";

/** Byte ring buffer addressed by absolute offsets since job start. */
export class OutputRing {
	private chunks: Buffer[] = [];
	private size = 0;
	private base = 0;
	constructor(private readonly capacity: number) {}
	get start(): number { return this.base; }
	get end(): number { return this.base + this.size; }
	append(data: Buffer): void {
		if (data.length === 0) return;
		if (data.length >= this.capacity) {
			this.base += this.size + data.length - this.capacity;
			this.chunks = [Buffer.from(data.subarray(data.length - this.capacity))];
			this.size = this.capacity;
			return;
		}
		this.chunks.push(data);
		this.size += data.length;
		while (this.size > this.capacity) {
			const head = this.chunks[0]!;
			const excess = this.size - this.capacity;
			if (head.length <= excess) {
				this.chunks.shift();
				this.size -= head.length;
				this.base += head.length;
			} else {
				this.chunks[0] = head.subarray(excess);
				this.size -= excess;
				this.base += excess;
			}
		}
	}
	read(from: number, maxBytes: number): Buffer {
		const start = Math.max(from, this.base);
		const end = Math.min(this.end, start + Math.max(0, maxBytes));
		if (end <= start) return Buffer.alloc(0);
		const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
		this.chunks = [all];
		return Buffer.from(all.subarray(start - this.base, end - this.base));
	}
}

interface JobRecord {
	id: string;
	sessionKey: string;
	command: string;
	description?: string;
	cwd: string;
	pid?: number;
	status: BackgroundJobStatus;
	exitCode?: number | null;
	signal?: string | null;
	startedAt: number;
	endedAt?: number;
	logPath: string;
	metaPath: string;
	logFd?: number;
	ring: OutputRing;
	cursor: number;
	child?: ChildProcess;
	error?: string;
	killRequested?: boolean;
	killTimer?: NodeJS.Timeout;
	runtimeTimer?: NodeJS.Timeout;
	settled: Promise<void>;
	resolveSettled: () => void;
}

export function sanitizePathSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "session";
}

export const defaultProcessInspector: ProcessInspector = {
	startTime(pid) { return psField(pid, "lstart="); },
	commandLine(pid) { return psField(pid, "command="); },
};

function psField(pid: number, field: string): string | undefined {
	if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		// Synchronous ps is bounded and only used at job start/session start, not on UI paths.
		const out = execFileSync("ps", ["-o", field, "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
		return out || undefined;
	} catch {
		return undefined;
	}
}

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		try {
			process.kill(pid, signal);
			return true;
		} catch {
			return false;
		}
	}
}

export class BackgroundShellManager {
	private readonly jobs = new Map<string, JobRecord>();
	private readonly closedSessions = new Set<string>();
	private readonly sessionLimits = new Map<string, number>();
	private readonly listeners = new Set<(event: JobEvent) => void>();
	private readonly maxJobs: number;
	private readonly bufferBytes: number;
	private readonly killGraceMs: number;
	private readonly retainFinished: number;
	private readonly spawnImpl: typeof nodeSpawn;
	private readonly inspector: ProcessInspector;
	private readonly ownerPid: number;
	private readonly now: () => number;
	private exitHook?: () => void;

	constructor(private readonly options: BackgroundShellManagerOptions) {
		this.maxJobs = options.maxJobsPerSession ?? DEFAULT_MAX_JOBS_PER_SESSION;
		this.bufferBytes = options.bufferBytes ?? DEFAULT_BUFFER_BYTES;
		this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
		this.retainFinished = options.retainFinishedJobs ?? 20;
		this.spawnImpl = options.spawn ?? nodeSpawn;
		this.inspector = options.inspector ?? defaultProcessInspector;
		this.ownerPid = options.ownerPid ?? process.pid;
		this.now = options.now ?? Date.now;
	}

	static supported(platform: NodeJS.Platform = process.platform): boolean {
		return platform !== "win32";
	}

	onEvent(listener: (event: JobEvent) => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	/** Re-open a session key (session_start); jobs of a prior runtime were already killed on shutdown. */
	openSession(sessionKey: string): void {
		this.closedSessions.delete(sessionKey);
	}

	/** Override the running-job limit for one session (from layered config). */
	setSessionLimit(sessionKey: string, limit: number): void {
		if (Number.isInteger(limit) && limit >= 1) this.sessionLimits.set(sessionKey, limit);
	}

	/** Install a synchronous process-exit hook that SIGKILLs every live job group. */
	installExitHook(): void {
		if (this.exitHook) return;
		this.exitHook = () => this.killAllSync();
		process.on("exit", this.exitHook);
	}

	dispose(): void {
		this.killAllSync();
		if (this.exitHook) process.off("exit", this.exitHook);
		this.exitHook = undefined;
		this.listeners.clear();
	}

	list(sessionKey: string): BackgroundJobSnapshot[] {
		return [...this.jobs.values()].filter((job) => job.sessionKey === sessionKey).map((job) => this.snapshot(job));
	}

	get(sessionKey: string, jobId: string): BackgroundJobSnapshot | undefined {
		const job = this.jobs.get(jobId);
		return job && job.sessionKey === sessionKey ? this.snapshot(job) : undefined;
	}

	runningCount(sessionKey: string): number {
		return [...this.jobs.values()].filter((job) => job.sessionKey === sessionKey && isLive(job.status)).length;
	}

	start(options: StartJobOptions): BackgroundJobSnapshot {
		if (!BackgroundShellManager.supported()) throw new Error("Background shell jobs are not supported on Windows");
		if (this.closedSessions.has(options.sessionKey)) throw new Error("Session is shutting down; background job not started");
		const limit = this.sessionLimits.get(options.sessionKey) ?? this.maxJobs;
		if (this.runningCount(options.sessionKey) >= limit) {
			throw new Error(`Background job limit reached (${limit} running in this session). Stop one with shell_kill first.`);
		}
		this.pruneFinished(options.sessionKey);
		const id = `bg_${randomBytes(4).toString("hex")}`;
		const dir = join(this.options.artifactsRoot(options.projectCwd ?? options.cwd), sanitizePathSegment(options.sessionKey));
		mkdirSync(dir, { recursive: true });
		const logPath = join(dir, `${id}.log`);
		const metaPath = join(dir, `${id}${META_SUFFIX}`);
		let resolveSettled!: () => void;
		const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
		const job: JobRecord = {
			id, sessionKey: options.sessionKey, command: options.command, description: options.description,
			cwd: options.cwd, status: "starting", startedAt: this.now(), logPath, metaPath,
			ring: new OutputRing(this.bufferBytes), cursor: 0, settled, resolveSettled,
		};
		job.logFd = openSync(logPath, "a");
		this.jobs.set(id, job);

		let child: ChildProcess;
		try {
			child = this.spawnImpl(options.shell, [...options.shellArgs, options.command], {
				cwd: options.cwd,
				env: options.env,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (error) {
			this.finish(job, "failed", null, null, error instanceof Error ? error.message : String(error));
			return this.snapshot(job);
		}
		job.child = child;
		job.pid = child.pid;
		const onData = (data: Buffer) => this.appendOutput(job, data);
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", (error) => {
			this.finish(job, job.killRequested ? "killed" : "failed", null, null, error.message);
		});
		// "exit" (not "close"): detached grandchildren may keep the pipes open.
		child.once("exit", (code, signal) => {
			this.finish(job, job.killRequested ? "killed" : "exited", code, signal);
		});
		if (job.pid !== undefined) {
			job.status = "running";
			this.writeMeta(job);
			if (options.maxRuntimeMs && options.maxRuntimeMs > 0) {
				job.runtimeTimer = setTimeout(() => {
					this.appendOutput(job, Buffer.from(`\n[background-shell] max_runtime ${options.maxRuntimeMs}ms elapsed; terminating\n`));
					void this.kill(job.sessionKey, job.id);
				}, options.maxRuntimeMs);
				job.runtimeTimer.unref?.();
			}
			this.emit({ type: "status", job: this.snapshot(job) });
		}
		return this.snapshot(job);
	}

	/** Wait until the job settles or timeoutMs elapses. */
	async waitFor(sessionKey: string, jobId: string, timeoutMs: number): Promise<BackgroundJobSnapshot | undefined> {
		const job = this.jobs.get(jobId);
		if (!job || job.sessionKey !== sessionKey) return undefined;
		let timer: NodeJS.Timeout | undefined;
		await Promise.race([job.settled, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
		if (timer) clearTimeout(timer);
		return this.snapshot(job);
	}

	read(sessionKey: string, jobId: string, options: { since?: number; maxBytes?: number; filter?: RegExp } = {}): BackgroundJobOutput {
		const job = this.jobs.get(jobId);
		if (!job || job.sessionKey !== sessionKey) throw new Error(`Unknown background job: ${jobId}`);
		const maxBytes = Math.max(1, Math.min(options.maxBytes ?? 32 * 1024, this.bufferBytes));
		const requested = options.since ?? job.cursor;
		const from = Math.max(requested, job.ring.start);
		const bytes = job.ring.read(from, maxBytes);
		const cursor = from + bytes.length;
		const truncated = requested < job.ring.start || cursor < job.ring.end;
		if (options.since === undefined || cursor > job.cursor) job.cursor = Math.max(job.cursor, cursor);
		let text = bytes.toString("utf8");
		if (options.filter) {
			const filter = options.filter;
			text = text.split("\n").filter((line) => { filter.lastIndex = 0; return filter.test(line); }).join("\n");
		}
		return { job: this.snapshot(job), text, from, cursor, truncated };
	}

	tail(jobId: string, maxBytes: number): string {
		const job = this.jobs.get(jobId);
		if (!job) return "";
		return job.ring.read(Math.max(job.ring.start, job.ring.end - maxBytes), maxBytes).toString("utf8");
	}

	/** SIGTERM the group (or a custom signal), escalating to SIGKILL after the grace period. */
	async kill(sessionKey: string, jobId: string, signal: NodeJS.Signals = "SIGTERM"): Promise<BackgroundJobSnapshot> {
		const job = this.jobs.get(jobId);
		if (!job || job.sessionKey !== sessionKey) throw new Error(`Unknown background job: ${jobId}`);
		if (!isLive(job.status)) return this.snapshot(job);
		job.killRequested = true;
		if (job.pid === undefined) {
			this.finish(job, "killed", null, signal);
			return this.snapshot(job);
		}
		signalGroup(job.pid, signal);
		if (signal !== "SIGKILL" && !job.killTimer) {
			job.killTimer = setTimeout(() => { if (job.pid !== undefined) signalGroup(job.pid, "SIGKILL"); }, this.killGraceMs);
			job.killTimer.unref?.();
		}
		await Promise.race([job.settled, new Promise<void>((resolve) => setTimeout(resolve, this.killGraceMs + 1000).unref?.())]);
		// Kill descendants that survived the leader (still in its process group).
		signalGroup(job.pid, "SIGKILL");
		return this.snapshot(job);
	}

	/** session_shutdown: refuse new jobs for the key, then terminate all live ones. */
	async shutdownSession(sessionKey: string): Promise<void> {
		this.closedSessions.add(sessionKey);
		this.sessionLimits.delete(sessionKey);
		const live = [...this.jobs.values()].filter((job) => job.sessionKey === sessionKey);
		await Promise.all(live.map((job) => this.kill(sessionKey, job.id).catch(() => undefined)));
		for (const job of live) {
			this.closeLog(job);
			this.jobs.delete(job.id);
		}
	}

	killAllSync(): void {
		for (const job of this.jobs.values()) {
			if (isLive(job.status) && job.pid !== undefined) {
				job.killRequested = true;
				signalGroup(job.pid, "SIGKILL");
				try { rmSync(job.metaPath, { force: true }); } catch { /* best effort during exit */ }
			}
		}
	}

	/**
	 * Find jobs left by a crashed host. A record is an orphan only when its owner
	 * process is gone and pid, start time and command still match a live process.
	 * Stale records are removed; orphans are reported, never killed implicitly.
	 */
	findOrphans(cwd: string): OrphanRecord[] {
		const root = this.options.artifactsRoot(cwd);
		const orphans: OrphanRecord[] = [];
		let sessions: string[];
		try { sessions = readdirSync(root); } catch { return []; }
		for (const session of sessions) {
			const dir = join(root, session);
			let files: string[];
			try { files = readdirSync(dir).filter((name) => name.endsWith(META_SUFFIX)); } catch { continue; }
			for (const file of files) {
				const metaPath = join(dir, file);
				let meta: Record<string, unknown>;
				try { meta = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>; } catch { continue; }
				const pid = typeof meta.pid === "number" ? meta.pid : undefined;
				const ownerPid = typeof meta.ownerPid === "number" ? meta.ownerPid : undefined;
				const jobId = typeof meta.jobId === "string" ? meta.jobId : file.slice(0, -META_SUFFIX.length);
				if (this.jobs.has(jobId)) continue;
				if (ownerPid !== undefined && ownerPid !== this.ownerPid && this.inspector.startTime(ownerPid) !== undefined
					&& (meta.ownerStart === undefined || this.inspector.startTime(ownerPid) === meta.ownerStart)) continue;
				const processStart = typeof meta.processStart === "string" ? meta.processStart : undefined;
				const liveStart = pid === undefined ? undefined : this.inspector.startTime(pid);
				const liveCommand = pid === undefined ? undefined : this.inspector.commandLine(pid);
				const command = typeof meta.command === "string" ? meta.command : "";
				const sameProcess = liveStart !== undefined && (processStart === undefined || processStart === liveStart)
					&& (liveCommand === undefined || command === "" || liveCommand.includes(command.slice(0, 64)));
				if (!sameProcess || pid === undefined) {
					try { rmSync(metaPath, { force: true }); } catch { /* stale record */ }
					continue;
				}
				orphans.push({
					pid, command, startedAt: typeof meta.startedAt === "number" ? meta.startedAt : 0, processStart,
					sessionKey: typeof meta.sessionKey === "string" ? meta.sessionKey : session, jobId,
					logPath: typeof meta.logPath === "string" ? meta.logPath : join(dir, `${jobId}.log`), metaPath,
				});
			}
		}
		return orphans;
	}

	/** Explicit user action: terminate a previously reported orphan if it is still the same process. */
	killOrphan(orphan: OrphanRecord): boolean {
		const liveStart = this.inspector.startTime(orphan.pid);
		if (liveStart === undefined || (orphan.processStart !== undefined && orphan.processStart !== liveStart)) {
			try { rmSync(orphan.metaPath, { force: true }); } catch { /* already gone */ }
			return false;
		}
		const ok = signalGroup(orphan.pid, "SIGTERM");
		const timer = setTimeout(() => {
			if (this.inspector.startTime(orphan.pid) === liveStart) signalGroup(orphan.pid, "SIGKILL");
		}, this.killGraceMs);
		timer.unref?.();
		try { rmSync(orphan.metaPath, { force: true }); } catch { /* best effort */ }
		return ok;
	}

	private appendOutput(job: JobRecord, data: Buffer): void {
		// Output after shutdown/finish of a closed session is dropped.
		if (!this.jobs.has(job.id) || job.logFd === undefined) return;
		job.ring.append(data);
		try { writeSync(job.logFd, data); } catch { /* disk full: ring buffer still serves the model */ }
		this.emit({ type: "output", job: this.snapshot(job) });
	}

	private finish(job: JobRecord, status: BackgroundJobStatus, code: number | null, signal: NodeJS.Signals | string | null, error?: string): void {
		if (!isLive(job.status)) return;
		job.status = status;
		job.exitCode = code;
		job.signal = signal;
		job.endedAt = this.now();
		if (error) job.error = error;
		if (job.killTimer) clearTimeout(job.killTimer);
		if (job.runtimeTimer) clearTimeout(job.runtimeTimer);
		job.killTimer = job.runtimeTimer = undefined;
		try { rmSync(job.metaPath, { force: true }); } catch { /* best effort */ }
		// Let trailing pipe data flush before closing the log.
		setTimeout(() => this.closeLog(job), 200).unref?.();
		job.resolveSettled();
		if (this.jobs.has(job.id)) this.emit({ type: "status", job: this.snapshot(job) });
	}

	private closeLog(job: JobRecord): void {
		if (job.logFd === undefined) return;
		try { closeSync(job.logFd); } catch { /* already closed */ }
		job.logFd = undefined;
	}

	private writeMeta(job: JobRecord): void {
		if (job.pid === undefined) return;
		const meta = {
			jobId: job.id, sessionKey: job.sessionKey, pid: job.pid, command: job.command, cwd: job.cwd,
			startedAt: job.startedAt, processStart: this.inspector.startTime(job.pid),
			ownerPid: this.ownerPid, ownerStart: this.inspector.startTime(this.ownerPid), logPath: job.logPath,
		};
		try { writeFileSync(job.metaPath, JSON.stringify(meta)); } catch { /* orphan detection is best effort */ }
	}

	private pruneFinished(sessionKey: string): void {
		const finished = [...this.jobs.values()].filter((job) => job.sessionKey === sessionKey && !isLive(job.status));
		for (const job of finished.slice(0, Math.max(0, finished.length - this.retainFinished + 1))) {
			this.closeLog(job);
			this.jobs.delete(job.id);
		}
	}

	private snapshot(job: JobRecord): BackgroundJobSnapshot {
		return {
			id: job.id, sessionKey: job.sessionKey, command: job.command,
			...(job.description ? { description: job.description } : {}),
			cwd: job.cwd, ...(job.pid !== undefined ? { pid: job.pid } : {}), status: job.status,
			...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
			...(job.signal !== undefined ? { signal: job.signal } : {}),
			startedAt: job.startedAt, ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
			logPath: job.logPath, totalBytes: job.ring.end, ...(job.error ? { error: job.error } : {}),
		};
	}

	private emit(event: JobEvent): void {
		for (const listener of this.listeners) {
			try { listener(event); } catch { /* listener faults must not break job bookkeeping */ }
		}
	}
}

export function isLive(status: BackgroundJobStatus): boolean {
	return status === "starting" || status === "running";
}
