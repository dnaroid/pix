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
});

function fakeHost(inputChunks: string[] = []) {
	let running = true;
	return {
		isRunning: () => running,
		setRunning: (value: boolean) => {
			running = value;
		},
		runtime: () => undefined,
		saveInputStateForQuit: async () => {},
		disposeInactiveRuntimesForQuit: async () => {},
		render: () => {},
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
		resetRenderOutputBuffer: () => {},
	};
}

function stubTerminalIo(writes: string[]): (() => void) & { emitInput(chunk: string): void } {
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

	stdout.write = ((chunk: string | Uint8Array) => {
		writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
		return true;
	}) as typeof stdout.write;
	stdout.on = ((_: string, __: (...args: unknown[]) => void) => stdout) as typeof stdout.on;
	stdout.off = ((_: string, __: (...args: unknown[]) => void) => stdout) as typeof stdout.off;
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
	}) as (() => void) & { emitInput(chunk: string): void };
	restore.emitInput = (chunk: string) => {
		stdinDataListener?.(Buffer.from(chunk, "utf8"));
	};
	return restore;
}
