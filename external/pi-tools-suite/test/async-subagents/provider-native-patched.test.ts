import { expect, test } from "bun:test";
import { execFileSync, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { providerSnapshotSource, runOffline, stageSnapshot } from "./provider-offline-harness.ts";
import { applyNativeProviderPatch } from "./provider-native-patch.ts";
import { localNode } from "./provider-offline-rpc.ts";

const snapshotSource = providerSnapshotSource();
const offline = snapshotSource === undefined || process.platform !== "darwin" ? test.skip : test;
const source = fileURLToPath(new URL("./fixtures/provider-native-relay.c", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/provider-relay-cli.mjs", import.meta.url));
const fd = (child: ChildProcess, index: number) => (child.stdio as unknown as Array<NodeJS.ReadableStream & NodeJS.WritableStream>)[index]!;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
	const observed = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)],
		{ timeout: 700, encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C" } });
	if (observed.error) throw observed.error;
	if (observed.status === 1 && !observed.stdout.trim() && !observed.stderr.trim()) return false;
	if (observed.status !== 0 || !observed.stdout.trim()) throw new Error(`Cannot observe fixture ${pid}: ps=${observed.status}; ${observed.stderr}`);
	return !observed.stdout.trim().startsWith("Z");
};
for (const code of [0, 7] as const) {
	offline(`installed Pi RPC + actual patched provider A/B/C exit ${code}`, async () => {
		const { rpc, calls } = await runOffline(snapshotSource!, code, true);
		expect(calls).toHaveLength(4);
		expect(calls.filter((call) => call.args.includes("--input-format"))).toHaveLength(1);
		const answer = rpc.findLast((record) => record.type === "message_end" && record.message?.role === "assistant");
		expect(answer?.message?.stopReason).toBe(code === 0 ? "stop" : "error");
		expect(rpc.find((record) => record.id === "prompt")?.success).toBe(true);
	}, 30_000);
}
async function until(predicate: () => boolean, label: string) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) { if (predicate()) return; await sleep(20); }
	throw new Error(`Timeout ${label}`);
}

async function checkpoint(child: ChildProcess, command: string, expected: string): Promise<void> {
	const receipt = fd(child, 6);
	await new Promise<void>((resolve, reject) => {
		let text = "";
		const timer = setTimeout(() => finish(new Error(`Timed out waiting for checkpoint ${expected}`)), 5_000);
		function finish(error?: Error) {
			clearTimeout(timer);
			receipt.off("data", data); receipt.off("error", fail); receipt.off("close", closed);
			if (error) reject(error); else resolve();
		}
		const fail = (error: Error) => finish(error);
		const closed = () => finish(new Error("Checkpoint stream closed"));
		const data = (chunk: Buffer) => { text += chunk.toString(); if (text === expected) finish(); else if (!expected.startsWith(text)) finish(new Error(`Bad checkpoint: ${text}`)); };
		receipt.on("data", data); receipt.once("error", fail); receipt.once("close", closed);
		fd(child, 5).write(command);
	});
}

offline("patched spawnClaudeProcess: real A/B/C, natural 0 and 7, resistant leaf dead before cleanup", async () => {
	const work = mkdtempSync(join(tmpdir(), "patched-provider-native-"));
	const actors: ChildProcess[] = [];
	let completed = false;
	try {
		stageSnapshot(snapshotSource!.snapshot, work, snapshotSource!.pinned);
		applyNativeProviderPatch(join(work, "provider"));
		const binary = join(work, "relay");
		execFileSync("clang", ["-std=c11", "-D_DARWIN_C_SOURCE", "-Wall", "-Wextra", "-Werror", "-O2", source, "-o", binary], { timeout: 10_000 });
		const { spawnClaudeProcess, settleFailure } = await import(pathToFileURL(join(work, "provider/src/claude-process.ts")).href);
		const { superviseProcess } = await import(pathToFileURL(join(work, "provider/src/process-utils.ts")).href);
		let sequence = 0;
		const start = async (code: number, config: { idle?: number; total?: number; stdin?: "pipe" | "ignore"; signal?: AbortSignal; beforeReady?: () => void } = {}) => {
			const dir = join(work, `case-${sequence++}`);
			const { mkdirSync } = await import("node:fs"); mkdirSync(dir);
			const failures: Error[] = [];
			const run = spawnClaudeProcess({ installation: { executable: localNode(), version: "2.1.281", subscriptionType: "pro" },
				args: [fixture, "cli", dir, String(code)], directory: dir, stdin: config.stdin ?? "pipe", idleTimeoutMs: config.idle ?? 8_000,
				totalTimeoutMs: config.total ?? 15_000, env: { PI_PROVIDER_TEST_NATIVE_RELAY: binary }, signal: config.signal,
				supervise: (child: ChildProcess, options: { terminate?: unknown }) => {
					if (!options.terminate) throw new Error("Patched provider failed to inject native cleanup into supervisor");
					return superviseProcess(child, options);
				},
				onFailure: (error: Error) => failures.push(error) });
			actors.push(run.child);
			config.beforeReady?.();
			if (config.beforeReady) return { run, dir, leaf: 0, failures };
			await until(() => ["cli", "leaf"].every((name) => { try { return Number(readFileSync(join(dir, name), "utf8")) > 0; } catch { return false; } }), "actors ready");
			const leaf = Number(readFileSync(join(dir, "leaf"), "utf8"));
			return { run, dir, leaf, failures };
		};
		const gone = async (leaf: number) => until(() => !alive(leaf), "resistant leaf dead before harness cleanup");
		for (const code of [0, 7]) {
			const { run, dir, leaf, failures } = await start(code);
			run.child.stdin!.end(); // normal provider stdin EOF is not cancellation
			writeFileSync(join(dir, "complete"), "1");
			const result = await run.supervisor.wait();
			expect(result.code).toBe(code);
			await run.terminate(); // post-exit cached receipt, never numeric signal
			await gone(leaf);
			expect(failures).toHaveLength(0);
			run.dispose();
		}
		{
			const { run, dir, leaf } = await start(0, { stdin: "ignore" });
			expect(run.child.stdin).toBeNull();
			writeFileSync(join(dir, "complete"), "1");
			expect((await run.supervisor.wait()).code).toBe(0);
			await run.terminate(); await gone(leaf); run.dispose();
		}
		// Native cleanup completes but the test-only fd5 checkpoint withholds
		// its receipt. Provider must not infer safety from A's successful exit.
		{
			const { run, dir, leaf } = await start(0);
			await checkpoint(run.child, "R", "R");
			writeFileSync(join(dir, "complete"), "1");
			expect((await run.supervisor.wait()).code).toBe(0);
			const failure = await run.terminate().catch((error: Error) => error);
			expect(failure.name).toBe("ProcessTerminationError");
			expect((await settleFailure(run, failure, failure.message, "retained")).livenessUnknown).toBe(true);
			await gone(leaf); run.dispose();
		}
		// Fault injected after safe group cleanup must never issue CLEAN:98.
		{
			const { run, dir, leaf } = await start(0);
			await checkpoint(run.child, "F", "F");
			writeFileSync(join(dir, "complete"), "1");
			expect((await run.supervisor.wait()).code).toBe(98);
			const failure = await run.terminate().catch((error: Error) => error);
			expect(failure.name).toBe("ProcessTerminationError");
			expect(failure.message).toContain("FAILED:98");
			expect((await settleFailure(run, failure, failure.message, "retained")).livenessUnknown).toBe(true);
			await gone(leaf); run.dispose();
		}
		// Cancellation before either actor reports ready (no PID from disk): the
		// relay must still prove its whole subtree dead — synthetic exit 90 with
		// a matching CLEAN receipt — before termination may resolve.
		{
			const abort = new AbortController();
			const { run } = await start(0, { signal: abort.signal, beforeReady: () => abort.abort() });
			await run.supervisor.wait().catch(() => undefined);
			expect(run.child.exitCode).toBe(90);
			await run.terminate();
			run.dispose();
		}
		// A's private control EOF models abrupt P loss; no stdin dependency.
		{
			const { run, leaf } = await start(0);
			fd(run.child, 3).end();
			expect((await run.supervisor.wait()).code).not.toBe(0);
			await run.terminate(); await gone(leaf); run.dispose();
		}
		// A SIGKILL is addressed through our live direct ChildProcess. B alone
		// observes its liveness EOF and kills its own group.
		{
			const { run, leaf } = await start(0);
			expect(run.child.kill("SIGKILL")).toBe(true);
			await run.supervisor.wait(); await gone(leaf);
			await expect(run.terminate()).rejects.toThrow();
			run.dispose();
		}
		// Joint P-control loss + A SIGKILL does not kill B: its inherited
		// liveness reader still sees A's sole writer close and self-cleans.
		{
			const { run, leaf } = await start(0);
			expect(run.child.kill("SIGKILL")).toBe(true);
			fd(run.child, 3).end();
			await run.supervisor.wait(); await gone(leaf);
			await expect(run.terminate()).rejects.toThrow(); run.dispose();
		}
		// B is killed only by A while A holds B as an unreaped direct child.
		{
			const { run, leaf } = await start(0);
			fd(run.child, 5).write("K");
			expect((await run.supervisor.wait()).code).not.toBe(0);
			await run.terminate(); await gone(leaf); run.dispose();
		}
		// C's status has reached A while A still holds its direct waitable B.
		{
			const { run, dir, leaf } = await start(0);
			await checkpoint(run.child, "H", "H");
			writeFileSync(join(dir, "complete"), "1");
			await new Promise<void>((resolve, reject) => {
				const stream = fd(run.child, 6);
				const timer = setTimeout(() => reject(new Error("Timed out waiting for C status")), 5_000);
				stream.once("data", (chunk: Buffer) => { clearTimeout(timer); chunk.toString() === "S" ? resolve() : reject(new Error("Bad C status checkpoint")); });
			});
			expect(run.child.exitCode).toBeNull();
			fd(run.child, 5).write("K");
			expect((await run.supervisor.wait()).code).toBe(0);
			await run.terminate(); await gone(leaf); run.dispose();
		}
		for (const config of [{ idle: 300, total: 8_000 }, { idle: 8_000, total: 300 }]) {
			const { run, leaf, failures } = await start(0, config);
			await until(() => failures.length > 0, "supervisor timeout");
			expect(failures[0]?.message).toContain(config.idle === 300 ? "no protocol activity" : "request exceeded");
			expect((await run.supervisor.wait()).code).not.toBe(0);
			await run.terminate(); await gone(leaf); run.dispose();
		}
		// Aborting one concurrently active request must not close the other's fd3.
		{
			const abort = new AbortController();
			const first = await start(0, { signal: abort.signal });
			const second = await start(7);
			abort.abort();
			expect((await first.run.supervisor.wait()).code).not.toBe(0);
			await first.run.terminate(); await gone(first.leaf); first.run.dispose();
			expect(alive(second.leaf)).toBe(true);
			writeFileSync(join(second.dir, "complete"), "1");
			expect((await second.run.supervisor.wait()).code).toBe(7);
			await second.run.terminate(); await gone(second.leaf); second.run.dispose();
		}
		completed = true;
	} finally {
		for (const child of actors) {
			try { fd(child, 3).end(); } catch { /* already closed */ }
			if (child.exitCode === null && child.signalCode === null) {
				const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
				await Promise.race([closed, sleep(2_000)]);
				if (child.exitCode === null && child.signalCode === null) {
					// Only the live direct ChildProcess handle, never a recorded PID.
					child.kill("SIGKILL");
					await Promise.race([closed, sleep(2_000)]);
				}
			}
		}
		// No recorded PID is signaled. Preserve evidence on any failure.
		if (completed && actors.every((child) => child.exitCode !== null || child.signalCode !== null)) rmSync(work, { recursive: true, force: true });
		else console.error(`Native fixture retained for investigation: ${work}`);
	}
}, 80_000);
