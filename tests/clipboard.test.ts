import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clipboardSupportAvailable, copyTextToClipboard, osc52ClipboardSequence, setClipboardTestDeps } from "../src/app/screen/clipboard.js";

describe("clipboard OSC52 fallback", () => {
	it("formats a plain OSC52 clipboard sequence", () => {
		assert.equal(osc52ClipboardSequence("hello", {}), "\x1b]52;c;aGVsbG8=\x07");
	});

	it("wraps OSC52 for tmux passthrough", () => {
		assert.equal(osc52ClipboardSequence("hello", { TMUX: "/tmp/tmux" }), "\x1bPtmux;\x1b\x1b]52;c;aGVsbG8=\x07\x1b\\");
	});

	it("wraps OSC52 for screen passthrough", () => {
		assert.equal(osc52ClipboardSequence("hello", { STY: "screen" }), "\x1bP\x1b]52;c;aGVsbG8=\x07\x1b\\");
	});

	it("copies through the first successful platform command", async () => {
		const attempts: Array<{ command: string; input: string | undefined }> = [];
		const successfulCommand = process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip.exe" : "xclip";
		const restore = setClipboardTestDeps({
			runProcess: (async (command, _args, options) => {
				attempts.push({ command, input: options?.input });
				return { status: command === successfulCommand ? 0 : 1, stdout: "", stderr: "" };
			}) as never,
			requireResolve: () => {
				throw new Error("native unavailable");
			},
			stdout: fakeStdout({ isTTY: false }),
		});
		try {
			await copyTextToClipboard("copied");
			assert.deepEqual(attempts.map((attempt) => attempt.command), process.platform === "darwin" ? ["pbcopy"] : process.platform === "win32" ? ["clip.exe"] : ["wl-copy", "xclip"]);
			assert.equal(attempts[attempts.length - 1]?.input, "copied");
		} finally {
			restore();
		}
	});

	it("falls back to native clipboard and OSC52 without invoking real integrations", async () => {
		const commands: string[] = [];
		const restoreNative = setClipboardTestDeps({
			runProcess: (async (command) => {
				commands.push(command);
				return { status: command === process.execPath ? 0 : 1, stdout: "", stderr: "" };
			}) as never,
			requireResolve: () => "/mock/native-clipboard.cjs",
			stdout: fakeStdout({ isTTY: false }),
		});
		try {
			await copyTextToClipboard("native");
			assert.equal(commands[commands.length - 1], process.execPath);
		} finally {
			restoreNative();
		}

		const writes: string[] = [];
		const previousTmux = process.env.TMUX;
		const restoreOsc52 = setClipboardTestDeps({
			runProcess: (async () => ({ status: 1, stdout: "", stderr: "" })) as never,
			requireResolve: () => {
				throw new Error("native unavailable");
			},
			stdout: fakeStdout({ isTTY: true, write: (chunk) => {
				writes.push(String(chunk));
				return true;
			} }),
		});
		try {
			delete process.env.TMUX;
			await copyTextToClipboard("osc");
			assert.deepEqual(writes, [osc52ClipboardSequence("osc")]);
		} finally {
			restoreOsc52();
			if (previousTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = previousTmux;
		}
	});

	it("reports availability and clear errors using mocked dependencies", async () => {
		const restoreAvailable = setClipboardTestDeps({
			commandExists: (async (command) => command === (process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip.exe" : "xsel")) as never,
			requireResolve: () => {
				throw new Error("native unavailable");
			},
		});
		try {
			assert.equal(await clipboardSupportAvailable({}), true);
		} finally {
			restoreAvailable();
		}

		const restoreUnavailable = setClipboardTestDeps({
			commandExists: (async () => false) as never,
			runProcess: (async () => ({ status: 1, stdout: "", stderr: "" })) as never,
			requireResolve: () => {
				throw new Error("native unavailable");
			},
			stdout: fakeStdout({ isTTY: false }),
		});
		try {
			assert.equal(await clipboardSupportAvailable({}), false);
			await assert.rejects(copyTextToClipboard("nope"), /No clipboard command found/u);
		} finally {
			restoreUnavailable();
		}
	});
});

function fakeStdout(overrides: Partial<Pick<NodeJS.WriteStream, "destroyed" | "isTTY" | "write">> = {}): Pick<NodeJS.WriteStream, "destroyed" | "isTTY" | "write"> {
	return {
		destroyed: false,
		isTTY: false,
		write: () => true,
		...overrides,
	};
}
