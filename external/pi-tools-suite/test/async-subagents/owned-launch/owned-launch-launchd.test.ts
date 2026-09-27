// Opt-in offline macOS tests (PI_OFFLINE_COALITION_PROBE=1) for the
// owned-launch candidate production containment launcher
// (src/async-subagents/core/owned-launch). Every launchd job created here
// is a fresh UUID-labelled service in the caller's gui domain; teardown
// boots out only those exact services and verifies `launchctl print` no
// longer finds them. Process observation is existence-only (ps), and the
// only signals the harness itself ever sends are to its own direct
// children (the bridge, killed with SIGKILL to simulate joint loss; the
// control sleeper, killed at teardown). No PID sweeps, no group kills, no
// unrelated signals.
//
// Cases:
//  1. natural completion: the payload leader exits by itself; the
//     supervisor drains the surviving setsid'd TERM-resistant descendant
//     and finishes with a kernel-zero receipt; the bridge exits 0.
//  2. joint loss: SIGKILL of the bridge plus destruction of the parent's
//     stdio ends (simultaneous Pi/launcher loss) triggers the drain.
//  3. bridge death before release: no payload work is ever released.
//  4. supervisor crash + KeepAlive restart: the recovered supervisor
//     cancels from the journal; it never resumes work.
//  5. disk-only cancel: the durable `cancel` marker alone (no stop(), no
//     signal, live bridge, open stdio) drains the owned coalition.
//  6. stop() after bridge death: the durable marker is still written and
//     the drain is ordered even with no signalable child.
//  7. restart after a terminal receipt: a supervisor killed between its
//     durable receipt and job retirement (deterministic
//     test-hold-before-retire barrier) is restarted by KeepAlive and only
//     retires the jobs — the successful receipt/cause/payload code are
//     never altered.
//  8. bridge death inside the check→release window (deterministic
//     test-hold-pre-release barrier): the race is real — release wins
//     posthumously, the payload may briefly run, and the supervisor still
//     drains everything to kernel zero on control EOF.
//
// An unrelated control process (/bin/sleep) must survive every case.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { ensureOwnedLaunchBinaries } from "../../../src/async-subagents/core/owned-launch/bootstrap.js";
import { launchOwnedAgent, launchOwnedAgentSync, type OwnedLaunchHandle } from "../../../src/async-subagents/core/owned-launch/launcher.js";
import { fenceOwnedLaunchRunAsync, readOwnedLaunchClaimSync, writeOwnedLaunchCancelMarker } from "../../../src/async-subagents/core/owned-launch/marker.js";
import { readOwnedLaunchReceipt } from "../../../src/async-subagents/core/owned-launch/receipt.js";

const domain = `gui/${process.getuid!()}`;
const launchctl = (args: string[], timeout = 10_000) => spawnSync("launchctl", args, { timeout, encoding: "utf8" });
function servicePresence(result: { status: number | null; error?: Error; signal?: string | null }): "present" | "absent" | "unknown" {
	if (result.error || result.signal) return "unknown";
	if (result.status === 0) return "present";
	if (result.status === 113) return "absent";
	return "unknown";
}
function serviceExists(label: string): boolean {
	const result = launchctl(["print", `${domain}/${label}`]);
	const presence = servicePresence(result);
	if (presence === "unknown") throw new Error(`ambiguous launchctl print ${label}: ${result.status} ${result.error?.message ?? result.stderr}`);
	return presence === "present";
}

test("fixture retirement requires exact successful service-absence observation", () => {
	expect(servicePresence({ status: 0 })).toBe("present");
	expect(servicePresence({ status: 113 })).toBe("absent");
	for (const result of [{ status: null }, { status: 1 }, { status: 5 },
		{ status: 113, error: new Error("timeout") }, { status: 113, signal: "SIGTERM" }]) {
		expect(servicePresence(result)).toBe("unknown");
	}
});

async function waitFor(predicate: () => boolean, deadlineMs: number, what: string) {
	const end = Date.now() + deadlineMs;
	while (Date.now() < end) {
		if (predicate()) return;
		await Bun.sleep(50);
	}
	throw new Error(`deadline waiting for ${what}`);
}

// Existence-only ps observation; errors are failures, never evidence.
function pidAlive(pid: number): boolean {
	const r = spawnSync("ps", ["-p", String(pid), "-o", "pid="], { timeout: 4000, encoding: "utf8" });
	if (r.error) throw new Error(`ps failed: ${r.error.message}`);
	if (r.status === 1 && r.stdout.trim() === "") return false;
	if (r.status !== 0) throw new Error(`ambiguous ps: ${r.status} ${r.stderr}`);
	return r.stdout.trim().length > 0;
}

const kv = (path: string) =>
	Object.fromEntries([...readFileSync(path, "utf8").matchAll(/([a-z_]+)=(\S+)/g)].map((m) => [m[1], m[2]]));

interface Payload {
	workerScript: string;
	escapeeBin: string;
	markerDir: string;
}

function makePayload(base: string, mode: "natural" | "long-lived", exitCode = 0): Payload {
	const dir = join(base, "payload");
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const escapeeBin = join(dir, "escapee");
	const compile = spawnSync(
		"xcrun",
		["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", join(import.meta.dir, "fixtures", "escapee.c"), "-o", escapeeBin],
		{ timeout: 20_000, encoding: "utf8" },
	);
	expect(compile.status, compile.stderr || compile.error?.message).toBe(0);
	const workerScript = join(dir, mode === "natural" ? "worker-natural.sh" : "worker-long.sh");
	const script = [
		"#!/bin/sh",
		`"$ESCAPEE_BIN" "$ESCAPEE_MARKER" 90 &`,
		`echo "$$" > "$WORKER_MARKER"`,
		mode === "natural" ? `sleep 1\nexit ${exitCode}` : "exec /bin/sleep 300",
		"",
	].join("\n");
	writeFileSync(workerScript, script, { mode: 0o700 });
	chmodSync(workerScript, 0o700);
	return { workerScript, escapeeBin, markerDir: dir };
}

function envFor(payload: Payload): Record<string, string> {
	return {
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
		ESCAPEE_BIN: payload.escapeeBin,
		ESCAPEE_MARKER: join(payload.markerDir, "escapee.pid"),
		WORKER_MARKER: join(payload.markerDir, "worker.pid"),
	};
}

const escapeePidOf = (payload: Payload) =>
	existsSync(join(payload.markerDir, "escapee.pid")) ? Number(readFileSync(join(payload.markerDir, "escapee.pid"), "utf8").trim()) : 0;

async function teardown(handle: OwnedLaunchHandle | null) {
	if (handle && existsSync(join(handle.runDir, "release")) && !existsSync(join(handle.runDir, "owned.json"))) {
		console.error(`RETAIN_UNDRAINED=${handle.runDir}`);
		return false;
	}
	if (handle && existsSync(join(handle.runDir, "owned.json"))) {
		if (!existsSync(join(handle.runDir, "drain.json"))) {
			console.error(`RETAIN_UNDRAINED=${handle.runDir}`);
			return false;
		}
		const r = kv(join(handle.runDir, "drain.json"));
		if (r.status !== "ok" || (r.esrch !== "1" && r.started !== r.exited)) {
			console.error(`RETAIN_UNDRAINED=${handle.runDir}`);
			return false;
		}
	}
	for (const label of handle ? [handle.labelWorker, handle.labelSupervisor] : []) {
		if (serviceExists(label)) launchctl(["bootout", `${domain}/${label}`]);
	}
	// Never remove a run directory before both jobs are confirmed absent —
	// including on failure paths: a leaked KeepAlive job must stay
	// addressable through its run-dir artifacts (spec/plist labels).
	if (handle) {
		let retired = true;
		for (const label of [handle.labelWorker, handle.labelSupervisor]) {
			try {
				await waitFor(() => !serviceExists(label), 20_000, `confirmed absent ${label}`);
			} catch {
				retired = false;
			}
		}
		if (!retired) {
			console.error(`RETAIN_LIVE_JOBS=${handle.runDir}`);
			return false;
		}
	}
	return true;
}

const optIn = process.platform === "darwin" && process.env.PI_OFFLINE_COALITION_PROBE === "1";

test.skipIf(!optIn)("payload exit 7 is propagated, not reported as success", async () => {
	const base = mkdtempSync(join(tmpdir(), "ol-exit7-"));
	let handle: OwnedLaunchHandle | null = null;
	try {
		const binaries = await ensureOwnedLaunchBinaries({ cacheRoot: join(base, "cache") });
		handle = await launchOwnedAgent({ command: "/bin/sh", args: ["-c", "exit 7"], cwd: base,
			env: { PATH: "/usr/bin:/bin" }, baseDir: join(base, "runs"), binaries,
			timeouts: { watchdogSeconds: 60, releaseTimeoutSeconds: 20, drainDeadlineSeconds: 20 } });
		const exit = await Promise.race([handle.exited, Bun.sleep(40_000).then(() => null)]);
		expect(exit?.code).toBe(7);
		const receipt = kv(join(handle.runDir, "drain.json"));
		expect(receipt.status).toBe("ok");
		expect(readOwnedLaunchReceipt(handle.runDir)?.contained).toBe(true);
		expect(readOwnedLaunchReceipt(handle.runDir)?.payloadCode).toBe(7);
		expect(receipt.started).toBe(receipt.exited);
		// The bridge took the exclusive launch claim: a later restart fence loses.
		expect(readOwnedLaunchClaimSync(handle.runDir)).toBe("bridge");
		expect(await fenceOwnedLaunchRunAsync(handle.runDir)).toBe("bridge");
		expect(readOwnedLaunchClaimSync(handle.runDir)).toBe("bridge");
	} finally {
		const safe = await teardown(handle);
		if (safe) rmSync(base, { recursive: true, force: true });
	}
}, 90_000);

test.skipIf(!optIn)("blocked stdout and parked stdin do not prevent bridge cancellation", async () => {
	const base = mkdtempSync(join(tmpdir(), "ol-blocked-pipes-"));
	let handle: OwnedLaunchHandle | null = null;
	try {
		const binaries = await ensureOwnedLaunchBinaries({ cacheRoot: join(base, "cache") });
		handle = await launchOwnedAgent({ command: "/bin/sh", args: ["-c", "yes x | head -c 10000000; sleep 300"],
			cwd: base, env: { PATH: "/usr/bin:/bin" }, baseDir: join(base, "runs"), binaries,
			timeouts: { watchdogSeconds: 60, releaseTimeoutSeconds: 20, drainDeadlineSeconds: 20 } });
		// Deliberately never read stdout. Stdin is flooded while the gate
		// remains parked and again after release; this must not block control.
		const chunk = "x".repeat(65536);
		for (let i = 0; i < 32; i++) if (!handle.process.stdin?.write(chunk)) break;
		await waitFor(() => existsSync(join(handle!.runDir, "release")) && existsSync(join(handle!.runDir, "gate-handoff")), 20_000, "blocked payload release");
		handle.stop();
		const exit = await Promise.race([handle.exited, Bun.sleep(30_000).then(() => null)]);
		expect(exit?.code).toBe(143);
		await waitFor(() => existsSync(join(handle!.runDir, "drain.json")), 15_000, "blocked-pipe drain");
		const receipt = kv(join(handle.runDir, "drain.json"));
		expect(receipt.status).toBe("ok");
		expect(receipt.started).toBe(receipt.exited);
	} finally {
		const safe = await teardown(handle);
		if (safe) rmSync(base, { recursive: true, force: true });
	}
}, 90_000);

test.skipIf(!optIn)(
	"natural leader exit drains the setsid TERM-resistant descendant with a kernel-zero receipt",
	async () => {
		const base = mkdtempSync(join(tmpdir(), "ol-natural-"));
		let handle: OwnedLaunchHandle | null = null;
		const control = Bun.spawn(["/bin/sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		try {
			const binaries = await ensureOwnedLaunchBinaries({ cacheRoot: join(base, "cache") });
			const payload = makePayload(base, "natural");
			handle = await launchOwnedAgent({
				command: "/bin/sh",
				args: [payload.workerScript],
				cwd: base,
				env: envFor(payload),
				baseDir: join(base, "runs"),
				binaries,
				timeouts: { watchdogSeconds: 90, releaseTimeoutSeconds: 20, drainDeadlineSeconds: 20 },
			});
			// The parent keeps the bridge's stdin open for the whole run, as
			// spawn.ts does for a spawned sub-agent process.

			const exit = await Promise.race([
				handle.exited,
				Bun.sleep(60_000).then(() => null),
			]);
			expect(exit, "bridge should exit after natural completion drain").not.toBeNull();
			expect(exit!.code).toBe(0);

			await waitFor(() => existsSync(join(handle!.runDir, "drain.json")), 10_000, "drain receipt");
			const receipt = kv(join(handle.runDir, "drain.json"));
			expect(receipt.status).toBe("ok");
			expect(["natural", "leader_exit"]).toContain(receipt.cause);
			expect(Number(receipt.started)).toBeGreaterThanOrEqual(2); // gate(payload) + escapee
			expect(Number(receipt.exited)).toBe(Number(receipt.started)); // kernel-zero receipt
			expect(parseInt(receipt.cid, 16)).toBeGreaterThan(0);
			expect(receipt.cid).not.toBe(receipt.sup_cid); // per-run UUID coalition

			// The escapee (setsid, TERM-ignoring) is gone well before its 90s
			// watchdog; the payload actually ran.
			expect(existsSync(join(payload.markerDir, "worker.pid"))).toBe(true);
			const escapee = escapeePidOf(payload);
			expect(escapee).toBeGreaterThan(0);
			await waitFor(() => !pidAlive(escapee), 10_000, "escapee death");
			expect(pidAlive(escapee)).toBe(false);

			// Both owned jobs are gone; the unrelated control survives.
			await waitFor(() => !serviceExists(handle!.labelWorker), 10_000, "worker bootout");
			await waitFor(() => !serviceExists(handle!.labelSupervisor), 10_000, "supervisor bootout");
			expect(serviceExists(handle.labelWorker)).toBe(false);
			expect(serviceExists(handle.labelSupervisor)).toBe(false);
			expect(control.exitCode).toBe(null);
			expect(pidAlive(control.pid)).toBe(true);
			// Sockets were cleaned by the bridge on its normal exit.
			for (const sock of ["control.sock", "stdin.sock", "stdout.sock", "stderr.sock"]) {
				expect(existsSync(join(handle.socketsDir, sock))).toBe(false);
			}
		} finally {
			const safe = await teardown(handle);
			control.kill();
			if (safe) rmSync(base, { recursive: true, force: true });
		}
	},
	120_000,
);

test.skipIf(!optIn)(
	"simultaneous bridge loss and parent stdio destruction drains the owned coalition",
	async () => {
		const base = mkdtempSync(join(tmpdir(), "ol-joint-"));
		let handle: OwnedLaunchHandle | null = null;
		const control = Bun.spawn(["/bin/sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		try {
			const binaries = await ensureOwnedLaunchBinaries({ cacheRoot: join(base, "cache") });
			const payload = makePayload(base, "long-lived");
			handle = await launchOwnedAgent({
				command: "/bin/sh",
				args: [payload.workerScript],
				cwd: base,
				env: envFor(payload),
				baseDir: join(base, "runs"),
				binaries,
				timeouts: { watchdogSeconds: 300, releaseTimeoutSeconds: 20, drainDeadlineSeconds: 25 },
			});
			// Wait until work is durably owned and released, and the escapee exists.
			await waitFor(
				() =>
					existsSync(join(handle!.runDir, "owned.json")) &&
					existsSync(join(handle!.runDir, "release")) &&
					existsSync(join(handle!.runDir, "gate-handoff")) &&
					escapeePidOf(payload) > 0,
				30_000,
				"release + escapee",
			);
			const escapee = escapeePidOf(payload);
			expect(pidAlive(escapee)).toBe(true);

			// Joint loss: kill the bridge with SIGKILL AND destroy the
			// parent's stdio ends (Pi's pipes vanish).
			handle.process.stdin?.destroy();
			handle.process.stdout?.destroy();
			handle.process.stderr?.destroy();
			handle.process.kill("SIGKILL");

			await waitFor(() => existsSync(join(handle!.runDir, "drain.json")), 45_000, "drain receipt after joint loss");
			const receipt = kv(join(handle.runDir, "drain.json"));
			expect(receipt.status).toBe("ok");
			expect(receipt.cause).toBe("cancel");
			expect(Number(receipt.exited)).toBe(Number(receipt.started));
			// The setsid'd TERM-resistant descendant died before its watchdog.
			await waitFor(() => !pidAlive(escapee), 10_000, "escapee death after joint loss");
			expect(pidAlive(escapee)).toBe(false);
			await waitFor(() => !serviceExists(handle!.labelWorker), 10_000, "worker bootout");
			await waitFor(() => !serviceExists(handle!.labelSupervisor), 10_000, "supervisor bootout");
			expect(pidAlive(control.pid)).toBe(true);
		} finally {
			const safe = await teardown(handle);
			control.kill();
			if (safe) rmSync(base, { recursive: true, force: true });
		}
	},
	150_000,
);

test.skipIf(!optIn)(
	"bridge death before release releases no payload work",
	async () => {
		const base = mkdtempSync(join(tmpdir(), "ol-prerelease-"));
		let handle: OwnedLaunchHandle | null = null;
		const control = Bun.spawn(["/bin/sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		try {
			const binaries = await ensureOwnedLaunchBinaries({ cacheRoot: join(base, "cache") });
			const payload = makePayload(base, "long-lived");
			handle = await launchOwnedAgent({
				command: "/bin/sh",
				args: [payload.workerScript],
				cwd: base,
				env: envFor(payload),
				baseDir: join(base, "runs"),
				binaries,
				timeouts: { watchdogSeconds: 60, releaseTimeoutSeconds: 20, drainDeadlineSeconds: 20 },
			});
			// The supervisor job exists, then the bridge dies before we ever
			// observe a release. (If the supervisor had not connected yet, it
			// fails closed with no-bridge — also no release. Either path
			// proves the invariant.)
			await waitFor(() => serviceExists(handle!.labelSupervisor), 30_000, "supervisor service");
			handle.process.kill("SIGKILL");

			await waitFor(
				() =>
					existsSync(join(handle!.runDir, "drain.json")) ||
					(!serviceExists(handle!.labelSupervisor) && !serviceExists(handle!.labelWorker)),
				45_000,
				"supervisor conclusion",
			);
			// No work was released: no release marker, no payload marker, no escapee.
			expect(existsSync(join(handle.runDir, "release"))).toBe(false);
			expect(existsSync(join(payload.markerDir, "worker.pid"))).toBe(false);
			expect(escapeePidOf(payload)).toBe(0);
			await waitFor(() => !serviceExists(handle!.labelWorker), 15_000, "worker bootout");
			await waitFor(() => !serviceExists(handle!.labelSupervisor), 15_000, "supervisor bootout");
			expect(pidAlive(control.pid)).toBe(true);
		} finally {
			const safe = await teardown(handle);
			control.kill();
			if (safe) rmSync(base, { recursive: true, force: true });
		}
	},
	120_000,
);

test.skipIf(!optIn)(
	"supervisor crash restart recovers the journal and cancels, never resumes",
	async () => {
		const base = mkdtempSync(join(tmpdir(), "ol-restart-"));
		let handle: OwnedLaunchHandle | null = null;
		const control = Bun.spawn(["/bin/sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		try {
			const binaries = await ensureOwnedLaunchBinaries({ cacheRoot: join(base, "cache") });
			const payload = makePayload(base, "long-lived");
			handle = await launchOwnedAgent({
				command: "/bin/sh",
				args: [payload.workerScript],
				cwd: base,
				env: envFor(payload),
				baseDir: join(base, "runs"),
				binaries,
				timeouts: { watchdogSeconds: 300, releaseTimeoutSeconds: 20, drainDeadlineSeconds: 25 },
			});
			await waitFor(
				() =>
					existsSync(join(handle!.runDir, "owned.json")) &&
					existsSync(join(handle!.runDir, "release")) &&
					existsSync(join(handle!.runDir, "gate-handoff")) &&
					escapeePidOf(payload) > 0,
				30_000,
				"release + escapee",
			);
			const escapee = escapeePidOf(payload);
			expect(pidAlive(escapee)).toBe(true);

			// Crash the supervisor through exact UUID job control only.
			const kill = launchctl(["kill", "SIGKILL", `${domain}/${handle.labelSupervisor}`]);
			expect(kill.status, kill.stderr).toBe(0);

			// launchd restarts it (KeepAlive); the recovered instance reads the
			// journal, cancels (never resumes), and drains to kernel zero.
			await waitFor(() => existsSync(join(handle!.runDir, "drain.json")), 45_000, "restart recovery receipt");
			const receipt = kv(join(handle.runDir, "drain.json"));
			expect(receipt.status).toBe("ok");
			expect(receipt.cause).toBe("restart_recovery");
			expect(Number(receipt.exited)).toBe(Number(receipt.started));
			await waitFor(() => !pidAlive(escapee), 10_000, "escapee death after restart recovery");
			expect(pidAlive(escapee)).toBe(false);
			await waitFor(() => !serviceExists(handle!.labelWorker), 10_000, "worker bootout");
			await waitFor(() => !serviceExists(handle!.labelSupervisor), 15_000, "supervisor bootout");
			expect(pidAlive(control.pid)).toBe(true);
			// The bridge applied the cancelled verdict.
			const exit = await Promise.race([handle.exited, Bun.sleep(15_000).then(() => null)]);
			expect(exit, "bridge should exit after restart-recovery cancel").not.toBeNull();
			expect(exit!.code).toBe(143);
		} finally {
			const safe = await teardown(handle);
			control.kill();
			if (safe) rmSync(base, { recursive: true, force: true });
		}
	},
	150_000,
);

test.skipIf(!optIn)(
	"disk cancel marker alone drains the owned coalition with no signal and a live bridge",
	async () => {
		const base = mkdtempSync(join(tmpdir(), "ol-disk-cancel-"));
		let handle: OwnedLaunchHandle | null = null;
		const control = Bun.spawn(["/bin/sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		try {
			const binaries = await ensureOwnedLaunchBinaries({ cacheRoot: join(base, "cache") });
			const payload = makePayload(base, "long-lived");
			handle = await launchOwnedAgent({
				command: "/bin/sh",
				args: [payload.workerScript],
				cwd: base,
				env: envFor(payload),
				baseDir: join(base, "runs"),
				binaries,
				timeouts: { watchdogSeconds: 300, releaseTimeoutSeconds: 20, drainDeadlineSeconds: 25 },
			});
			await waitFor(
				() =>
					existsSync(join(handle!.runDir, "owned.json")) &&
					existsSync(join(handle!.runDir, "release")) &&
					existsSync(join(handle!.runDir, "gate-handoff")) &&
					escapeePidOf(payload) > 0,
				30_000,
				"release + escapee",
			);
			const escapee = escapeePidOf(payload);
			expect(pidAlive(escapee)).toBe(true);

			// Disk-only cancel: no stop(), no signal to anything, the bridge
			// stays alive and the parent keeps stdio open. The durable marker
			// is the ONLY cancel input.
			writeOwnedLaunchCancelMarker(handle.runDir);

			await waitFor(() => existsSync(join(handle!.runDir, "drain.json")), 45_000, "disk-cancel drain receipt");
			const receipt = kv(join(handle.runDir, "drain.json"));
			expect(receipt.status).toBe("ok");
			expect(receipt.cause).toBe("cancel");
			expect(Number(receipt.exited)).toBe(Number(receipt.started));
			expect(readOwnedLaunchReceipt(handle.runDir)?.contained).toBe(true);
			await waitFor(() => !pidAlive(escapee), 10_000, "escapee death after disk cancel");
			expect(pidAlive(escapee)).toBe(false);
			await waitFor(() => !serviceExists(handle!.labelWorker), 10_000, "worker bootout");
			await waitFor(() => !serviceExists(handle!.labelSupervisor), 15_000, "supervisor bootout");
			const exit = await Promise.race([handle.exited, Bun.sleep(15_000).then(() => null)]);
			expect(exit?.code).toBe(143);
			expect(pidAlive(control.pid)).toBe(true);
		} finally {
			const safe = await teardown(handle);
			control.kill();
			if (safe) rmSync(base, { recursive: true, force: true });
		}
	},
	150_000,
);

test.skipIf(!optIn)(
	"stop() orders the durable cancel marker even when the bridge is already dead",
	async () => {
		const base = mkdtempSync(join(tmpdir(), "ol-dead-bridge-stop-"));
		let handle: OwnedLaunchHandle | null = null;
		const control = Bun.spawn(["/bin/sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		try {
			const binaries = await ensureOwnedLaunchBinaries({ cacheRoot: join(base, "cache") });
			const payload = makePayload(base, "long-lived");
			handle = await launchOwnedAgent({
				command: "/bin/sh",
				args: [payload.workerScript],
				cwd: base,
				env: envFor(payload),
				baseDir: join(base, "runs"),
				binaries,
				timeouts: { watchdogSeconds: 300, releaseTimeoutSeconds: 20, drainDeadlineSeconds: 25 },
			});
			await waitFor(
				() =>
					existsSync(join(handle!.runDir, "owned.json")) &&
					existsSync(join(handle!.runDir, "release")) &&
					existsSync(join(handle!.runDir, "gate-handoff")) &&
					escapeePidOf(payload) > 0,
				30_000,
				"release + escapee",
			);
			const escapee = escapeePidOf(payload);

			// Bridge dies first; stop() must still durably mark cancel instead
			// of returning early on a dead child.
			handle.process.kill("SIGKILL");
			await handle.exited;
			handle.stop();
			const marker = join(handle.runDir, "cancel");
			expect(existsSync(marker)).toBe(true);
			expect(statSync(marker).mode & 0o777).toBe(0o600);

			await waitFor(() => existsSync(join(handle!.runDir, "drain.json")), 45_000, "drain after dead-bridge stop");
			const receipt = kv(join(handle.runDir, "drain.json"));
			expect(receipt.status).toBe("ok");
			expect(receipt.cause).toBe("cancel");
			expect(Number(receipt.exited)).toBe(Number(receipt.started));
			await waitFor(() => !pidAlive(escapee), 10_000, "escapee death after dead-bridge stop");
			expect(pidAlive(escapee)).toBe(false);
			await waitFor(() => !serviceExists(handle!.labelWorker), 10_000, "worker bootout");
			await waitFor(() => !serviceExists(handle!.labelSupervisor), 15_000, "supervisor bootout");
			expect(pidAlive(control.pid)).toBe(true);
		} finally {
			const safe = await teardown(handle);
			control.kill();
			if (safe) rmSync(base, { recursive: true, force: true });
		}
	},
	150_000,
);

test.skipIf(!optIn)(
	"restart after a terminal receipt retires jobs without altering the successful receipt",
	async () => {
		const base = mkdtempSync(join(tmpdir(), "ol-terminal-restart-"));
		let handle: OwnedLaunchHandle | null = null;
		const control = Bun.spawn(["/bin/sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		try {
			const binaries = await ensureOwnedLaunchBinaries({ cacheRoot: join(base, "cache") });
			const payload = makePayload(base, "natural", 7);
			// Deterministic barrier: park the supervisor between its durable
			// receipt + verdict and job retirement (the crash window where a
			// receipt exists but the jobs are still installed).
			handle = await launchOwnedAgent({
				command: "/bin/sh",
				args: [payload.workerScript],
				cwd: base,
				env: envFor(payload),
				baseDir: join(base, "runs"),
				binaries,
				timeouts: { watchdogSeconds: 90, releaseTimeoutSeconds: 20, drainDeadlineSeconds: 20 },
				beforeSpawn: ({ runDir }) => writeFileSync(join(runDir, "test-hold-before-retire"), "stage=hold\n"),
			});
			const exit = await Promise.race([handle.exited, Bun.sleep(60_000).then(() => null)]);
			expect(exit, "bridge should exit with the payload code before the retire hold").not.toBeNull();
			expect(exit!.code).toBe(7);

			await waitFor(
				() => existsSync(join(handle!.runDir, "drain.json")) && existsSync(join(handle!.runDir, "test-hold-entered")),
				30_000,
				"receipt + retire hold",
			);
			const before = readFileSync(join(handle.runDir, "drain.json"), "utf8");
			const receiptBefore = kv(join(handle.runDir, "drain.json"));
			expect(receiptBefore.status).toBe("ok");
			expect(Number(receiptBefore.payload_code)).toBe(7);
			expect(readOwnedLaunchReceipt(handle.runDir)?.contained).toBe(true);
			expect(readOwnedLaunchReceipt(handle.runDir)?.payloadCode).toBe(7);

			// Kill the exact parked supervisor; KeepAlive restarts it straight
			// into the terminal-receipt retirement path.
			const kill = launchctl(["kill", "SIGKILL", `${domain}/${handle.labelSupervisor}`]);
			expect(kill.status, kill.stderr).toBe(0);
			rmSync(join(handle.runDir, "test-hold-before-retire"));

			await waitFor(
				() => !serviceExists(handle!.labelWorker) && !serviceExists(handle!.labelSupervisor),
				45_000,
				"post-restart retirement",
			);
			// The successful receipt is untouched: identical bytes, cause and
			// payload code preserved.
			expect(readFileSync(join(handle.runDir, "drain.json"), "utf8")).toBe(before);
			const receiptAfter = kv(join(handle.runDir, "drain.json"));
			expect(receiptAfter.cause).toBe(receiptBefore.cause);
			expect(receiptAfter.payload_code).toBe("7");
			const escapee = escapeePidOf(payload);
			if (escapee > 0) {
				await waitFor(() => !pidAlive(escapee), 10_000, "escapee death");
				expect(pidAlive(escapee)).toBe(false);
			}
			expect(pidAlive(control.pid)).toBe(true);
		} finally {
			const safe = await teardown(handle);
			control.kill();
			if (safe) rmSync(base, { recursive: true, force: true });
		}
	},
	150_000,
);

test.skipIf(!optIn)(
	"bridge death inside the check-release window still drains the released coalition",
	async () => {
		const base = mkdtempSync(join(tmpdir(), "ol-race-window-"));
		let handle: OwnedLaunchHandle | null = null;
		const control = Bun.spawn(["/bin/sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		try {
			const binaries = await ensureOwnedLaunchBinaries({ cacheRoot: join(base, "cache") });
			const payload = makePayload(base, "long-lived");
			// Deterministic barrier: park the supervisor INSIDE the
			// bridge-liveness-check → release window (the genuinely
			// non-atomic gap; no guessed delays).
			handle = await launchOwnedAgent({
				command: "/bin/sh",
				args: [payload.workerScript],
				cwd: base,
				env: envFor(payload),
				baseDir: join(base, "runs"),
				binaries,
				timeouts: { watchdogSeconds: 120, releaseTimeoutSeconds: 20, drainDeadlineSeconds: 25 },
				beforeSpawn: ({ runDir }) => writeFileSync(join(runDir, "test-hold-pre-release"), "stage=hold\n"),
			});
			await waitFor(
				() => existsSync(join(handle!.runDir, "owned.json")) && existsSync(join(handle!.runDir, "test-hold-entered")),
				30_000,
				"pre-release hold",
			);
			expect(existsSync(join(handle.runDir, "release"))).toBe(false);

			// The bridge dies inside the window while the supervisor is parked.
			handle.process.kill("SIGKILL");
			await handle.exited;
			expect(existsSync(join(handle.runDir, "release"))).toBe(false);

			// Release wins the race: the payload IS released posthumously —
			// the durable journal already existed, so the obligation was
			// covered. (Whether the payload completes its exec before the
			// EOF drain kills the parked gate is a genuine race; containment
			// must hold either way, so the escapee is asserted only if it
			// ever appeared.)
			rmSync(join(handle.runDir, "test-hold-pre-release"));
			await waitFor(() => existsSync(join(handle!.runDir, "release")), 30_000, "posthumous release");
			let escapee = escapeePidOf(payload);
			const escapeeSpawned = escapee > 0;

			// The supervisor still contains whatever was released: control
			// EOF drives the drain to a kernel-zero receipt.
			await waitFor(() => existsSync(join(handle!.runDir, "drain.json")), 45_000, "race-window drain receipt");
			const receipt = kv(join(handle.runDir, "drain.json"));
			expect(receipt.status).toBe("ok");
			expect(receipt.cause).toBe("cancel");
			expect(Number(receipt.exited)).toBe(Number(receipt.started));
			expect(readOwnedLaunchReceipt(handle.runDir)?.contained).toBe(true);
			if (escapeeSpawned) {
				escapee = escapeePidOf(payload);
				if (escapee > 0) {
					await waitFor(() => !pidAlive(escapee), 10_000, "escapee death after race-window release");
					expect(pidAlive(escapee)).toBe(false);
				}
			}
			await waitFor(() => !serviceExists(handle!.labelWorker), 10_000, "worker bootout");
			await waitFor(() => !serviceExists(handle!.labelSupervisor), 15_000, "supervisor bootout");
			expect(pidAlive(control.pid)).toBe(true);
		} finally {
			const safe = await teardown(handle);
			control.kill();
			if (safe) rmSync(base, { recursive: true, force: true });
		}
	},
	150_000,
);

test.skipIf(!optIn)(
	"restart fence: a late bridge refuses a fenced run before any bind or launchctl action",
	async () => {
		const base = mkdtempSync(join(tmpdir(), "ol-fenced-"));
		let handle: OwnedLaunchHandle | null = null;
		try {
			const binaries = await ensureOwnedLaunchBinaries({ cacheRoot: join(base, "cache") });
			// Recovery wins the claim between publish and bridge spawn (the
			// paused-parent window): same link(2) publication as production.
			handle = launchOwnedAgentSync({ command: "/bin/sh", args: ["-c", "echo released > released.txt; sleep 300"],
				cwd: base, env: { PATH: "/usr/bin:/bin" }, baseDir: join(base, "runs"), binaries,
				timeouts: { watchdogSeconds: 60, releaseTimeoutSeconds: 20, drainDeadlineSeconds: 20 },
				beforeSpawn: ({ runDir }) => {
					const tmp = join(runDir, ".claim.fence.test");
					writeFileSync(tmp, "role=fence stage=restart-recovery\n", { mode: 0o600 });
					linkSync(tmp, join(runDir, "claim"));
					unlinkSync(tmp);
				} });
			const exit = await Promise.race([handle.exited, Bun.sleep(20_000).then(() => null)]);
			expect(exit?.code).toBe(17);
			expect(readOwnedLaunchClaimSync(handle.runDir)).toBe("fence");
			for (const name of ["control.sock", "stdin.sock", "stdout.sock", "stderr.sock"])
				expect(existsSync(join(handle.socketsDir, name))).toBe(false);
			for (const name of ["bridge.json", "job-supervisor.plist", "owned.json", "release", "drain.json"])
				expect(existsSync(join(handle.runDir, name))).toBe(false);
			expect(serviceExists(handle.labelSupervisor)).toBe(false);
			expect(serviceExists(handle.labelWorker)).toBe(false);
			expect(existsSync(join(base, "released.txt"))).toBe(false);
		} finally {
			const safe = await teardown(handle);
			if (safe) rmSync(base, { recursive: true, force: true });
		}
	},
	60_000,
);

test.skipIf(!optIn)(
	"prelaunch abort: a claimed bridge that fails before launchctl records a durable never-launched outcome",
	async () => {
		const base = mkdtempSync(join(tmpdir(), "ol-prelaunch-"));
		let handle: OwnedLaunchHandle | null = null;
		let blocker = "";
		try {
			const binaries = await ensureOwnedLaunchBinaries({ cacheRoot: join(base, "cache") });
			handle = launchOwnedAgentSync({ command: "/bin/sh", args: ["-c", "echo released > released.txt; sleep 300"],
				cwd: base, env: { PATH: "/usr/bin:/bin" }, baseDir: join(base, "runs"), binaries,
				timeouts: { watchdogSeconds: 60, releaseTimeoutSeconds: 20, drainDeadlineSeconds: 20 },
				beforeSpawn: ({ runDir }) => {
					// Occupy the second listener path: control binds, stdin fails (EADDRINUSE).
					const socketsDir = /^sockets_dir=(.+)$/m.exec(readFileSync(join(runDir, "spec.txt"), "utf8"))![1];
					blocker = join(socketsDir, "stdin.sock");
					writeFileSync(blocker, "occupied\n", { mode: 0o600 });
				} });
			const exit = await Promise.race([handle.exited, Bun.sleep(20_000).then(() => null)]);
			expect(exit?.code).toBe(13);
			expect(readOwnedLaunchClaimSync(handle.runDir)).toBe("bridge");
			expect(readFileSync(join(handle.runDir, "prelaunch_abort"), "utf8")).toBe("role=prelaunch-abort code=13\n");
			// Only its own listener was unlinked; the foreign entry survives.
			expect(existsSync(join(handle.socketsDir, "control.sock"))).toBe(false);
			expect(readFileSync(blocker, "utf8")).toBe("occupied\n");
			for (const name of ["job-supervisor.plist", "owned.json", "release", "drain.json"])
				expect(existsSync(join(handle.runDir, name))).toBe(false);
			expect(serviceExists(handle.labelSupervisor)).toBe(false);
			expect(serviceExists(handle.labelWorker)).toBe(false);
			expect(existsSync(join(base, "released.txt"))).toBe(false);
		} finally {
			const safe = await teardown(handle);
			if (safe) rmSync(base, { recursive: true, force: true });
		}
	},
	60_000,
);
