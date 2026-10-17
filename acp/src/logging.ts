/**
 * Persistent JSONL diagnostics plus stderr for the ACP adapter.
 *
 * stdout is reserved for the ACP JSON-RPC protocol stream; any stray write
 * there corrupts the protocol. Everything must go to stderr.
 */

import { PixFileLogger, withPixLogContext, type PixLogContext } from "../../dist/app/logger.js";
import { redactLogText } from "../../dist/app/logging/privacy.js";
export { withPixLogContext };
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

const LEVELS = new Set(Object.keys(LEVEL_ORDER) as LogLevel[]);

export function parseLogLevel(value: string | undefined): LogLevel {
	if (value && LEVELS.has(value as LogLevel)) return value as LogLevel;
	return "info";
}

// Declared after LEVELS: parseLogLevel reads it during module evaluation.
export const acpFileLogger = new PixFileLogger({ source: "acp", module: "adapter", level: parseLogLevel(process.env.PIX_LOG_LEVEL ?? process.env.PIX_ACP_LOG) });

export interface Logger {
	debug(message: string, context?: PixLogContext): void;
	info(message: string, context?: PixLogContext): void;
	warn(message: string, context?: PixLogContext): void;
	error(message: string, context?: PixLogContext): void;
}

export function createLogger(level: LogLevel = "info", sink: (line: string) => void = stderrLine, fileLogger: Pick<PixFileLogger, "log"> = acpFileLogger): Logger {
	const threshold = LEVEL_ORDER[level];
	const log = (level: LogLevel, message: string, context?: PixLogContext): void => {
		if (LEVEL_ORDER[level] < threshold) return;
		const timestamp = new Date().toISOString();
		const safe = redactLogText(message);
		void fileLogger.log(level, "adapter:diagnostic", { diagnostic: safe }, context);
		sink(`[${timestamp}] [pix-acp] [${level}] ${safe}`);
	};
	return {
		debug: (message, context) => log("debug", message, context),
		info: (message, context) => log("info", message, context),
		warn: (message, context) => log("warn", message, context),
		error: (message, context) => log("error", message, context),
	};
}

let stderrClosed = false;
let stderrGuarded = false;

/** True for errors meaning the stderr reader is gone (host closed the pipe). */
export function isClosedPipeError(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END";
}

/**
 * Diagnostics must never change process behavior: once the host closes the
 * stderr pipe (e.g. during Desktop shutdown), drop stderr mirroring instead of
 * surfacing an uncaught EPIPE. The persistent JSONL file log is unaffected.
 */
export function writeDiagnosticLine(stream: NodeJS.WritableStream & { destroyed?: boolean; writable?: boolean }, line: string, onClosed: () => void): void {
	if (stream.destroyed || stream.writable === false) {
		onClosed();
		return;
	}
	try {
		stream.write(`${line}\n`);
	} catch (error) {
		if (!isClosedPipeError(error)) throw error;
		onClosed();
	}
}

function stderrLine(line: string): void {
	if (stderrClosed) return;
	if (!stderrGuarded) {
		stderrGuarded = true;
		process.stderr.on("error", (error) => {
			if (isClosedPipeError(error)) {
				stderrClosed = true;
				return;
			}
			// Preserve default behavior for unexpected stream errors.
			throw error;
		});
	}
	writeDiagnosticLine(process.stderr, line, () => { stderrClosed = true; });
}
