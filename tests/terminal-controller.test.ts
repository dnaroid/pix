import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	CLEAR_TERMINAL,
	DISABLE_BRACKETED_PASTE,
	DISABLE_TERMINAL_KEY_REPORTING,
	DISABLE_TERMINAL_WRAP,
	ENABLE_BRACKETED_PASTE,
	ENABLE_TERMINAL_MODIFY_OTHER_KEYS,
	ENABLE_TERMINAL_KEY_REPORTING,
	ENABLE_TERMINAL_WRAP,
	HIDE_CURSOR,
	RESET_TERMINAL_VIEWPORT_STATE,
	SHOW_CURSOR,
} from "../src/app/constants.js";
import { AppTerminalController } from "../src/app/terminal/terminal-controller.js";
import { ANSI_RESET } from "../src/theme.js";

describe("AppTerminalController", () => {
	it("resets viewport state when entering the interactive terminal", async () => {
		const writes: string[] = [];
		const controller = new AppTerminalController(fakeHost());
		const restore = stubTerminalIo(writes);

		try {
			controller.enableTerminal();
			await controller.stop();
		} finally {
			restore();
		}

		assert.equal(
			writes[0],
			`${ANSI_RESET}${RESET_TERMINAL_VIEWPORT_STATE}${CLEAR_TERMINAL}\x1b[?1049h${RESET_TERMINAL_VIEWPORT_STATE}${CLEAR_TERMINAL}${ENABLE_TERMINAL_KEY_REPORTING}${ENABLE_BRACKETED_PASTE}${DISABLE_TERMINAL_WRAP}\x1b[?1002h\x1b[?1006h${HIDE_CURSOR}`,
		);
	});

	it("resets viewport state before leaving the interactive terminal", async () => {
		const writes: string[] = [];
		const controller = new AppTerminalController(fakeHost());
		const restore = stubTerminalIo(writes);

		try {
			controller.enableTerminal();
			await controller.stop();
		} finally {
			restore();
		}

		assert.equal(
			writes[writes.length - 1],
			`${ANSI_RESET}${RESET_TERMINAL_VIEWPORT_STATE}${DISABLE_TERMINAL_KEY_REPORTING}${DISABLE_BRACKETED_PASTE}${ENABLE_TERMINAL_WRAP}\x1b[?1006l\x1b[?1002l\x1b[?1049l${SHOW_CURSOR}`,
		);
	});

	it("falls back to modifyOtherKeys after a non-Kitty terminal response", async () => {
		const writes: string[] = [];
		const inputChunks: string[] = [];
		const controller = new AppTerminalController(fakeHost(inputChunks));
		const restore = stubTerminalIo(writes);

		try {
			controller.enableTerminal();
			restore.emitInput("\x1b[?1;2c");
			await controller.stop();
		} finally {
			restore();
		}

		assert.equal(inputChunks.length, 0);
		assert.equal(writes.includes(ENABLE_TERMINAL_MODIFY_OTHER_KEYS), true);
	});

	it("swallows Kitty keyboard protocol responses before forwarding input", async () => {
		const writes: string[] = [];
		const inputChunks: string[] = [];
		const controller = new AppTerminalController(fakeHost(inputChunks));
		const restore = stubTerminalIo(writes);

		try {
			controller.enableTerminal();
			restore.emitInput("\x1b[?7uabc");
			await controller.stop();
		} finally {
			restore();
		}

		assert.deepEqual(inputChunks, ["abc"]);
		assert.equal(writes.includes(ENABLE_TERMINAL_MODIFY_OTHER_KEYS), false);
	});

	it("decodes UTF-8 statefully across stdin Buffer chunks", async () => {
		const writes: string[] = [];
		const inputChunks: string[] = [];
		const controller = new AppTerminalController(fakeHost(inputChunks));
		const restore = stubTerminalIo(writes);
		const input = Buffer.from("🙂界", "utf8");

		try {
			controller.enableTerminal();
			restore.emitInput(input.subarray(0, 2));
			restore.emitInput(input.subarray(2, 5));
			restore.emitInput(input.subarray(5));
			await controller.stop();
		} finally {
			restore();
		}

		assert.equal(inputChunks.join(""), "🙂界");
		assert.equal(inputChunks.includes("�"), false);
	});

	it("resets buffered render output before repainting after resize", async () => {
		const writes: string[] = [];
		const events: string[] = [];
		const controller = new AppTerminalController(fakeHost([], events));
		const restore = stubTerminalIo(writes);

		try {
			controller.enableTerminal();
			restore.emitResize();
			await controller.stop();
		} finally {
			restore();
		}

		assert.deepEqual(events.slice(0, 2), ["resetRenderOutputBuffer", "render"]);
	});

	it("detaches input and resize rendering before awaiting shutdown cleanup", async () => {
		const writes: string[] = [];
		const inputChunks: string[] = [];
		const events: string[] = [];
		const host = fakeHost(inputChunks, events);
		host.cancelPendingTabLifecycle = () => { events.push("cancelTabs"); };
		let finishVoiceStop: (() => void) | undefined;
		let cleanupSawDeadline = false;
		host.stopVoiceInput = () => new Promise<void>((resolve) => {
			const deadline = (controller as unknown as { shutdownDeadlineAt?: number }).shutdownDeadlineAt;
			cleanupSawDeadline = typeof deadline === "number" && deadline > Date.now();
			finishVoiceStop = resolve;
		});
		const controller = new AppTerminalController(host);
		const restore = stubTerminalIo(writes);

		try {
			controller.enableTerminal();
			const stopping = controller.stop();
			restore.emitInput("late input");
			restore.emitResize();

			assert.deepEqual(inputChunks, []);
			assert.deepEqual(events, ["cancelTabs"]);
			assert.equal(host.isRunning(), false);
			assert.equal(cleanupSawDeadline, true);

			finishVoiceStop?.();
			await stopping;
		} finally {
			finishVoiceStop?.();
			restore();
		}
	});
});

function fakeHost(inputChunks: string[] = [], events: string[] = []) {
	let running = true;
	return {
		isRunning: () => running,
		setRunning: (value: boolean) => {
			running = value;
		},
		cancelPendingTabLifecycle: () => {},
		runtime: () => undefined,
		saveInputStateForQuit: async () => {},
		disposeInactiveRuntimesForQuit: async () => {},
		render: () => {
			events.push("render");
		},
		handleInputChunk: (chunk: Buffer) => {
			inputChunks.push(chunk.toString("utf8"));
		},
		closeSdkMenuForStop: () => {},
		clearToastTimers: () => {},
		stopBlinking: () => {},
		stopSubagentsPolling: () => {},
		stopModelUsagePolling: () => {},
		stopVoiceInput: async () => {},
		stopAutocomplete: () => {},
		stopShellCommand: () => {},
		unsubscribeSession: () => {},
		clearExtensionWidgets: () => {},
		resetRenderOutputBuffer: () => {
			events.push("resetRenderOutputBuffer");
		},
	};
}

function stubTerminalIo(writes: string[]): (() => void) & { emitInput(chunk: string | Buffer): void; emitResize(): void } {
	const stdout = process.stdout as NodeJS.WriteStream & {
		write: (chunk: string | Uint8Array) => boolean;
		on: (event: string, listener: (...args: unknown[]) => void) => NodeJS.WriteStream;
		off: (event: string, listener: (...args: unknown[]) => void) => NodeJS.WriteStream;
	};
	const stdin = process.stdin as NodeJS.ReadStream & {
		setRawMode?: (value: boolean) => void;
		resume: () => NodeJS.ReadStream;
		pause: () => NodeJS.ReadStream;
		on: (event: string, listener: (...args: unknown[]) => void) => NodeJS.ReadStream;
		off: (event: string, listener: (...args: unknown[]) => void) => NodeJS.ReadStream;
	};
	const originalWrite = stdout.write.bind(process.stdout);
	const originalStdoutOn = stdout.on.bind(process.stdout);
	const originalStdoutOff = stdout.off.bind(process.stdout);
	const originalResume = stdin.resume.bind(process.stdin);
	const originalPause = stdin.pause.bind(process.stdin);
	const originalStdinOn = stdin.on.bind(process.stdin);
	const originalStdinOff = stdin.off.bind(process.stdin);
	const originalSetRawMode = stdin.setRawMode?.bind(process.stdin);
	let stdinDataListener: ((chunk: Buffer) => void) | undefined;
	let stdoutResizeListener: (() => void) | undefined;

	stdout.write = ((chunk: string | Uint8Array) => {
		writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof stdout.write;
	stdout.on = ((event: string, listener: (...args: unknown[]) => void) => {
		if (event === "resize") stdoutResizeListener = listener as () => void;
		return stdout;
	}) as typeof stdout.on;
	stdout.off = ((event: string, listener: (...args: unknown[]) => void) => {
		if (event === "resize" && stdoutResizeListener === listener) stdoutResizeListener = undefined;
		return stdout;
	}) as typeof stdout.off;
	stdin.resume = (() => stdin) as typeof stdin.resume;
	stdin.pause = (() => stdin) as typeof stdin.pause;
	stdin.on = ((event: string, listener: (...args: unknown[]) => void) => {
		if (event === "data") stdinDataListener = listener as (chunk: Buffer) => void;
		return stdin;
	}) as typeof stdin.on;
	stdin.off = ((event: string, listener: (...args: unknown[]) => void) => {
		if (event === "data" && stdinDataListener === listener) stdinDataListener = undefined;
		return stdin;
	}) as typeof stdin.off;
	stdin.setRawMode = ((_value: boolean) => {}) as typeof stdin.setRawMode;

	const restore = (() => {
		stdout.write = originalWrite as typeof stdout.write;
		stdout.on = originalStdoutOn as typeof stdout.on;
		stdout.off = originalStdoutOff as typeof stdout.off;
		stdin.resume = originalResume as typeof stdin.resume;
		stdin.pause = originalPause as typeof stdin.pause;
		stdin.on = originalStdinOn as typeof stdin.on;
		stdin.off = originalStdinOff as typeof stdin.off;
		if (originalSetRawMode) stdin.setRawMode = originalSetRawMode as typeof stdin.setRawMode;
	}) as (() => void) & { emitInput(chunk: string | Buffer): void; emitResize(): void };
	restore.emitInput = (chunk: string | Buffer) => {
		stdinDataListener?.(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
	};
	restore.emitResize = () => {
		stdoutResizeListener?.();
	};
	return restore;
}
