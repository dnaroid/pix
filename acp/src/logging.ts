/**
 * Stderr-only logging for the ACP adapter.
 *
 * stdout is reserved for the ACP JSON-RPC protocol stream; any stray write
 * there corrupts the protocol. Everything must go to stderr.
 */

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

export interface Logger {
	debug(message: string): void;
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export function createLogger(level: LogLevel = "info", sink: (line: string) => void = stderrLine): Logger {
	const threshold = LEVEL_ORDER[level];
	const log = (level: LogLevel, message: string): void => {
		if (LEVEL_ORDER[level] < threshold) return;
		const timestamp = new Date().toISOString();
		sink(`[${timestamp}] [pix-acp] [${level}] ${message}`);
	};
	return {
		debug: (message) => log("debug", message),
		info: (message) => log("info", message),
		warn: (message) => log("warn", message),
		error: (message) => log("error", message),
	};
}

function stderrLine(line: string): void {
	process.stderr.write(`${line}\n`);
}
