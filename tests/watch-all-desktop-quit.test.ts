import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { macDesktopQuitScript, quitMacDesktopApp } from "../scripts/watch-all-desktop-quit.mjs";
import { WatchAllSupervisor, usesDesktopAppBundle } from "../scripts/watch-all.mjs";

describe("watch:all clean macOS Quit", () => {
	it("targets only the exact native PID, not the bundle ID or all Pix instances", () => {
		const script = macDesktopQuitScript(4242);
		assert.match(script, /runningApplicationWithProcessIdentifier\(4242\)/);
		assert.match(script, /Number\(app.processIdentifier\) !== 4242/);
		assert.match(script, /app\.terminate/);
		assert.doesNotMatch(script, /forceTerminate|bundleIdentifier|kill|SIGTERM/);
		for (const pid of [0, -1, NaN, Infinity, 1.5, "4242; injected()"])
			assert.throws(() => macDesktopQuitScript(pid), /invalid Desktop PID/);
	});

	it("waits for a slow clean exit after requesting Quit", async () => {
		const calls: unknown[] = [];
		await quitMacDesktopApp(4242, async (pid: number, timeout: number) => {
			calls.push(["wait", pid, timeout]);
			return timeout > 0;
		}, async (pid: number) => { calls.push(["quit", pid]); });
		assert.deepEqual(calls, [["wait", 4242, 0], ["quit", 4242], ["wait", 4242, 30_000]]);
	});

	it("does not request Quit for an already-exited app", async () => {
		await quitMacDesktopApp(4242, async () => true, async () => { assert.fail("app is already gone"); });
	});

	it("fails closed when Quit is refused or its helper fails", async () => {
		let probes = 0;
		await assert.rejects(quitMacDesktopApp(4242, async () => { probes++; return false; },
			async () => { throw new Error("Quit refused"); }), /Quit refused/);
		assert.equal(probes, 1);
	});

	it("leaves the app alive when clean shutdown times out", async () => {
		await assert.rejects(quitMacDesktopApp(4242, async () => false, async () => {}), /leaving it alive/);
	});

	it("does not send Quit if process liveness cannot be determined", async () => {
		await assert.rejects(quitMacDesktopApp(4242, async () => { throw new Error("ps failed"); },
			async () => assert.fail("must fail closed")), /ps failed/);
	});

	it("reports failed watcher shutdown and retains the running executable identity", async () => {
		const supervisor = new WatchAllSupervisor();
		const app = { pid: 4242, exitCode: null, signalCode: null };
		supervisor.desktopProcess = app;
		supervisor.desktopAppPid = 4242;
		supervisor.desktopRunningExecutable = "/tmp/owned/Pix Desktop.app/Contents/MacOS/pix-desktop";
		supervisor.stopDesktopInstance = async (instance: unknown) => {
			assert.deepEqual(instance, { process: app, appPid: 4242, executable: supervisor.desktopRunningExecutable });
			return false;
		};
		const oldExitCode = process.exitCode;
		try {
			await supervisor.stop();
			assert.equal(process.exitCode, 1);
			assert.equal(supervisor.desktopProcess, app);
		} finally { process.exitCode = oldExitCode; }
	});

	it("does not clean up the launcher when app Quit fails", async () => {
		const supervisor = new WatchAllSupervisor({ stopDesktopApp: async () => { throw new Error("slow Quit"); } });
		const errors: string[] = [];
		const log = console.error;
		console.error = (message: string) => { errors.push(message); };
		try {
			const stopped = await supervisor.stopDesktopInstance({
				appPid: 4242,
				process: { pid: undefined, exitCode: null, signalCode: null, once: () => assert.fail("launcher must stay alive") },
			});
			assert.equal(stopped, false);
			assert.match(errors.join(""), /retaining app and bundles.*slow Quit/);
		} finally { console.error = log; }
	});

	it("keeps an unidentified live macOS app launcher instead of signalling it", { skip: !usesDesktopAppBundle() }, async () => {
		const supervisor = new WatchAllSupervisor({ stopDesktopApp: async () => assert.fail("unknown app") });
		const log = console.error;
		console.error = () => {};
		try {
			assert.equal(await supervisor.stopDesktopInstance({
				process: { pid: undefined, exitCode: null, signalCode: null, once: () => assert.fail("launcher must stay alive") },
			}), false);
		} finally { console.error = log; }
	});

	it("cleans up an exited launcher only after app shutdown succeeds", async () => {
		let quit = false;
		const supervisor = new WatchAllSupervisor({ stopDesktopApp: async (pid: number) => {
			assert.equal(pid, 4242);
			quit = true;
		} });
		assert.equal(await supervisor.stopDesktopInstance({
			appPid: 4242,
			process: { pid: undefined, get exitCode() { assert.equal(quit, true); return 0; }, signalCode: null },
		}), true);
	});
});
