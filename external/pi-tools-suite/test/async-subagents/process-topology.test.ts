import { test, expect } from "bun:test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { terminateProcessTree } from "../../src/async-subagents/core/process.js";

const fixture = fileURLToPath(new URL("./fixtures/process-topology.mjs", import.meta.url));
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A zombie has already stopped executing; kill(pid, 0) alone reports it as alive.
function running(pid: number): boolean {
	try {
		const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { timeout: 500 }).toString().trim();
		return state.length > 0 && !state.startsWith("Z");
	} catch (error) {
		const failure = error as Error & { status?: number; stdout?: Buffer; stderr?: Buffer };
		if (failure.status === 1 && !failure.stdout?.length && !failure.stderr?.length) return false;
		throw error;
	}
}

// Bun runs these tests, but the fixture intentionally characterizes Node processes.
// Resolve the actual Node binary rather than accidentally launching Bun via process.execPath.
const node = process.platform === "win32" ? "" : (() => {
	try {
		const info = JSON.parse(execFileSync("node", ["-e", "process.stdout.write(JSON.stringify({path:process.execPath,name:process.release.name,bun:!!process.versions.bun}))"], { timeout: 2000 }).toString()) as { path: string; name: string; bun: boolean };
		if (info.name !== "node" || info.bun || !info.path) throw new Error("node command did not launch real Node.js");
		return info.path;
	} catch (error) {
		throw new Error("POSIX process-topology tests require a real Node.js executable on PATH", { cause: error });
	}
})();

function groupOf(pid: number): number {
	return Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { timeout: 500 }).toString().trim());
}

async function until(check: () => boolean, label: string, timeout = 2500): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (check()) return;
		await delay(20);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

function launch(mode: string, marker = "", pidFile = ""): { child: ChildProcess; ready: Promise<{ ready: number; leaf?: number }> } {
	const child = spawn(node, [fixture, mode, marker, pidFile], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
	const ready = new Promise<{ ready: number; leaf?: number }>((resolve, reject) => {
		let output = "";
		let settled = false;
		const timer = setTimeout(() => finish(new Error(`${mode} fixture readiness timed out`)), 2500);
		const finish = (error?: Error, value?: { ready: number; leaf?: number }) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.stdout?.removeListener("data", onData);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			if (error) reject(error);
			else resolve(value!);
		};
		const onError = (error: Error) => finish(error);
		const onExit = () => finish(new Error(`${mode} fixture exited before readiness`));
		const onData = (chunk: Buffer) => {
			output += chunk.toString();
			const newline = output.indexOf("\n");
			if (newline >= 0) {
				try { finish(undefined, JSON.parse(output.slice(0, newline))); }
				catch (error) { finish(error as Error); }
			}
		};
		child.once("error", onError);
		child.once("exit", onExit);
		child.stdout?.on("data", onData);
	});
	return { child, ready };
}

// Track PIDs before assertions, including startup failures; the owned fixture
// groups are always torn down, never the unrelated process's group.
async function characterize(mode: "same" | "detached" | "forward"): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "subagent-topology-"));
	const marker = join(dir, "term-marker");
	const pidFile = join(dir, "leaf-pid");
	const root = launch(mode, marker, pidFile);
	let control: ReturnType<typeof launch> | undefined;
	let leafPid: number | undefined;
	let failure: unknown;
	try {
		control = launch("control");
		const [owned, unrelated] = await Promise.all([root.ready, control.ready]);
		leafPid = owned.leaf;
		expect(owned.ready).toBe(root.child.pid);
		expect(leafPid).toBeGreaterThan(0);
		expect(running(unrelated.ready)).toBe(true);
		expect(groupOf(owned.ready)).toBe(owned.ready);
		expect(groupOf(unrelated.ready)).toBe(unrelated.ready);
		expect(groupOf(leafPid!)).toBe(mode === "same" ? owned.ready : leafPid);

		terminateProcessTree(owned.ready, mode === "forward" ? "SIGTERM" : "SIGKILL");
		await until(() => !running(owned.ready), "root exit");
		if (mode === "detached") {
			// OPEN G1/T3 gate: current group kill does NOT own a detached provider descendant.
			expect(running(leafPid!)).toBe(true);
			expect(existsSync(marker)).toBe(false);
		} else {
			await until(() => !running(leafPid!), "same-group/gracefully forwarded leaf exit");
			if (mode === "forward") expect(readFileSync(marker, "utf8")).toBe("SIGTERM");
		}
		expect(running(unrelated.ready)).toBe(true);
	} catch (error) {
		failure = error;
	} finally {
		// Cleanup on assertion or readiness failure too; avoid signaling a PID that
		// has already exited. These are test-owned groups, not production ownership.
		const cleanupErrors: unknown[] = [];
		const attempt = async (action: () => void | Promise<void>) => {
			try { await action(); } catch (error) { cleanupErrors.push(error); }
		};
		await attempt(() => {
			if (!leafPid && existsSync(pidFile)) leafPid = Number(readFileSync(pidFile, "utf8"));
			if (leafPid !== undefined && (!Number.isSafeInteger(leafPid) || leafPid <= 0)) throw new Error(`Invalid fixture leaf PID: ${leafPid}`);
		});
		const killGroup = async (pid: number | undefined, label: string, member?: number) => {
			if (!pid) return;
			await attempt(async () => {
				const live = running(pid) ? pid : member && running(member) ? member : undefined;
				if (!live) return;
				if (groupOf(live) !== pid) throw new Error(`${label} is not in expected fixture group ${pid}`);
				try { process.kill(-pid, "SIGKILL"); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
				await until(() => !running(live), `${label} cleanup`);
			});
		};
		if (mode !== "same") await killGroup(leafPid, "leaf");
		await killGroup(root.child.pid, "root", mode === "same" ? leafPid : undefined);
		await killGroup(control?.child.pid, "control");
		if (leafPid) await attempt(() => until(() => !running(leafPid!), "leaf cleanup"));
		await attempt(() => { rmSync(dir, { recursive: true, force: true }); });
		if (cleanupErrors.length) throw new AggregateError(failure === undefined ? cleanupErrors : [failure, ...cleanupErrors], "Process-topology cleanup failed");
	}
	if (failure !== undefined) throw failure;
}

test.skipIf(process.platform === "win32")("owned POSIX group SIGKILL stops same-group descendant without signaling unrelated control", async () => {
	await characterize("same");
}, 10000);

test.skipIf(process.platform === "win32")("OPEN G1/T3: detached descendant survives current Pi group SIGKILL (not Claude cleanup success)", async () => {
	await characterize("detached");
}, 10000);

test.skipIf(process.platform === "win32")("optional graceful forwarding can stop detached descendant but cannot prove force-stop safety", async () => {
	await characterize("forward");
}, 10000);
