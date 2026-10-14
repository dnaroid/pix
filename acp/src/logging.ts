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
export const acpFileLogger = new PixFileLogger({ source: "acp", module: "adapter", level: parseLogLevel(process.env.PIX_LOG_LEVEL ?? process.env.PIX_ACP_LOG) });

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

function stderrLine(line: string): void {
	process.stderr.write(`${line}\n`);
}
