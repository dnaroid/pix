import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clipboardSupportAvailable, copyTextToClipboard, osc52ClipboardSequence, setClipboardTestDeps } from "../src/app/screen/clipboard.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeStdout(overrides: Partial<Pick<NodeJS.WriteStream, "destroyed" | "isTTY" | "write">> = {}): Pick<NodeJS.WriteStream, "destroyed" | "isTTY" | "write"> {
	return {
		destroyed: false,
		isTTY: false,
		write: () => true,
		...overrides,
	};
}

/** On Linux the list is longer; on darwin/win32 only one entry. */
function firstPlatformCommand(): string {
	switch (process.platform) {
		case "darwin": return "pbcopy";
		case "win32": return "clip.exe";
		default: return "wl-copy";
	}
}

function expectedCommandChain(): string[] {
	switch (process.platform) {
		case "darwin": return ["pbcopy"];
		case "win32": return ["clip.exe"];
		default: return ["wl-copy", "xclip", "xsel", "termux-clipboard-set"];
	}
}

// ---------------------------------------------------------------------------
// OSC52 encoding
// ---------------------------------------------------------------------------

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
});

// ---------------------------------------------------------------------------
// copyTextToClipboard – platform command path
// ---------------------------------------------------------------------------

describe("copyTextToClipboard", () => {
	it("copies through the first successful platform command", async () => {
		const attempts: Array<{ command: string; input: string | undefined }> = [];
		const restore = setClipboardTestDeps({
			runProcess: (async (command, _args, options) => {
				attempts.push({ command, input: options?.input });
				return { status: command === firstPlatformCommand() ? 0 : 1, stdout: "", stderr: "" };
			}) as never,
			requireResolve: () => { throw new Error("native unavailable"); },
			stdout: fakeStdout({ isTTY: false }),
		});
		try {
			await copyTextToClipboard("copied");
			assert.equal(attempts.length, 1);
			assert.equal(attempts[0]!.command, firstPlatformCommand());
			assert.equal(attempts[0]!.input, "copied");
		} finally {
			restore();
		}
	});

	it("falls back to native clipboard when platform commands fail", async () => {
		const commands: string[] = [];
		const restore = setClipboardTestDeps({
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
			restore();
		}
	});

	it("falls back to OSC52 when platform commands and native clipboard are unavailable", async () => {
		const writes: string[] = [];
		const previousTmux = process.env.TMUX;
		const restore = setClipboardTestDeps({
			runProcess: (async () => ({ status: 1, stdout: "", stderr: "" })) as never,
			requireResolve: () => { throw new Error("native unavailable"); },
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
			restore();
			if (previousTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = previousTmux;
		}
	});

	it("throws when no clipboard mechanism is available", async () => {
		const restore = setClipboardTestDeps({
			commandExists: (async () => false) as never,
			runProcess: (async () => ({ status: 1, stdout: "", stderr: "" })) as never,
			requireResolve: () => { throw new Error("native unavailable"); },
			stdout: fakeStdout({ isTTY: false }),
		});
		try {
			await assert.rejects(copyTextToClipboard("nope"), /No clipboard command found/u);
		} finally {
			restore();
		}
	});
});

// ---------------------------------------------------------------------------
// Empty buffer / empty string
// ---------------------------------------------------------------------------

describe("empty buffer", () => {
	it("OSC52 encodes empty text as bare base64 field", () => {
		// base64("") = ""
		assert.equal(osc52ClipboardSequence(""), "\x1b]52;c;\x07");
	});

	it("OSC52 wraps empty text through tmux passthrough", () => {
		assert.equal(osc52ClipboardSequence("", { TMUX: "/tmp/tmux" }), "\x1bPtmux;\x1b\x1b]52;c;\x07\x1b\\");
	});

	it("OSC52 wraps empty text through screen passthrough", () => {
		assert.equal(osc52ClipboardSequence("", { STY: "screen" }), "\x1bP\x1b]52;c;\x07\x1b\\");
	});

	it("copies empty string via the first successful platform command", async () => {
		const attempts: Array<{ command: string; input: string | undefined }> = [];
		const restore = setClipboardTestDeps({
			runProcess: (async (command, _args, options) => {
				attempts.push({ command, input: options?.input });
				return { status: command === firstPlatformCommand() ? 0 : 1, stdout: "", stderr: "" };
			}) as never,
			requireResolve: () => { throw new Error("native unavailable"); },
			stdout: fakeStdout({ isTTY: false }),
		});
		try {
			await copyTextToClipboard("");
			assert.equal(attempts.length, 1);
			assert.equal(attempts[0]!.command, firstPlatformCommand());
			assert.equal(attempts[0]!.input, "");
		} finally {
			restore();
		}
	});

	it("falls back to native clipboard with empty text when platform commands fail", async () => {
		const commands: string[] = [];
		const restore = setClipboardTestDeps({
			runProcess: (async (command) => {
				commands.push(command);
				return { status: command === process.execPath ? 0 : 1, stdout: "", stderr: "" };
			}) as never,
			requireResolve: () => "/mock/native-clipboard.cjs",
			stdout: fakeStdout({ isTTY: false }),
		});
		try {
			await copyTextToClipboard("");
			assert.equal(commands[commands.length - 1], process.execPath);
		} finally {
			restore();
		}
	});

	it("falls back to OSC52 with empty text when no command is available", async () => {
		const writes: string[] = [];
		const previousTmux = process.env.TMUX;
		const previousSty = process.env.STY;
		const restore = setClipboardTestDeps({
			runProcess: (async () => ({ status: 1, stdout: "", stderr: "" })) as never,
			requireResolve: () => { throw new Error("native unavailable"); },
			stdout: fakeStdout({ isTTY: true, write: (chunk) => {
				writes.push(String(chunk));
				return true;
			} }),
		});
		try {
			delete process.env.TMUX;
			delete process.env.STY;
			await copyTextToClipboard("");
			assert.deepEqual(writes, [osc52ClipboardSequence("")]);
		} finally {
			restore();
			if (previousTmux === undefined) delete process.env.TMUX;
			else process.env.TMUX = previousTmux;
			if (previousSty === undefined) delete process.env.STY;
			else process.env.STY = previousSty;
		}
	});

	it("throws for empty text when no clipboard mechanism is available", async () => {
		const restore = setClipboardTestDeps({
			commandExists: (async () => false) as never,
			runProcess: (async () => ({ status: 1, stdout: "", stderr: "" })) as never,
			requireResolve: () => { throw new Error("native unavailable"); },
			stdout: fakeStdout({ isTTY: false }),
		});
		try {
			await assert.rejects(copyTextToClipboard(""), /No clipboard command found/u);
		} finally {
			restore();
		}
	});
});

// ---------------------------------------------------------------------------
// clipboardSupportAvailable
// ---------------------------------------------------------------------------

describe("clipboardSupportAvailable", () => {
	it("returns true when a platform command exists", async () => {
		const restore = setClipboardTestDeps({
			commandExists: (async (cmd) => cmd === firstPlatformCommand()) as never,
			requireResolve: () => { throw new Error("native unavailable"); },
		});
		try {
			assert.equal(await clipboardSupportAvailable({}), true);
		} finally {
			restore();
		}
	});

	it("returns true when native clipboard package is resolvable", async () => {
		const restore = setClipboardTestDeps({
			commandExists: (async () => false) as never,
			requireResolve: () => "/mock/native-clipboard.cjs",
		});
		try {
			assert.equal(await clipboardSupportAvailable({}), true);
		} finally {
			restore();
		}
	});

	it("returns false when no platform command exists and native is unavailable", async () => {
		const restore = setClipboardTestDeps({
			commandExists: (async () => false) as never,
			requireResolve: () => { throw new Error("native unavailable"); },
		});
		try {
			assert.equal(await clipboardSupportAvailable({}), false);
		} finally {
			restore();
		}
	});
});
