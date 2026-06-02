export const DISABLE_TERMINAL_OUTPUT_BUFFER_ENV = "PIX_DISABLE_TERMINAL_OUTPUT_BUFFER";
export const TERMINAL_OUTPUT_BUFFER_ENV = "PIX_TERMINAL_OUTPUT_BUFFER";

const FRAME_REGIONS = ["tabs", "conversation", "inputStatus"] as const;

export type TerminalOutputFrameRegion = typeof FRAME_REGIONS[number];
export type TerminalOutputRegion = TerminalOutputFrameRegion | "statusLine";
export type TerminalOutputFrame = Partial<Record<TerminalOutputFrameRegion, string>>;

export type TerminalOutputBufferOptions = {
	enabled?: boolean;
	env?: Record<string, string | undefined>;
};

export class TerminalOutputBuffer {
	private readonly enabled: boolean;
	private readonly previousByRegion = new Map<TerminalOutputRegion, string>();

	constructor(options: TerminalOutputBufferOptions = {}) {
		this.enabled = options.enabled ?? !terminalOutputBufferDisabled(options.env ?? process.env);
	}

	diffFrame(frame: TerminalOutputFrame): string {
		const outputByRegion: Record<TerminalOutputFrameRegion, string> = {
			tabs: frame.tabs ?? "",
			conversation: frame.conversation ?? "",
			inputStatus: frame.inputStatus ?? "",
		};

		if (!this.enabled) return FRAME_REGIONS.map((region) => outputByRegion[region]).join("");

		const chunks: string[] = [];
		for (const region of FRAME_REGIONS) {
			const output = outputByRegion[region];
			if (this.previousByRegion.get(region) === output) continue;
			this.previousByRegion.set(region, output);
			if (output.length > 0) chunks.push(output);
		}

		return chunks.join("");
	}

	diff(region: TerminalOutputRegion, output: string): string {
		if (!this.enabled) return output;
		if (this.previousByRegion.get(region) === output) return "";
		this.previousByRegion.set(region, output);
		return output;
	}

	reset(): void {
		this.previousByRegion.clear();
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
