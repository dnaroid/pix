import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const PIX_LOG_MAX_LINES = 1000;

export type PixLogLevel = "debug" | "info" | "warn" | "error";
export type PixLogDetails = Record<string, unknown>;

export type PixFileLoggerOptions = {
	logPath?: string;
	maxLines?: number;
};

export function getPixLogPath(homeDir = homedir()): string {
	return join(homeDir, ".config", "pi", "pix.log");
}

export class PixFileLogger {
	readonly logPath: string;
	private readonly maxLines: number;
	private pending = Promise.resolve();

	constructor(options: PixFileLoggerOptions = {}) {
		this.logPath = options.logPath ?? getPixLogPath();
		this.maxLines = Math.max(1, Math.floor(options.maxLines ?? PIX_LOG_MAX_LINES));
	}

	log(level: PixLogLevel, event: string, details: PixLogDetails = {}): Promise<void> {
		const line = this.formatLine(level, event, details);
		this.pending = this.pending
			.then(() => this.writeLine(line))
			.catch(() => undefined);
		return this.pending;
	}

	debug(event: string, details?: PixLogDetails): Promise<void> {
		return this.log("debug", event, details);
	}

	info(event: string, details?: PixLogDetails): Promise<void> {
		return this.log("info", event, details);
	}

	warn(event: string, details?: PixLogDetails): Promise<void> {
		return this.log("warn", event, details);
	}

	error(event: string, details?: PixLogDetails): Promise<void> {
		return this.log("error", event, details);
	}

	async flush(): Promise<void> {
		await this.pending;
	}

	private formatLine(level: PixLogLevel, event: string, details: PixLogDetails): string {
		return `${new Date().toISOString()} ${level.toUpperCase()} ${sanitizeToken(event)} ${safeJson(details)}\n`;
	}

	private async writeLine(line: string): Promise<void> {
		await mkdir(dirname(this.logPath), { recursive: true });
		await appendFile(this.logPath, line, "utf8");
		await trimLogFile(this.logPath, this.maxLines);
	}
}

export const pixLogger = new PixFileLogger();

export function logPixEvent(level: PixLogLevel, event: string, details?: PixLogDetails): void {
	void pixLogger.log(level, event, details);
}

export async function trimLogFile(logPath: string, maxLines = PIX_LOG_MAX_LINES): Promise<void> {
	const text = await readFile(logPath, "utf8").catch((error: unknown) => {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	});
	if (text === undefined) return;

	const lines = text.split(/\r?\n/u);
	if (lines.at(-1) === "") lines.pop();
	if (lines.length <= maxLines) return;

	await writeFile(logPath, `${lines.slice(-maxLines).join("\n")}\n`, "utf8");
}

function sanitizeToken(value: string): string {
	return value
		.replace(/[\t\r\n]+/gu, " ")
		.replace(/\s+/gu, "_")
		.replace(/[^\w:.-]+/gu, "_")
		.replace(/^_+|_+$/gu, "")
		.slice(0, 120) || "event";
}

function safeJson(value: PixLogDetails): string {
	try {
		return JSON.stringify(value, (_key, item: unknown) => {
			if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
			if (typeof item === "bigint") return item.toString();
			return item;
		});
	} catch (error) {
		return JSON.stringify({ logSerializationError: error instanceof Error ? error.message : String(error) });
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
