import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { clipboardInstallHint, osc52ClipboardSequence } from "../src/app/screen/clipboard.js";
import { openFileLink, setFileLinkOpenerTestDeps } from "../src/app/screen/file-link-opener.js";
import { openImageContent, setImageOpenerTestDeps } from "../src/app/screen/image-opener.js";
import { hasTerminalCommandModifier, isNativeCommandPressed, isNativeShiftPressed } from "../src/app/input/native-modifiers.js";

describe("screen openers and platform fallbacks", () => {
	it("returns false for invalid file and image open requests without spawning viewers", () => {
		assert.equal(openFileLink({ start: 0, end: 1, url: "https://example.test/not-local" }), false);
		assert.equal(openFileLink({ start: 0, end: 1, url: "file://%zz" }), false);
		assert.equal(openImageContent({ type: "image", mimeType: "image/png", data: "" }), false);
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

	it("opens explicit file paths through the configured zed command without touching the real PATH", () => {
		const zedCli = "/mock/bin/zed";
		const previousZedCli = process.env.ZED_CLI;
		const spawned: Array<{ command: string; args: readonly string[] }> = [];
		const restore = setFileLinkOpenerTestDeps({
			existsSync: (path) => path === zedCli,
			spawn: ((command: string, args: readonly string[]) => {
				spawned.push({ command, args });
				return fakeChildProcess();
			}) as never,
		});
		try {
			process.env.ZED_CLI = zedCli;

			assert.equal(openFileLink({ start: 0, end: 1, url: "file:///ignored", filePath: "/workspace/target.ts", line: 12, column: 3 }), true);
			assert.deepEqual(spawned, [{ command: zedCli, args: ["/workspace/target.ts:12:3"] }]);
		} finally {
			restore();
			if (previousZedCli === undefined) delete process.env.ZED_CLI;
			else process.env.ZED_CLI = previousZedCli;
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
			assert.deepEqual(calls, ["mkdir:/mock/tmp/pix-image-open", "mkdir:/mock/tmp/pix-image-open"]);
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
