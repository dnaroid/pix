export const DISABLE_TERMINAL_OUTPUT_BUFFER_ENV = "PIX_DISABLE_TERMINAL_OUTPUT_BUFFER";
export const TERMINAL_OUTPUT_BUFFER_ENV = "PIX_TERMINAL_OUTPUT_BUFFER";

const ANSI_RESET = "\x1b[0m";
const CLEAR_LINE_PREFIX = (row: number) => `\x1b[${row};1H${ANSI_RESET}\x1b[2K`;

export type TerminalOutputFrameRow = { row: number; output: string };
export type TerminalOutputFrame = readonly TerminalOutputFrameRow[];

export type TerminalOutputRegion = "statusLine";

export type TerminalOutputBufferOptions = {
	enabled?: boolean;
	env?: Record<string, string | undefined>;
};

export class TerminalOutputBuffer {
	private readonly enabled: boolean;
	private readonly previousByRow = new Map<number, string>();
	private previousStatusLine: string | undefined;

	constructor(options: TerminalOutputBufferOptions = {}) {
		this.enabled = options.enabled ?? !terminalOutputBufferDisabled(options.env ?? process.env);
	}

	diffFrame(frame: TerminalOutputFrame): string {
		if (!this.enabled) return frame.map((entry) => entry.output).join("");

		const chunks: string[] = [];
		const seenRows = new Set<number>();

		for (const { row, output } of frame) {
			seenRows.add(row);
			if (this.previousByRow.get(row) === output) continue;
			this.previousByRow.set(row, output);
			if (output.length > 0) chunks.push(output);
		}

		for (const row of this.previousByRow.keys()) {
			if (seenRows.has(row)) continue;
			this.previousByRow.delete(row);
			chunks.push(CLEAR_LINE_PREFIX(row));
		}

		return chunks.join("");
	}

	diff(region: TerminalOutputRegion, output: string): string {
		if (!this.enabled) return output;
		if (region === "statusLine") {
			if (this.previousStatusLine === output) return "";
			this.previousStatusLine = output;
			return output;
		}
		return output;
	}

	reset(): void {
		this.previousByRow.clear();
		this.previousStatusLine = undefined;
	}
}

export function terminalOutputBufferDisabled(env: Record<string, string | undefined> = process.env): boolean {
	const disabled = env[DISABLE_TERMINAL_OUTPUT_BUFFER_ENV];
	if (disabled !== undefined) return !isFalseEnvValue(disabled);

	const enabled = env[TERMINAL_OUTPUT_BUFFER_ENV];
	if (enabled !== undefined) return isFalseEnvValue(enabled);

	return false;
}

function isFalseEnvValue(value: string): boolean {
	return /^(?:0|false|off|no)$/iu.test(value.trim());
}
