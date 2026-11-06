import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gameInputArgs } from "../../src/async-subagents/agents/ui-qa/backends/game-input.mjs";
import { runOwnedProcess, validateDesktopStepCapabilities } from "../../src/async-subagents/agents/ui-qa/backends/desktop.mjs";

describe("bounded game input", () => {
	test("combines movement, camera and button in one bounded operation", () => {
		expect(gameInputArgs({ keys: ["w", "shift"], durationMs: 5000, dx: -400, dy: 50, button: "left" })).toEqual([
			"--keys", "w,shift", "--duration", "5", "--dx", "-400", "--dy", "50", "--button", "left",
		]);
		expect(gameInputArgs({})).toEqual(["--keys", "", "--duration", "0.1", "--dx", "0", "--dy", "0"]);
	});
	test("foreground system delivery requires an explicit mode", () => {
		expect(gameInputArgs({ delivery: "foreground" }).slice(-2)).toEqual(["--delivery", "foreground"]);
		expect(gameInputArgs({ delivery: "pid" }).slice(-2)).toEqual(["--delivery", "pid"]);
		for (const delivery of ["global", "", true, 1]) expect(() => gameInputArgs({ delivery })).toThrow(/delivery/);
		expect(validateDesktopStepCapabilities({ action: "gameInput", delivery: "foreground" }, ["gameInput"]).delivery).toBe("foreground");
	});
	test("rejects unbounded, malformed and system-shortcut input", () => {
		for (const step of [
			{ keys: "w" }, { keys: ["w", "w"] }, { keys: ["cmd", "q"] }, { keys: ["W"] },
			{ keys: [..."abcdefghi"] }, { durationMs: 0 }, { durationMs: 5001 },
			{ durationMs: NaN }, { dx: Infinity }, { dy: 2001 }, { dx: 0.5 }, { button: "middle" },
		]) expect(() => gameInputArgs(step)).toThrow();
		expect(() => gameInputArgs({ durationMs: 5000 }, 5000)).toThrow(/setup and release/);
	});
	test("old helpers and other platforms cannot silently claim game input", () => {
		const step = { action: "gameInput", keys: ["e"] };
		expect(() => validateDesktopStepCapabilities(step, ["keyboardInput"])).toThrow(/requires gameInput/);
		expect(validateDesktopStepCapabilities(step, ["gameInput"])).toEqual(step);
	});
	test.skipIf(process.platform === "win32")("timeout gives input producer time to release but still reports failure", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "game-input-release-"));
		const marker = path.join(dir, "released");
		try {
			await expect(runOwnedProcess(process.execPath, ["-e", `
				process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'released'); process.exit(0); });
				setInterval(() => {}, 1000);
			`], { cwd: dir, timeoutMs: 1000, terminationGraceMs: 500 })).rejects.toThrow(/timed out/);
			expect(fs.readFileSync(marker, "utf8")).toBe("released");
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	});
	test.skipIf(process.platform === "win32")("unresponsive producer remains bounded", async () => {
		await expect(runOwnedProcess(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
			cwd: process.cwd(), timeoutMs: 1000, terminationGraceMs: 100,
		})).rejects.toThrow(/timed out/);
	});
});
