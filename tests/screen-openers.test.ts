import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { describe, it } from "node:test";

import { clipboardInstallHint, osc52ClipboardSequence } from "../src/app/screen/clipboard.js";
import { openFileLink, setFileLinkOpenerTestDeps } from "../src/app/screen/file-link-opener.js";
import { openImageContent, setImageOpenerTestDeps } from "../src/app/screen/image-opener.js";
import { hasTerminalCommandModifier, isNativeCommandPressed, isNativeShiftPressed } from "../src/app/input/native-modifiers.js";

describe("screen openers and platform fallbacks", () => {
	it("returns false for invalid file and image open requests without spawning viewers", () => {
		assert.equal(openFileLink({ start: 0, end: 1, url: "file://%zz" }), false);
		assert.equal(openImageContent({ type: "image", mimeType: "image/png", data: "" }), false);
	});

	it("opens web links with the system browser fallback", () => {
		const spawned: Array<{ command: string; args: readonly string[] }> = [];
		const restore = setFileLinkOpenerTestDeps({
			platform: "linux",
			spawn: ((command: string, args: readonly string[]) => {
				spawned.push({ command, args });
				return fakeChildProcess();
			}) as never,
		});

		try {
			assert.equal(openFileLink({ start: 0, end: 1, url: "https://example.test/docs" }), true);
			assert.deepEqual(spawned, [{ command: "xdg-open", args: ["https://example.test/docs"] }]);
		} finally {
			restore();
		}
	});

	it("formats clipboard hints and OSC52 passthrough sequences", () => {
		assert.match(clipboardInstallHint(), /clipboard|wl-clipboard|pbcopy|clip\.exe|platform/u);
		assert.equal(osc52ClipboardSequence("hello", { TMUX: "1", STY: "screen" }).startsWith("\x1bPtmux;"), true);
	});

	it("detects terminal command modifiers and handles absent native helpers", () => {
		assert.equal(hasTerminalCommandModifier(1), false);
		assert.equal(hasTerminalCommandModifier(9), true);
		assert.equal(isNativeShiftPressed(), false);
		assert.equal(isNativeCommandPressed(), false);
	});

	it("opens explicit file paths through the detected zed command without touching the real PATH", () => {
		const zedCli = "/mock/bin/zed";
		const spawned: Array<{ command: string; args: readonly string[] }> = [];
		const restore = setFileLinkOpenerTestDeps({
			env: { ZED_CLI: zedCli },
			existsSync: (path: Parameters<typeof import("node:fs").existsSync>[0]) => path === zedCli,
			spawn: ((command: string, args: readonly string[]) => {
				spawned.push({ command, args });
				return fakeChildProcess();
			}) as never,
		});
		try {
			assert.equal(openFileLink({ start: 0, end: 1, url: "file:///ignored", filePath: "/workspace/target.ts", line: 12, column: 3 }), true);
			assert.deepEqual(spawned, [{ command: zedCli, args: ["/workspace/target.ts:12:3"] }]);
		} finally {
			restore();
		}
	});

	it("opens file links in VS Code with --goto when launched from a VS Code terminal", () => {
		const spawned: Array<{ command: string; args: readonly string[] }> = [];
		const restore = setFileLinkOpenerTestDeps({
			env: { PATH: "/mock/bin", TERM_PROGRAM: "vscode" },
			platform: "linux",
			existsSync: (path: Parameters<typeof import("node:fs").existsSync>[0]) => path === "/mock/bin/code",
			spawn: ((command: string, args: readonly string[]) => {
				spawned.push({ command, args });
				return fakeChildProcess();
			}) as never,
		});

		try {
			assert.equal(openFileLink({ start: 0, end: 1, url: "file:///ignored", filePath: "/workspace/target.ts", line: 12, column: 3 }), true);
			assert.deepEqual(spawned, [{ command: "code", args: ["--goto", "/workspace/target.ts:12:3"] }]);
		} finally {
			restore();
		}
	});

	it("falls back to xdg-open on Linux when the detected editor cli is unavailable", () => {
		const spawned: Array<{ command: string; args: readonly string[] }> = [];
		const restore = setFileLinkOpenerTestDeps({
			env: { PATH: "/mock/bin", TERM_PROGRAM: "vscode" },
			platform: "linux",
			existsSync: () => false,
			spawn: ((command: string, args: readonly string[]) => {
				spawned.push({ command, args });
				return fakeChildProcess();
			}) as never,
		});

		try {
			assert.equal(openFileLink({ start: 0, end: 1, url: "file:///ignored", filePath: "/workspace/target.ts", line: 12, column: 3 }), true);
			assert.deepEqual(spawned, [{ command: "xdg-open", args: ["/workspace/target.ts"] }]);
		} finally {
			restore();
		}
	});

	it("falls back to the Windows shell opener when the detected editor cli is unavailable", () => {
		const spawned: Array<{ command: string; args: readonly string[] }> = [];
		const restore = setFileLinkOpenerTestDeps({
			env: { PATH: "C:\\mock\\bin", PATHEXT: ".EXE;.CMD;.BAT;.COM", TERM_PROGRAM: "vscode" },
			platform: "win32",
			existsSync: () => false,
			spawn: ((command: string, args: readonly string[]) => {
				spawned.push({ command, args });
				return fakeChildProcess();
			}) as never,
		});

		try {
			assert.equal(openFileLink({ start: 0, end: 1, url: "file:///ignored", filePath: "C:\\workspace\\target.ts", line: 12, column: 3 }), true);
			assert.deepEqual(spawned, [{ command: "cmd", args: ["/c", "start", "", "C:\\workspace\\target.ts"] }]);
		} finally {
			restore();
		}
	});

	it("writes image content through mocked filesystem deps and asks the platform viewer to open it", () => {
		const calls: string[] = [];
		const writes: Array<{ filePath: string; data: Buffer }> = [];
		const spawned: Array<{ command: string; args: readonly string[] }> = [];
		const restore = setImageOpenerTestDeps({
			tmpdir: () => "/mock/tmp",
			mkdirSync: (path) => {
				calls.push(`mkdir:${path}`);
				return undefined;
			},
			existsSync: () => false,
			writeFileSync: (filePath, data) => {
				writes.push({ filePath: String(filePath), data: Buffer.from(data as Uint8Array) });
			},
			spawn: ((command: string, args: readonly string[]) => {
				spawned.push({ command, args });
				return fakeChildProcess();
			}) as never,
		});

		try {
			assert.equal(openImageContent({ type: "image", mimeType: "image/gif", data: Buffer.from("GIF89a").toString("base64") }), true);
			assert.equal(openImageContent({ type: "image", mimeType: "image/svg+xml", data: Buffer.from("<svg/>").toString("base64") }), true);
			assert.deepEqual(calls, [
				`mkdir:${join("/mock/tmp", "pix-image-open")}`,
				`mkdir:${join("/mock/tmp", "pix-image-open")}`,
			]);
			assert.equal(writes.length, 2);
			assert.equal(writes[0]?.filePath.endsWith(".gif"), true);
			assert.equal(writes[1]?.filePath.endsWith(".svg"), true);
			assert.equal(writes[0]?.data.toString("utf8"), "GIF89a");
			assert.equal(writes[1]?.data.toString("utf8"), "<svg/>");
			assert.equal(spawned.length, 2);
			assert.equal(spawned.every((call) => call.command === platformOpenCommand()), true);
		} finally {
			restore();
		}
	});
});

function fakeChildProcess(): never {
	const child = new EventEmitter() as EventEmitter & { unref(): void };
	child.unref = () => {};
	return child as never;
}

function platformOpenCommand(): string {
	if (process.platform === "darwin") return "open";
	if (process.platform === "win32") return "cmd";
	return "xdg-open";
}
