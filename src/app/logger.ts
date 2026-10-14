import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { sanitizeLogValue } from "./logging/privacy.js";

export type PixLogLevel = "debug" | "info" | "warn" | "error";
export type PixLogDetails = Record<string, unknown>;
export type PixLogContext = { project?: string | null; sessionId?: string; module?: string };
export const PIX_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const PIX_LOG_RETENTION_MS = 24 * 60 * 60 * 1000;
const levels: PixLogLevel[] = ["debug", "info", "warn", "error"];
const context = new AsyncLocalStorage<PixLogContext>();
const segmentPattern = /^pix-v1-(\d+)-(?:backend|acp|desktop)-[\w-]+\.jsonl$/;

export function withPixLogContext<T>(value: PixLogContext, operation: () => T): T {
	return context.run(value, operation);
}

export function getPixLogPath(homeDir = homedir()): string {
	return join(homeDir, ".config", "pi", "logs");
}

export type PixFileLoggerOptions = {
	directory?: string;
	source?: "backend" | "acp" | "desktop";
	module?: string;
	level?: PixLogLevel;
	maxBytes?: number;
	maxQueuedBytes?: number;
	now?: () => number;
};

/** One private segment stream per writer: no shared rename/truncate races. */
export class PixFileLogger {
	readonly directory: string;
	private readonly source;
	private readonly module;
	private readonly level;
	private readonly maxBytes;
	private readonly maxQueuedBytes;
	private readonly now;
	private readonly writer = `${process.pid}-${randomUUID()}`;
	private pending = Promise.resolve();
	private queuedBytes = 0;
	private segment: { path: string; started: number; bytes: number } | undefined;
	private cleanupAt = -Infinity;
	private sequence = 0;
	private warned = false;
	private maintaining = false;
	dropped = 0;

	constructor(options: PixFileLoggerOptions = {}) {
		this.directory = options.directory ?? getPixLogPath();
		this.source = options.source ?? "backend";
		this.module = options.module ?? "app";
		this.level = options.level ?? (process.env.PIX_LOG_LEVEL === "debug" ? "debug" : "info");
		this.maxBytes = Math.max(512, options.maxBytes ?? PIX_LOG_MAX_BYTES);
		this.maxQueuedBytes = options.maxQueuedBytes ?? 1024 * 1024;
		this.now = options.now ?? Date.now;
	}

	log(level: PixLogLevel, event: string, details: PixLogDetails = {}, explicit?: PixLogContext): Promise<void> {
		if (levels.indexOf(level) < levels.indexOf(this.level)) return Promise.resolve();
		const scope = { ...context.getStore(), ...explicit };
		const path = scope?.project;
		const record = sanitizeLogValue({
			v: 1, time: new Date(this.now()).toISOString(), level, source: this.source,
			module: scope?.module ?? this.module, pid: process.pid,
			project: path && isAbsolute(path) ? { name: basename(path), path } : null,
			sessionId: scope?.sessionId, event, details, ...(this.dropped ? { dropped: this.dropped } : {}),
		});
		let line = JSON.stringify(record) + "\n";
		if (Buffer.byteLength(line) > Math.min(this.maxBytes, 32 * 1024)) {
			const metadata = record as Record<string, unknown>;
			line = JSON.stringify({ ...metadata, details: { truncated: true } }) + "\n";
		}
		const bytes = Buffer.byteLength(line);
		if (bytes > Math.min(this.maxBytes, 32 * 1024) || this.queuedBytes + bytes > this.maxQueuedBytes) { this.dropped++; return this.pending; }
		this.queuedBytes += bytes;
		this.pending = this.pending.then(() => this.write(line, bytes)).catch(() => {
			this.segment = undefined;
			this.dropped++;
			if (!this.warned) { this.warned = true; process.stderr.write("[pix-log] log storage unavailable\n"); }
		}).finally(() => { this.queuedBytes -= bytes; });
		return this.pending;
	}

	debug(event: string, details?: PixLogDetails): Promise<void> { return this.log("debug", event, details); }
	info(event: string, details?: PixLogDetails): Promise<void> { return this.log("info", event, details); }
	warn(event: string, details?: PixLogDetails): Promise<void> { return this.log("warn", event, details); }
	error(event: string, details?: PixLogDetails): Promise<void> { return this.log("error", event, details); }
	async flush(): Promise<void> { await this.pending; }

	/** Only on fatal teardown: Node will not wait for asynchronous writes here. */
	emergency(error: Error, fallback: PixLogContext): void {
		try {
			const scope = { ...fallback, ...context.getStore() };
			const project = scope.project && isAbsolute(scope.project)
				? { name: basename(scope.project), path: scope.project } : null;
			const value = sanitizeLogValue({ v: 1, time: new Date(this.now()).toISOString(), level: "error",
				source: this.source, module: scope.module ?? this.module, pid: process.pid, project,
				sessionId: scope.sessionId, event: "process:uncaught", details: { error } });
			mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			writeFileSync(join(this.directory, `pix-v1-${this.now()}-${this.source}-${this.writer}-fatal-${this.sequence++}.jsonl`),
				JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
		} catch { /* Never replace the original fatal exception. */ }
	}

	/** Called on writes and by the host's unref'ed maintenance timer. */
	maintain(): Promise<void> {
		if (this.maintaining) return this.pending;
		this.maintaining = true;
		this.pending = this.pending.then(() => this.cleanup()).catch(() => undefined).finally(() => { this.maintaining = false; });
		return this.pending;
	}

	private async cleanup(): Promise<void> {
		const now = this.now();
		if (now < this.cleanupAt) return;
		this.cleanupAt = now + 60_000;
		for (const entry of await readdir(this.directory, { withFileTypes: true }).catch(() => [])) {
			const match = segmentPattern.exec(entry.name);
			if (entry.isFile() && match && Number(match[1]) <= now - PIX_LOG_RETENTION_MS) {
				await unlink(join(this.directory, entry.name)).catch(() => undefined);
			}
		}
	}

	private async write(line: string, bytes: number): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await this.cleanup();
		const now = this.now();
		if (!this.segment || this.segment.bytes + bytes > this.maxBytes || now - this.segment.started >= 3_600_000 || now < this.segment.started) {
			const path = join(this.directory, `pix-v1-${now}-${this.source}-${this.writer}-${this.sequence++}.jsonl`);
			const file = await open(path, "wx", 0o600);
			await file.close();
			this.segment = { path, started: now, bytes: 0 };
		}
		const file = await open(this.segment.path, "a", 0o600);
		try { await file.writeFile(line, "utf8"); this.segment.bytes += bytes; }
		finally { await file.close(); }
	}
}

export const pixLogger = new PixFileLogger();
export function logPixEvent(level: PixLogLevel, event: string, details?: PixLogDetails, scope?: PixLogContext): void {
	void pixLogger.log(level, event, details, scope);
}

// In-process optional bridge for separately installed pi-tools-suite copies.
// No extension or standalone Pi process has to import Pix's implementation.
const PIX_DIAGNOSTIC_SINK = Symbol.for("pix.diagnostics.sink");
type DiagnosticSink = (level: PixLogLevel, event: string, details: PixLogDetails, scope: PixLogContext) => void;

/** Entrypoints only; importing the logger does not install global handlers. */
export function installPixProcessLogging(scope: PixLogContext = {}, logger = pixLogger): () => void {
	const registry = globalThis as typeof globalThis & { [PIX_DIAGNOSTIC_SINK]?: DiagnosticSink };
	const previous = registry[PIX_DIAGNOSTIC_SINK];
	const sink: DiagnosticSink = (level, event, details, explicit) => { void logger.log(level, event, details, explicit); };
	registry[PIX_DIAGNOSTIC_SINK] = sink;
	const fatal = (error: Error): void => logger.emergency(error, scope);
	process.on("uncaughtExceptionMonitor", fatal);
	const timer = setInterval(() => { void logger.maintain(); }, 60_000);
	timer.unref();
	return () => {
		clearInterval(timer);
		process.off("uncaughtExceptionMonitor", fatal);
		if (registry[PIX_DIAGNOSTIC_SINK] === sink) {
			if (previous) registry[PIX_DIAGNOSTIC_SINK] = previous;
			else delete registry[PIX_DIAGNOSTIC_SINK];
		}
	};
}
