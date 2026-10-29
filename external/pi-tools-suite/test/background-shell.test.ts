import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BackgroundShellManager, OutputRing, defaultProcessInspector } from "../src/background-shell/manager.js";
import { bindsAllInterfaces } from "../src/background-shell/service.js";
import { loadBackgroundShellConfig } from "../src/background-shell/config.js";

const unix = process.platform !== "win32";
const tempDirs: string[] = [];
const managers: BackgroundShellManager[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-shell-test-"));
	tempDirs.push(dir);
	return dir;
}

function manager(root: string, extra: Partial<ConstructorParameters<typeof BackgroundShellManager>[0]> = {}): BackgroundShellManager {
	const m = new BackgroundShellManager({ artifactsRoot: () => root, killGraceMs: 300, ...extra });
	managers.push(m);
	return m;
}

function start(m: BackgroundShellManager, command: string, cwd: string, sessionKey = "s1") {
	return m.start({ sessionKey, command, cwd, env: process.env, shell: "/bin/sh", shellArgs: ["-c"] });
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

afterEach(() => {
	for (const m of managers.splice(0)) m.dispose();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("OutputRing", () => {
	test("keeps absolute offsets when dropping old bytes", () => {
		const ring = new OutputRing(8);
		ring.append(Buffer.from("abcdef"));
		ring.append(Buffer.from("ghij"));
		expect(ring.start).toBe(2);
		expect(ring.end).toBe(10);
		expect(ring.read(0, 100).toString()).toBe("cdefghij");
		expect(ring.read(8, 100).toString()).toBe("ij");
		ring.append(Buffer.from("0123456789"));
		expect(ring.read(0, 100).toString()).toBe("23456789");
	});
});

describe.if(unix)("BackgroundShellManager", () => {
	test("start → incremental output cursor → exit code, with full log on disk", async () => {
		const root = tempDir();
		const m = manager(root);
		const job = start(m, "echo one; sleep 0.3; echo two; exit 3", root);
		expect(job.status).toBe("running");
		await until(() => m.get("s1", job.id)!.totalBytes >= 4);
		const first = m.read("s1", job.id);
		expect(first.text).toBe("one\n");
		const done = await m.waitFor("s1", job.id, 5000);
		expect(done).toMatchObject({ status: "exited", exitCode: 3 });
		const second = m.read("s1", job.id);
		expect(second.text).toBe("two\n");
		expect(second.from).toBe(first.cursor);
		expect(m.read("s1", job.id).text).toBe("");
		expect(m.read("s1", job.id, { since: 0 }).text).toBe("one\ntwo\n");
		await until(() => fs.readFileSync(job.logPath, "utf8") === "one\ntwo\n");
		expect(fs.existsSync(job.logPath.replace(/\.log$/, ".json"))).toBe(false);
	});

	test("filter and other sessions cannot read a job", async () => {
		const root = tempDir();
		const m = manager(root);
		const job = start(m, "printf 'a1\\nb2\\na3\\n'", root);
		await m.waitFor("s1", job.id, 5000);
		expect(m.read("s1", job.id, { filter: /^a/ }).text).toBe("a1\na3");
		expect(() => m.read("other", job.id)).toThrow("Unknown background job");
		expect(m.list("other")).toEqual([]);
	});

	test("kill terminates the whole process group including a child sleep", async () => {
		const root = tempDir();
		const pidFile = path.join(root, "child.pid");
		const m = manager(root);
		const job = start(m, `sleep 30 & echo $! > ${pidFile}; wait`, root);
		await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim().length > 0);
		const childPid = Number(fs.readFileSync(pidFile, "utf8").trim());
		expect(alive(childPid)).toBe(true);
		const final = await m.kill("s1", job.id);
		expect(final.status).toBe("killed");
		await until(() => !alive(childPid));
	});

	test("enforces the per-session running-job limit", async () => {
		const root = tempDir();
		const m = manager(root, { maxJobsPerSession: 2 });
		start(m, "sleep 30", root);
		const second = start(m, "sleep 30", root);
		expect(() => start(m, "sleep 30", root)).toThrow("limit reached (2");
		expect(start(m, "sleep 30", root, "s2").status).toBe("running");
		m.setSessionLimit("s1", 3);
		expect(start(m, "sleep 30", root).status).toBe("running");
		await m.kill("s1", second.id);
		m.setSessionLimit("s1", 2);
		expect(() => start(m, "sleep 30", root)).toThrow("limit reached");
	});

	test("shutdownSession kills every job, refuses new jobs and drops late output", async () => {
		const root = tempDir();
		const m = manager(root);
		const a = start(m, "sleep 30", root);
		const b = start(m, "while true; do echo tick; sleep 0.05; done", root);
		const other = start(m, "sleep 30", root, "s2");
		await m.shutdownSession("s1");
		expect(alive(a.pid!)).toBe(false);
		expect(alive(b.pid!)).toBe(false);
		expect(m.list("s1")).toEqual([]);
		expect(() => start(m, "echo late", root)).toThrow("shutting down");
		expect(m.get("s2", other.id)!.status).toBe("running");
		const sizeAfter = fs.statSync(b.logPath).size;
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(fs.statSync(b.logPath).size).toBe(sizeAfter);
		m.openSession("s1");
		expect(start(m, "true", root).status).toBe("running");
	});

	test("kill requested during spawn settles as killed without leaking", async () => {
		const root = tempDir();
		const m = manager(root);
		const job = start(m, "sleep 30", root);
		const killing = m.kill("s1", job.id);
		const again = m.kill("s1", job.id);
		const [first, second] = await Promise.all([killing, again]);
		expect(first.status).toBe("killed");
		expect(second.status).toBe("killed");
		expect(alive(job.pid!)).toBe(false);
	});

	test("spawn failure is reported as a failed job", async () => {
		const root = tempDir();
		const m = manager(root, { spawn: (() => { throw new Error("spawn boom"); }) as any });
		const job = start(m, "echo hi", root);
		expect(job).toMatchObject({ status: "failed", error: "spawn boom" });
		expect(m.runningCount("s1")).toBe(0);
	});

	test("max_runtime terminates the job", async () => {
		const root = tempDir();
		const m = manager(root);
		const job = m.start({ sessionKey: "s1", command: "sleep 30", cwd: root, env: process.env, shell: "/bin/sh", shellArgs: ["-c"], maxRuntimeMs: 150 });
		const done = await m.waitFor("s1", job.id, 5000);
		expect(done!.status).toBe("killed");
		expect(m.read("s1", job.id, { since: 0 }).text).toContain("max_runtime");
	});

	test("finds an orphan left by a crashed owner, reports it and kills only on request", async () => {
		const root = tempDir();
		const sessionDir = path.join(root, "crashed-session");
		fs.mkdirSync(sessionDir, { recursive: true });
		const orphanProcess = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
		orphanProcess.unref();
		const pid = orphanProcess.pid!;
		try {
			await until(() => defaultProcessInspector.startTime(pid) !== undefined);
			// Owner pid that no longer exists simulates a crashed host.
			const deadOwner = spawn("/bin/sh", ["-c", "exit 0"]);
			await new Promise((resolve) => deadOwner.once("exit", resolve));
			fs.writeFileSync(path.join(sessionDir, "bg_dead.json"), JSON.stringify({
				jobId: "bg_dead", sessionKey: "crashed-session", pid, command: "sleep 30", startedAt: 1,
				processStart: defaultProcessInspector.startTime(pid), ownerPid: deadOwner.pid, logPath: path.join(sessionDir, "bg_dead.log"),
			}));
			// Stale record whose process is gone is cleaned up silently.
			fs.writeFileSync(path.join(sessionDir, "bg_stale.json"), JSON.stringify({ jobId: "bg_stale", pid: deadOwner.pid, command: "x", ownerPid: deadOwner.pid }));
			const m = manager(root);
			const orphans = m.findOrphans(root);
			expect(orphans.map((orphan) => orphan.jobId)).toEqual(["bg_dead"]);
			expect(fs.existsSync(path.join(sessionDir, "bg_stale.json"))).toBe(false);
			expect(alive(pid)).toBe(true);
			expect(m.killOrphan(orphans[0]!)).toBe(true);
			await until(() => !alive(pid));
			expect(m.findOrphans(root)).toEqual([]);
		} finally {
			try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
		}
	});

	test("a record owned by a live process is not an orphan", async () => {
		const root = tempDir();
		const m = manager(root);
		const job = start(m, "sleep 30", root);
		const other = manager(root, { ownerPid: 999999 });
		expect(other.findOrphans(root)).toEqual([]);
		await m.kill("s1", job.id);
	});
});

describe("background shell helpers", () => {
	test("detects all-interface binds", () => {
		expect(bindsAllInterfaces("npm run dev -- --host 0.0.0.0")).toBe(true);
		expect(bindsAllInterfaces("python -m http.server --bind 0.0.0.0 8000")).toBe(true);
		expect(bindsAllInterfaces("vite --host=0.0.0.0")).toBe(true);
		expect(bindsAllInterfaces("npm run dev")).toBe(false);
		expect(bindsAllInterfaces("vite --host 127.0.0.1")).toBe(false);
	});

	test("layered config with env override", () => {
		const home = tempDir();
		const project = tempDir();
		fs.mkdirSync(path.join(project, ".pi"));
		fs.writeFileSync(path.join(project, ".pi", "pi-tools-suite.jsonc"), `{ // c\n "backgroundShell": { "notifyOnExit": "ui-only", "maxJobsPerSession": 3 } }`);
		expect(loadBackgroundShellConfig(tempDir(), {}, home)).toEqual({ notifyOnExit: "context", maxJobsPerSession: 8 });
		expect(loadBackgroundShellConfig(project, {}, home)).toEqual({ notifyOnExit: "ui-only", maxJobsPerSession: 3 });
		expect(loadBackgroundShellConfig(project, { PI_BACKGROUND_SHELL_NOTIFY_ON_EXIT: "off", PI_BACKGROUND_SHELL_MAX_JOBS: "99" }, home))
			.toEqual({ notifyOnExit: "off", maxJobsPerSession: 3 });
	});
});
