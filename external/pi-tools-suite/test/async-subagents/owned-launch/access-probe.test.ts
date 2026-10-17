import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	launchdAccess,
	probeLaunchdAccess,
	setLaunchdAccessProbeForTest,
	type LaunchdAccess,
	type LaunchdAccessProbeDeps,
} from "../../../src/async-subagents/core/owned-launch/access-probe.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;
const roots: string[] = [];
afterEach(() => {
	setLaunchdAccessProbeForTest(undefined);
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const tempDir = () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launchd-probe-test-"));
	roots.push(dir);
	return dir;
};

/** Fake launchctl: "bootstrap" runs the plist's ProgramArguments directly (as launchd would). */
function fakeDeps(options: { bootstrapRc?: number; run?: boolean } = {}): LaunchdAccessProbeDeps & { calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		tmpRoot: tempDir(),
		resultTimeoutMs: 2_000,
		uid: 501,
		launchctl: async (args) => {
			calls.push(args);
			if (args[0] !== "bootstrap") return 0;
			if (options.bootstrapRc) return options.bootstrapRc;
			if (options.run === false) return 0;
			const plist = fs.readFileSync(args[2]!, "utf8");
			const unescape = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&amp;/g, "&");
			const program = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => unescape(m[1]!)).slice(1);
			spawn(program[0]!, program.slice(1), { stdio: "ignore" });
			return 0;
		},
	};
}

describePosix("launchd access probe", () => {
	test("reports ok when every directory is listable and cleans up the job and temp dir", async () => {
		const deps = fakeDeps();
		expect(await probeLaunchdAccess([tempDir(), tempDir()], deps)).toEqual({ access: "ok", definitive: true });
		expect(deps.calls.map((c) => c[0])).toEqual(["bootstrap", "bootout"]);
		expect(deps.calls[1]![1]).toStartWith("gui/501/org.pix.launchd-probe.");
		expect(fs.readdirSync(deps.tmpRoot)).toEqual([]);
	});

	test("reports denied when any directory is not listable", async () => {
		const deps = fakeDeps();
		expect(await probeLaunchdAccess([tempDir(), path.join(tempDir(), "missing")], deps)).toEqual({ access: "denied", definitive: true });
	});

	test("a refused bootstrap is denied but not definitive; a silent job is unknown", async () => {
		const refused = fakeDeps({ bootstrapRc: 5 });
		expect(await probeLaunchdAccess([tempDir()], refused)).toEqual({ access: "denied", definitive: false });
		expect(refused.calls.map((c) => c[0])).toEqual(["bootstrap"]);
		const silent = fakeDeps({ run: false });
		silent.resultTimeoutMs = 150;
		expect(await probeLaunchdAccess([tempDir()], silent)).toEqual({ access: "unknown", definitive: false });
		expect(silent.calls.map((c) => c[0])).toEqual(["bootstrap", "bootout"]);
	});

	test("caches definitive verdicts, shares concurrent probes and retries unknown", async () => {
		const dir = tempDir();
		let calls = 0;
		let next: LaunchdAccess = "unknown";
		setLaunchdAccessProbeForTest(async () => { calls++; return next; });
		expect(await launchdAccess([dir])).toBe("unknown");
		next = "denied";
		const [a, b] = await Promise.all([launchdAccess([dir, dir]), launchdAccess([dir])]);
		expect([a, b]).toEqual(["denied", "denied"]);
		expect(calls).toBe(2);
		next = "ok";
		expect(await launchdAccess([dir])).toBe("denied");
		expect(calls).toBe(2);
	});
});
