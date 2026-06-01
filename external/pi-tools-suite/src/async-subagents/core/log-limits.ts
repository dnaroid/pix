import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_EVENTS_LOG_MAX_BYTES = 0;
export const DEFAULT_DEBUG_EVENTS_LOG_MAX_BYTES = 32 * 1024 * 1024;
export const DEFAULT_STDERR_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const DEFAULT_RPC_EVENT_LINE_MAX_CHARS = 8 * 1024 * 1024;

export interface SubagentLogLimits {
	eventsMaxBytes: number;
	stderrMaxBytes: number;
	rpcEventLineMaxChars: number;
	debugLogs: boolean;
}

export interface BoundedFileWriter {
	readonly bytesWritten: number;
	readonly truncated: boolean;
	write(chunk: string | Buffer): void;
	end(): void;
}

export interface DeferredFileWriter extends BoundedFileWriter {
	flush(): void;
	discard(): void;
}

export function resolveSubagentLogLimits(env: NodeJS.ProcessEnv = process.env): SubagentLogLimits {
	const debugLogs = isTruthyEnv(env.ASYNC_SUBAGENTS_DEBUG_LOGS) || isTruthyEnv(env.PI_SUBAGENTS_DEBUG_LOGS);
	return {
		eventsMaxBytes: envLimit(env, ["ASYNC_SUBAGENTS_MAX_EVENTS_BYTES", "PI_SUBAGENTS_MAX_EVENTS_BYTES"], debugLogs ? DEFAULT_DEBUG_EVENTS_LOG_MAX_BYTES : DEFAULT_EVENTS_LOG_MAX_BYTES),
		stderrMaxBytes: envLimit(env, ["ASYNC_SUBAGENTS_MAX_STDERR_BYTES", "PI_SUBAGENTS_MAX_STDERR_BYTES"], DEFAULT_STDERR_LOG_MAX_BYTES),
		rpcEventLineMaxChars: envLimit(env, ["ASYNC_SUBAGENTS_MAX_RPC_LINE_CHARS", "PI_SUBAGENTS_MAX_RPC_LINE_CHARS"], DEFAULT_RPC_EVENT_LINE_MAX_CHARS),
		debugLogs,
	};
}

export function createBoundedFileWriter(filePath: string, maxBytes: number, label: string): BoundedFileWriter {
	const limit = Math.max(0, Math.floor(maxBytes));
	let fd: number | undefined;
	let written = 0;
	let truncated = false;
	let closed = false;

	function open(): number {
		if (fd === undefined) fd = fs.openSync(filePath, "w");
		return fd;
	}

	function writeWithinLimit(buffer: Buffer): void {
		if (closed || buffer.length === 0 || written >= limit) return;
		const slice = buffer.subarray(0, Math.min(buffer.length, limit - written));
		written += slice.length;
		fs.writeSync(open(), slice);
	}

	return {
		get bytesWritten() {
			return written;
		},
		get truncated() {
			return truncated;
		},
		write(chunk: string | Buffer): void {
			if (closed) return;
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
			if (limit === 0) {
				if (!truncated) truncated = true;
				return;
			}
			if (written + buffer.length <= limit) {
				written += buffer.length;
				fs.writeSync(open(), buffer);
				return;
			}
			if (!truncated) {
				const marker = Buffer.from(`\n[${label} truncated after ${written} bytes; dropped additional output starting with ${buffer.length} bytes]\n`, "utf8");
				const availableForChunk = Math.max(0, limit - written - marker.length);
				if (availableForChunk > 0) writeWithinLimit(buffer.subarray(0, availableForChunk));
				truncated = true;
				writeWithinLimit(marker);
			}
		},
		end(): void {
			if (closed) return;
			closed = true;
			if (fd !== undefined) fs.closeSync(fd);
		},
	};
}

export function createDeferredFileWriter(filePath: string, maxBytes: number, label: string): DeferredFileWriter {
	const limit = Math.max(0, Math.floor(maxBytes));
	const chunks: Buffer[] = [];
	let written = 0;
	let truncated = false;
	let closed = false;

	function appendWithinLimit(buffer: Buffer): void {
		if (closed || buffer.length === 0 || written >= limit) return;
		const slice = buffer.subarray(0, Math.min(buffer.length, limit - written));
		written += slice.length;
		chunks.push(Buffer.from(slice));
	}

	function write(chunk: string | Buffer): void {
		if (closed) return;
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
		if (limit === 0) {
			if (!truncated) truncated = true;
			return;
		}
		if (written + buffer.length <= limit) {
			written += buffer.length;
			chunks.push(Buffer.from(buffer));
			return;
		}
		if (!truncated) {
			const marker = Buffer.from(`\n[${label} truncated after ${written} bytes; dropped additional output starting with ${buffer.length} bytes]\n`, "utf8");
			const availableForChunk = Math.max(0, limit - written - marker.length);
			if (availableForChunk > 0) appendWithinLimit(buffer.subarray(0, availableForChunk));
			truncated = true;
			appendWithinLimit(marker);
		}
	}

	function discard(): void {
		if (closed) return;
		closed = true;
	}

	return {
		get bytesWritten() {
			return written;
		},
		get truncated() {
			return truncated;
		},
		write,
		flush(): void {
			if (closed) return;
			closed = true;
			if (chunks.length === 0) return;
			if (!fs.existsSync(path.dirname(filePath))) return;
			fs.writeFileSync(filePath, Buffer.concat(chunks));
		},
		discard,
		end(): void {
			discard();
		},
	};
}

function envLimit(env: NodeJS.ProcessEnv, keys: readonly string[], fallback: number): number {
	for (const key of keys) {
		const value = env[key]?.trim();
		if (!value) continue;
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed >= 0) return parsed;
	}
	return fallback;
}

function isTruthyEnv(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "yes";
}
