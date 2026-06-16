import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { ANSI_RESET } from "../../theme.js";
import {
	DISABLE_BRACKETED_PASTE,
	DISABLE_TERMINAL_KEY_REPORTING,
	DISABLE_TERMINAL_WRAP,
	CLEAR_TERMINAL,
	ENABLE_BRACKETED_PASTE,
	ENABLE_TERMINAL_MODIFY_OTHER_KEYS,
	ENABLE_TERMINAL_KEY_REPORTING,
	ENABLE_TERMINAL_WRAP,
	HIDE_CURSOR,
	RESET_TERMINAL_VIEWPORT_STATE,
	RUNTIME_DISPOSE_GRACE_MS,
	SHOW_CURSOR,
} from "../constants.js";

export type AppTerminalControllerHost = {
	isRunning(): boolean;
	setRunning(running: boolean): void;
	runtime(): AgentSessionRuntime | undefined;
	saveInputStateForQuit(): Promise<void>;
	disposeInactiveRuntimesForQuit(): Promise<void>;
	render(): void;
	handleInputChunk(chunk: Buffer): void;
	closeSdkMenuForStop(): void;
	clearToastTimers(): void;
	stopBlinking(): void;
	stopSubagentsPolling(): void;
	stopModelUsagePolling(): void;
	stopVoiceInput(): Promise<void>;
	stopAutocomplete(): void;
	stopShellCommand(): void;
	unsubscribeSession(): void;
	clearExtensionWidgets(): void;
	resetRenderOutputBuffer(): void;
};

export class AppTerminalController {
	private terminalEnabled = false;
	private interactiveSuspended = false;
	private stopPromise: Promise<void> | undefined;
	private keyboardProtocolNegotiationBuffer = "";
	private keyboardProtocolBufferFlushTimer: ReturnType<typeof setTimeout> | undefined;
	private kittyProtocolActive = false;
	private modifyOtherKeysActive = false;

	private readonly enterInteractiveSequence = `${ANSI_RESET}${RESET_TERMINAL_VIEWPORT_STATE}${CLEAR_TERMINAL}\x1b[?1049h${RESET_TERMINAL_VIEWPORT_STATE}${CLEAR_TERMINAL}${ENABLE_TERMINAL_KEY_REPORTING}${ENABLE_BRACKETED_PASTE}${DISABLE_TERMINAL_WRAP}\x1b[?1002h\x1b[?1006h${HIDE_CURSOR}`;
	private readonly exitInteractiveSequence = `${ANSI_RESET}${RESET_TERMINAL_VIEWPORT_STATE}${DISABLE_TERMINAL_KEY_REPORTING}${DISABLE_BRACKETED_PASTE}${ENABLE_TERMINAL_WRAP}\x1b[?1006l\x1b[?1002l\x1b[?1049l${SHOW_CURSOR}`;

	constructor(private readonly host: AppTerminalControllerHost) {}

	isSuspended(): boolean {
		return this.interactiveSuspended;
	}

	enableTerminal(): void {
		if (this.terminalEnabled) return;

		this.terminalEnabled = true;
		this.beginKeyboardProtocolNegotiation();
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", this.onInputData);
		process.stdout.on("resize", this.onResize);
		process.stdout.write(this.enterInteractiveSequence);
		process.on("exit", this.restoreTerminal);
	}

	async stop(): Promise<void> {
		if (this.stopPromise) {
			await this.stopPromise;
			return;
		}

		this.stopPromise = this.stopInternal();
		await this.stopPromise;
	}

	async disposeRuntimeForQuit(runtime: AgentSessionRuntime): Promise<void> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const dispose = runtime.dispose().then(
			() => "disposed" as const,
			() => "failed" as const,
		);
		const timeoutPromise = new Promise<"timeout">((resolveTimeout) => {
			timeout = setTimeout(() => resolveTimeout("timeout"), RUNTIME_DISPOSE_GRACE_MS);
		});

		const result = await Promise.race([dispose, timeoutPromise]);
		if (timeout) clearTimeout(timeout);
		if (result !== "disposed") runtime.session.dispose();
	}

	async disposeRuntime(runtime: AgentSessionRuntime): Promise<void> {
		try {
			await runtime.dispose();
		} catch {
			// Best-effort tab cleanup: extension shutdown errors are surfaced through
			// the SDK onError path, and tab switching should not produce unhandled
			// promise rejections if a disposed runtime is already half-torn down.
		}
	}

	async runWithInteractiveTerminal<T>(callback: () => Promise<T>): Promise<T> {
		this.suspendForInteractiveProcess();
		try {
			return await callback();
		} finally {
			this.resumeAfterInteractiveProcess();
		}
	}

	private readonly restoreTerminal = (): void => {
		if (!this.terminalEnabled) return;

		this.clearKeyboardProtocolNegotiationBuffer();
		this.terminalEnabled = false;
		this.interactiveSuspended = false;
		process.stdout.write(this.exitInteractiveSequence);
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
	};

	private suspendForInteractiveProcess(): void {
		if (!this.terminalEnabled || this.interactiveSuspended) return;
		this.interactiveSuspended = true;
		process.stdin.off("data", this.onInputData);
		process.stdin.pause();
		process.stdout.off("resize", this.onResize);
		process.stdout.write(this.exitInteractiveSequence);
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
	}

	private resumeAfterInteractiveProcess(): void {
		if (!this.terminalEnabled || !this.interactiveSuspended) return;
		this.interactiveSuspended = false;
		this.beginKeyboardProtocolNegotiation();
		if (process.stdin.isTTY) process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", this.onInputData);
		process.stdout.on("resize", this.onResize);
		this.host.resetRenderOutputBuffer();
		process.stdout.write(this.enterInteractiveSequence);
		this.host.render();
	}

	private async stopInternal(): Promise<void> {
		if (!this.host.isRunning()) return;
		this.clearKeyboardProtocolNegotiationBuffer();
		this.host.setRunning(false);
		this.host.closeSdkMenuForStop();
		this.host.clearToastTimers();
		this.host.stopBlinking();
		this.host.stopSubagentsPolling();
		this.host.stopModelUsagePolling();
		await this.host.stopVoiceInput();
		this.host.stopAutocomplete();
		this.host.stopShellCommand();
		process.stdin.off("data", this.onInputData);
		process.stdin.pause();
		process.stdout.off("resize", this.onResize);
		process.off("exit", this.restoreTerminal);
		this.host.unsubscribeSession();
		this.host.clearExtensionWidgets();
		await this.host.saveInputStateForQuit();
		this.restoreTerminal();
		this.scheduleForcedProcessExit();
		await this.host.disposeInactiveRuntimesForQuit();
		const runtime = this.host.runtime();
		if (runtime) await this.disposeRuntimeForQuit(runtime);
	}

	private scheduleForcedProcessExit(): void {
		const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
		const timer = setTimeout(() => {
			process.exit(exitCode);
		}, RUNTIME_DISPOSE_GRACE_MS);
		timer.unref();
	}

	private readonly onResize = (): void => {
		this.host.resetRenderOutputBuffer();
		this.host.render();
	};

	private readonly onInputData = (chunk: Buffer): void => {
		const input = this.filterKeyboardProtocolNegotiationInput(chunk.toString("utf8"));
		if (input) this.host.handleInputChunk(Buffer.from(input, "utf8"));
	};

	private beginKeyboardProtocolNegotiation(): void {
		this.clearKeyboardProtocolNegotiationBuffer();
		this.kittyProtocolActive = false;
		this.modifyOtherKeysActive = false;
	}

	private filterKeyboardProtocolNegotiationInput(data: string): string {
		let input = this.keyboardProtocolNegotiationBuffer + data;
		this.clearKeyboardProtocolNegotiationBuffer();

		let output = "";
		while (input.length > 0) {
			const response = readKeyboardProtocolNegotiationResponse(input);
			if (response.kind === "complete") {
				this.handleKeyboardProtocolNegotiationResponse(response.response);
				input = input.slice(response.length);
				continue;
			}

			if (response.kind === "pending") {
				this.setKeyboardProtocolNegotiationBuffer(input);
				break;
			}

			output += input[0];
			input = input.slice(1);
		}

		return output;
	}

	private handleKeyboardProtocolNegotiationResponse(response: KeyboardProtocolNegotiationResponse): void {
		if (response.type === "kitty-flags") {
			if (response.flags !== 0) {
				this.kittyProtocolActive = true;
				this.modifyOtherKeysActive = false;
			} else {
				this.enableModifyOtherKeysFallback();
			}
			return;
		}

		if (!this.kittyProtocolActive) this.enableModifyOtherKeysFallback();
	}

	private enableModifyOtherKeysFallback(): void {
		if (this.kittyProtocolActive || this.modifyOtherKeysActive) return;
		process.stdout.write(ENABLE_TERMINAL_MODIFY_OTHER_KEYS);
		this.modifyOtherKeysActive = true;
	}

	private setKeyboardProtocolNegotiationBuffer(data: string): void {
		this.clearKeyboardProtocolNegotiationBuffer();
		this.keyboardProtocolNegotiationBuffer = data;
		this.keyboardProtocolBufferFlushTimer = setTimeout(() => {
			this.keyboardProtocolBufferFlushTimer = undefined;
			const buffered = this.keyboardProtocolNegotiationBuffer;
			this.keyboardProtocolNegotiationBuffer = "";
			if (buffered) this.host.handleInputChunk(Buffer.from(buffered, "utf8"));
		}, 150);
	}

	private clearKeyboardProtocolNegotiationBuffer(): void {
		if (this.keyboardProtocolBufferFlushTimer) clearTimeout(this.keyboardProtocolBufferFlushTimer);
		this.keyboardProtocolBufferFlushTimer = undefined;
		this.keyboardProtocolNegotiationBuffer = "";
	}
}

type KeyboardProtocolNegotiationResponse =
	| { readonly type: "kitty-flags"; readonly flags: number }
	| { readonly type: "device-attributes" };

type KeyboardProtocolNegotiationReadResult =
	| { readonly kind: "complete"; readonly response: KeyboardProtocolNegotiationResponse; readonly length: number }
	| { readonly kind: "pending" }
	| { readonly kind: "none" };

function readKeyboardProtocolNegotiationResponse(input: string): KeyboardProtocolNegotiationReadResult {
	const kittyFlags = /^\x1b\[\?(\d+)u/.exec(input);
	if (kittyFlags) {
		return {
			kind: "complete",
			response: { type: "kitty-flags", flags: Number.parseInt(kittyFlags[1] ?? "0", 10) },
			length: kittyFlags[0].length,
		};
	}

	const deviceAttributes = /^\x1b\[\?[\d;]*c/.exec(input);
	if (deviceAttributes) {
		return { kind: "complete", response: { type: "device-attributes" }, length: deviceAttributes[0].length };
	}

	if (input === "\x1b[" || /^\x1b\[\?[\d;]*$/.test(input)) return { kind: "pending" };
	return { kind: "none" };
}
