import { expect, test } from "bun:test";
import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stageSnapshot } from "./provider-offline-harness.ts";
import { applyNativeProviderPatch } from "./provider-native-patch.ts";
import { localNode } from "./provider-offline-rpc.ts";

const snapshot = process.env.PI_CLAUDE_PROVIDER_OFFLINE_SNAPSHOT;
const offline = snapshot && process.platform === "darwin" ? test : test.skip;
const source = fileURLToPath(new URL("./fixtures/provider-native-relay.c", import.meta.url));
const cli = fileURLToPath(new URL("./fixtures/provider-boundary-cli.mjs", import.meta.url));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function ps(pid: number): { state: string; group: number } | undefined {
	const result = spawnSync("/bin/ps", ["-o", "stat=,pgid=", "-p", String(pid)],
		{ encoding: "utf8", timeout: 700, env: { PATH: "/usr/bin:/bin", LANG: "C" } });
	if (result.error) throw result.error;
	if (result.status === 1 && !result.stdout.trim() && !result.stderr.trim()) return undefined;
	if (result.status !== 0) throw new Error(`ps failed: ${result.stderr}`);
	const [state, group] = result.stdout.trim().split(/\s+/);
	if (!state || !Number(group)) throw new Error(`Invalid ps output: ${result.stdout}`);
	return { state, group: Number(group) };
}
const live = (pid: number) => { const actor = ps(pid); return !!actor && !actor.state.startsWith("Z"); };
async function until(check: () => boolean, label: string, ms = 5_000) {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (check()) return; await sleep(20); }
	throw new Error(`Deadline: ${label}`);
}
const fd = (child: ChildProcess, i: number) => (child.stdio as unknown as Array<NodeJS.ReadableStream & NodeJS.WritableStream>)[i]!;

for (const topology of ["joint", "escape"] as const) {
	offline(`isolated provider relay boundary: ${topology} leaves a live actor before test-owned cleanup`, async () => {
		const work = mkdtempSync(join(tmpdir(), "provider-boundary-"));
		let run: any;
		let clean = false;
		let cliPid = 0, leafPid = 0;
		let cliAt = 0, leafAt = 0;
		const sockets = new Set<Socket>();
		const server = createServer((socket) => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); });
		const socketPath = join(work, "release.sock");
		try {
			await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
			stageSnapshot(snapshot!, work);
			applyNativeProviderPatch(join(work, "provider"));
			const binary = join(work, "relay");
			let relay = readFileSync(source, "utf8");
			if (topology === "joint") {
				// Only this private compiled copy changes: A kills its *direct waitable*
				// B, ACKs and stops before A can perform its ordinary group cleanup.
				const anchor = "if (command == 'K') { if (kill(b, SIGKILL) && errno != ESRCH) bad = 1; break; }";
				if (relay.split(anchor).length !== 2) throw new Error("Relay checkpoint anchor changed");
				relay = relay.replace(anchor, "if (command == 'K') { if (kill(b, SIGKILL) && errno != ESRCH) bad = 1; if (put(6, \"K\", 1)) _exit(98); raise(SIGSTOP); break; }");
			}
			const copy = join(work, "relay.c"); writeFileSync(copy, relay);
			execFileSync("clang", ["-std=c11", "-D_DARWIN_C_SOURCE", "-Wall", "-Wextra", "-Werror", "-O2", copy, "-o", binary], { timeout: 10_000 });
			const { spawnClaudeProcess } = await import(pathToFileURL(join(work, "provider/src/claude-process.ts")).href);
			const { superviseProcess } = await import(pathToFileURL(join(work, "provider/src/process-utils.ts")).href);
			const dir = join(work, "case"); mkdirSync(dir);
			run = spawnClaudeProcess({ installation: { executable: localNode(), version: "2.1.281", subscriptionType: "pro" },
				args: [cli, "cli", dir, socketPath, topology], directory: dir, stdin: "pipe", idleTimeoutMs: 8_000,
				totalTimeoutMs: 15_000, env: { PI_PROVIDER_TEST_NATIVE_RELAY: binary },
				supervise: (child: ChildProcess, options: object) => superviseProcess(child, options), onFailure: () => {} });
			await until(() => ["cli", "leaf"].every((name) => { try { return Number(readFileSync(join(dir, name), "utf8")) > 0; } catch { return false; } }) && sockets.size === 2, "actors and cleanup sockets ready");
			cliPid = Number(readFileSync(join(dir, "cli"), "utf8"));
			leafPid = Number(readFileSync(join(dir, "leaf"), "utf8"));
			cliAt = Number(readFileSync(join(dir, "cli-at"), "utf8"));
			leafAt = Number(readFileSync(join(dir, "leaf-at"), "utf8"));
			const c = ps(cliPid)!, d = ps(leafPid)!;
			expect(live(cliPid) && live(leafPid)).toBe(true);
			if (topology === "joint") {
				expect(d.group).toBe(c.group); // Both are in B's group before fault.
				const ack = new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error("A joint-loss checkpoint deadline")), 4_000);
					fd(run.child, 6).once("data", (data: Buffer) => { clearTimeout(timer); data.toString() === "K" ? resolve() : reject(new Error("Bad A checkpoint")); });
				});
				fd(run.child, 5).write("K"); await ack;
				await until(() => !live(c.group), "B killed while A is stopped");
				// A is the directly owned ChildProcess, not a number read from disk.
				expect(run.child.kill("SIGKILL")).toBe(true);
				await until(() => run.child.signalCode === "SIGKILL", "direct A loss");
				// C still owns stdout: waiting for stdout drain here would defer the
				// counterexample until its watchdog. Termination must fail closed.
				await expect(run.terminate()).rejects.toThrow();
				expect(live(cliPid) && live(leafPid)).toBe(true);
			} else {
				expect(d.group).not.toBe(c.group);
				expect(d.group).toBe(leafPid); // detached:true starts a new session/group
				writeFileSync(join(dir, "complete"), "1");
				expect((await run.supervisor.wait()).code).toBe(0);
				await run.terminate(); // CLEAN receipt covers B group, not escaped D.
				await until(() => !live(cliPid), "C exited normally");
				expect(live(leafPid)).toBe(true);
			}
			// Assertions above precede test cleanup and both actors' watchdogs.
			expect(Date.now() - cliAt).toBeLessThan(12_000);
			expect(Date.now() - leafAt).toBeLessThan(14_000);
			for (const socket of sockets) socket.end();
			await until(() => !live(cliPid) && !live(leafPid), "cleanup EOF removed both actors");
			if (topology === "joint") await run.supervisor.wait().catch(() => undefined);
			clean = true;
		} finally {
			for (const socket of sockets) socket.end();
			if (run) {
				try { fd(run.child, 3).end(); } catch { /* closed */ }
				if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL"); // direct child only
				await Promise.race([new Promise<void>((resolve) => run.child.once("close", resolve)), sleep(2_000)]);
				run.dispose();
			}
			await Promise.race([new Promise<void>((resolve) => server.close(() => resolve())), sleep(2_000)]);
			if (cliPid && leafPid) await until(() => !live(cliPid) && !live(leafPid), "fixture teardown", 19_000);
			if (clean) rmSync(work, { recursive: true, force: true });
			else console.error(`Boundary fixture retained: ${work}`);
		}
	}, 40_000);
}
