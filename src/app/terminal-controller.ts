import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { ANSI_RESET } from "../theme.js";
import {
	DISABLE_BRACKETED_PASTE,
	DISABLE_TERMINAL_KEY_REPORTING,
	DISABLE_TERMINAL_WRAP,
	CLEAR_TERMINAL,
	ENABLE_BRACKETED_PASTE,
	ENABLE_TERMINAL_KEY_REPORTING,
	ENABLE_TERMINAL_WRAP,
	HIDE_CURSOR,
	RUNTIME_DISPOSE_GRACE_MS,
	SHOW_CURSOR,
} from "./constants.js";

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
	stopShellCommand(): void;
	unsubscribeSession(): void;
	clearExtensionWidgets(): void;
	resetRenderOutputBuffer(): void;
};

export class AppTerminalController {
	private terminalEnabled = false;
	private interactiveSuspended = false;
	private stopPromise: Promise<void> | undefined;

	constructor(private readonly host: AppTerminalControllerHost) {}

	isSuspended(): boolean {
		return this.interactiveSuspended;
	}

	enableTerminal(): void {
		if (this.terminalEnabled) return;

		this.terminalEnabled = true;
		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", this.onInputData);
		process.stdout.on("resize", this.onResize);
		process.stdout.write(`${ANSI_RESET}${CLEAR_TERMINAL}\x1b[?1049h${CLEAR_TERMINAL}${ENABLE_TERMINAL_KEY_REPORTING}${ENABLE_BRACKETED_PASTE}${DISABLE_TERMINAL_WRAP}\x1b[?1002h\x1b[?1006h${HIDE_CURSOR}`);
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

		this.terminalEnabled = false;
		this.interactiveSuspended = false;
		process.stdout.write(`${ANSI_RESET}${DISABLE_TERMINAL_KEY_REPORTING}${DISABLE_BRACKETED_PASTE}${ENABLE_TERMINAL_WRAP}\x1b[?1006l\x1b[?1002l\x1b[?1049l${SHOW_CURSOR}`);
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
	};

	private suspendForInteractiveProcess(): void {
		if (!this.terminalEnabled || this.interactiveSuspended) return;
		this.interactiveSuspended = true;
		process.stdin.off("data", this.onInputData);
		process.stdin.pause();
		process.stdout.off("resize", this.onResize);
		process.stdout.write(`${ANSI_RESET}${DISABLE_TERMINAL_KEY_REPORTING}${DISABLE_BRACKETED_PASTE}${ENABLE_TERMINAL_WRAP}\x1b[?1006l\x1b[?1002l\x1b[?1049l${SHOW_CURSOR}`);
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
	}

	private resumeAfterInteractiveProcess(): void {
		if (!this.terminalEnabled || !this.interactiveSuspended) return;
		this.interactiveSuspended = false;
		if (process.stdin.isTTY) process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on("data", this.onInputData);
		process.stdout.on("resize", this.onResize);
		this.host.resetRenderOutputBuffer();
		process.stdout.write(`${ANSI_RESET}${CLEAR_TERMINAL}\x1b[?1049h${CLEAR_TERMINAL}${ENABLE_TERMINAL_KEY_REPORTING}${ENABLE_BRACKETED_PASTE}${DISABLE_TERMINAL_WRAP}\x1b[?1002h\x1b[?1006h${HIDE_CURSOR}`);
		this.host.render();
	}

	private async stopInternal(): Promise<void> {
		if (!this.host.isRunning()) return;
		this.host.setRunning(false);
		this.host.closeSdkMenuForStop();
		this.host.clearToastTimers();
		this.host.stopBlinking();
		this.host.stopSubagentsPolling();
		this.host.stopModelUsagePolling();
		await this.host.stopVoiceInput();
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
		this.host.render();
	};

	private readonly onInputData = (chunk: Buffer): void => {
		this.host.handleInputChunk(chunk);
	};
}
