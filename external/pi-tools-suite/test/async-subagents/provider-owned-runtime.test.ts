// Opt-in G1/T3 end-to-end OFFLINE integration of the REAL core runtime:
// core/spawnAgent through the production native owned-launch route (never the
// ownedLaunchForTest unit boundary) plus stop/state/cleanup integration, for a
// selected pi-claude-code-provider model. Runs the real installed Pi SDK
// 0.99.0 under the real local Node, and the hash-verified UNMODIFIED provider
// 0.5.0 snapshot staged by stageSnapshot (default native=false), reusing the
// offline fixture protocol from the launcher acceptance suite. No auth, no provider
// install, no live inference. Every kill action addresses only an owned direct
// bridge, its exact UUID launchctl jobs, or this test's own control process;
// fixture PIDs are used only for read-only ps observations.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { deleteRunDirs, findCleanupCandidates } from "../../src/async-subagents/core/cleanup.js";
import { readOwnedMetadata, requestOwnedCancel, verifiedOwnedDrainSync } from "../../src/async-subagents/core/owned-launch-integration.js";
import { ensureOwnedLaunchBinaries } from "../../src/async-subagents/core/owned-launch/bootstrap.js";
import { spawnAgent } from "../../src/async-subagents/core/spawn.js";
import { getAgentState, getRunState } from "../../src/async-subagents/core/state.js";
import { stopAgents } from "../../src/async-subagents/core/stop.js";
import { stageSnapshot } from "./provider-offline-harness.ts";
import { localNode } from "./provider-offline-rpc.ts";

const snapshot = process.env.PI_CLAUDE_PROVIDER_OFFLINE_SNAPSHOT;
const enabled = process.platform === "darwin" && process.env.PI_OFFLINE_COALITION_PROBE === "1" && snapshot !== undefined;
const offline = enabled ? test : test.skip;
const root = join(fileURLToPath(new URL("../..", import.meta.url)), "../..");
const piCli = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const fixture = fileURLToPath(new URL("./provider-owned-runtime-cli.mjs", import.meta.url));
const domain = `gui/${process.getuid?.()}`;
const sleep = (ms: number) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms));
const ctl = (args: string[]) => spawnSync("/bin/launchctl", args, { timeout: 3000, encoding: "utf8" });
function service(label: string): boolean {
	const result = ctl(["print", `${domain}/${label}`]);
	if (result.error) throw result.error;
	if (result.status === 0) return true;
	if (result.status === 113 && result.stderr.includes(`Could not find service "${label}"`)) return false;
	throw new Error(`ambiguous launchctl print ${label}: ${result.status} ${result.stderr}`);
}
type Marker = { pid: number; token: string; at: number; [key: string]: any };
const markers = (home: string, name: string): Marker[] => {
	try {
		return readdirSync(home).filter((file) => file.startsWith(`provider-owned-${name}-`) && file.endsWith(".json"))
			.map((file) => JSON.parse(readFileSync(join(home, file), "utf8")));
	} catch { return []; }
};
const receipt = (path: string) => Object.fromEntries([...readFileSync(path, "utf8").matchAll(/([a-z_]+)=(\S+)/g)]
	.map((match) => [match[1], match[2]]));

// The fixture token is in the leaf's argv. If ps sees an unrelated PID
// incarnation it is never treated as a fixture, nor ever signaled.
function leafAlive(marker: Marker | undefined): boolean {
	if (!marker) return false;
	const observed = spawnSync("/bin/ps", ["-o", "stat=", "-o", "command=", "-p", String(marker.pid)],
		{ timeout: 3000, encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C" } });
	if (observed.error) throw observed.error;
	if (observed.status === 1 && !observed.stdout.trim()) return false;
	if (observed.status !== 0) throw new Error(`ambiguous ps(${marker.pid}): ${observed.status} ${observed.stderr}`);
	if (!observed.stdout.includes(marker.token)) return false;
	return !observed.stdout.trim().startsWith("Z");
}
async function until(predicate: () => boolean, ms: number, label: string | (() => string)) {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (predicate()) return; await sleep(40); }
	throw new Error(`deadline: ${typeof label === "function" ? label() : label}`);
}

type EventRecord = Record<string, any>;
interface CompletionRecord { exitCode: number; status: string; at: number; drainValid: boolean; leafGone: boolean }
interface Run {
	id: string;
	home: string;
	runDir: string;
	agentDir: string;
	events: EventRecord[];
	completions: CompletionRecord[];
	spawned: ReturnType<typeof spawnAgent>;
	meta(): ReturnType<typeof readOwnedMetadata>;
}
interface Context { work: string; extension: string; node: string; binaries: Awaited<ReturnType<typeof ensureOwnedLaunchBinaries>>; runs: Run[] }

// getPiInvocation resolves the payload command for a generic test runtime as
// the bare name "pi". The native worker resolves an executable shim in a
// separate bin directory on PATH, as for an installed Pi CLI. The shim runs
// the real installed SDK CLI under the real local Node.
function withIsolatedEnv<T>(env: Record<string, string>, body: () => T): T {
	const saved = { ...process.env };
	for (const key of Object.keys(process.env)) delete process.env[key];
	Object.assign(process.env, env);
	try { return body(); } finally {
		for (const key of Object.keys(process.env)) delete process.env[key];
		Object.assign(process.env, saved);
	}
}

function start(ctx: Context, options: { id: string; mode: "hold" | "exit0" | "exit7"; runDir?: string; timeoutMs?: number }): Run {
	const { id, mode } = options;
	const runDir = options.runDir ?? join(ctx.work, `runs-${id}`);
	const home = join(ctx.work, `home-${id}`), agentConf = join(ctx.work, `agentdir-${id}`), cwd = join(ctx.work, `cwd-${id}`);
	const bin = join(ctx.work, `bin-${id}`);
	for (const dir of [home, agentConf, cwd, bin]) mkdirSync(dir, { mode: 0o700 });
	writeFileSync(join(agentConf, "settings.json"), JSON.stringify({ retry: { enabled: false }, enableInstallTelemetry: false,
		enableAnalytics: false, extensions: [], packages: [], skills: [], prompts: [], themes: [], defaultTools: [] }));
	writeFileSync(join(bin, "pi"), `#!/bin/sh\nprintf 'started\\n' > "$HOME/pi-shim-started"\nexec "${ctx.node}" "${piCli}" "$@"\n`);
	chmodSync(join(bin, "pi"), 0o755);
	// The unchanged provider deliberately allowlists the child's environment.
	// Its CLI path is an executable, so configure this fake peer at that CLI
	// boundary instead of pretending OWNED_FAKE_MODE survives the allowlist.
	const claude = join(bin, "claude-offline");
	writeFileSync(claude, `#!/bin/sh\nexport OWNED_FAKE_MODE=${mode}\nexec "${ctx.node}" "${fixture}" "$@"\n`);
	chmodSync(claude, 0o755);
	// No ambient auth, proxy, NODE_OPTIONS, or Pi config reaches the payload.
	// TMPDIR stays the ambient short per-user dir: the owned-launch sockets
	// fallback is placed under os.tmpdir() during the synchronous launch, and
	// a long work-path TMPDIR would exceed the 104-byte sun_path limit and
	// fail the bridge closed (bind errno; no supervisor is ever created).
	const env = { HOME: home, PI_CODING_AGENT_DIR: agentConf, PI_CODING_AGENT_SESSION_DIR: join(ctx.work, `sessions-${id}`),
		PI_CLAUDE_CODE_PROVIDER_PATH: claude, PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PATH: `${bin}:${dirname(ctx.node)}:/usr/bin:/bin`,
		TMPDIR: tmpdir(), LANG: "C", NO_COLOR: "1" };
	const events: EventRecord[] = [];
	const completions: CompletionRecord[] = [];
	const agentDir = join(runDir, id);
	const spawned = withIsolatedEnv(env, () => spawnAgent(runDir, { id, task: "offline containment probe", model: "pi-claude-code-provider/sonnet" }, cwd, [
		"--offline", "--no-approve", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools", "--extension", ctx.extension,
	], (event) => { events.push(event); }, (completion) => {
		completions.push({ exitCode: completion.exitCode, status: String(completion.state?.status ?? "?"), at: Date.now(),
			drainValid: verifiedOwnedDrainSync(agentDir), leafGone: !leafAlive(markers(home, "leaf")[0]) });
	}, { ownedBinaries: ctx.binaries, timeoutMs: options.timeoutMs ?? 240000 }));
	const run: Run = { id, home, runDir, agentDir, events, completions, spawned, meta() { return readOwnedMetadata(this.agentDir); } };
	ctx.runs.push(run);
	return run;
}

function diag(run: Run): string {
	let out = "";
	try { out += `stderr=${readFileSync(join(run.agentDir, "stderr.log"), "utf8").slice(-4000)};`; } catch { /* not flushed yet */ }
	try { out += `progress=${readFileSync(join(run.agentDir, "progress.jsonl"), "utf8").split("\n").filter(Boolean).slice(-6).join("|").slice(0, 1500)};`; } catch { /* optional */ }
	const meta = run.meta();
	if (meta) for (const file of ["bridge.json", "worker.json", "gate-handoff", "gate.err", "gate-exit.json", "sup.err", "job.err", "payload-exit.json", "drain.json"]) {
		try { out += `${file}=${readFileSync(join(meta.runDir, file), "utf8").slice(-500)};`; } catch { /* not yet written */ }
	}
	if (meta) {
		try {
			const pid = Number(receipt(join(meta.runDir, "worker.json")).pid);
			const observed = spawnSync("/bin/ps", ["-axo", "pid,ppid,command"], { encoding: "utf8", timeout: 3000 });
			out += `workerProcesses=${observed.stdout.split("\n").filter((line) => line.includes(String(pid)) || line.includes(run.home)).slice(0, 12).join("|")};`;
		} catch { /* worker not yet published */ }
	}
	out += `shim=${existsSync(join(run.home, "pi-shim-started"))};`;
	out += `events=${run.events.length} last=${JSON.stringify(run.events.slice(-3)).slice(0, 1200)}`;
	return out;
}

async function completion(run: Run, ms = 60000): Promise<CompletionRecord> {
	await until(() => run.completions.length > 0, ms, `core completion callback ${diag(run)}`);
	return run.completions[0];
}

function released(run: Run): boolean {
	const meta = run.meta();
	return !!meta && existsSync(join(meta.runDir, "owned.json")) && existsSync(join(meta.runDir, "release")) &&
		existsSync(join(meta.runDir, "gate-handoff"));
}

// Terminal state is only acceptable with a journal-bound drain receipt, the
// escaped fixture actor already gone (before its independent watchdog), the
// exact UUID jobs booted out, and exit_code ordered after the receipt.
async function settled(run: Run, expected: { exitCodeFile: string; status: NonNullable<ReturnType<typeof getAgentState>>["status"]; causes: string[]; payloadCode?: number }) {
	const meta = run.meta();
	expect(meta).toBeDefined();
	await until(() => verifiedOwnedDrainSync(run.agentDir), 10000, `journal-bound drain receipt ${run.agentDir} ${diag(run)}`);
	const data = receipt(join(meta!.runDir, "drain.json"));
	expect(data.status).toBe("ok");
	expect(expected.causes).toContain(data.cause);
	if (expected.payloadCode !== undefined) expect(Number(receipt(join(meta!.runDir, "payload-exit.json")).code)).toBe(expected.payloadCode);
	const exitCodeFile = join(run.agentDir, "exit_code");
	expect(existsSync(exitCodeFile)).toBe(true);
	expect(statSync(exitCodeFile).mtimeMs).toBeGreaterThanOrEqual(statSync(join(meta!.runDir, "drain.json")).mtimeMs);
	expect(readFileSync(exitCodeFile, "utf8")).toBe(expected.exitCodeFile);
	expect(getAgentState(run.runDir, run.id)?.status).toBe(expected.status);
	const leaf = markers(run.home, "leaf")[0];
	expect(leafAlive(leaf)).toBe(false);
	expect(Date.now()).toBeLessThan(leaf.at + 70000);
	await until(() => !service(meta!.labelSupervisor) && !service(meta!.labelWorker), 12000, "exact UUID jobs booted out");
}

async function scenario(name: string, body: (ctx: Context) => Promise<void>): Promise<void> {
	const work = mkdtempSync(join(tmpdir(), "provider-owned-runtime-"));
	const runs: Run[] = [];
	let passed = false;
	try {
		const installed = JSON.parse(readFileSync(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
		if (installed.version !== "0.99.0") throw new Error(`Expected installed Pi SDK 0.99.0, found ${installed.version}`);
		const ctx: Context = { work, extension: stageSnapshot(snapshot!, work), node: localNode(),
			binaries: await ensureOwnedLaunchBinaries({ cacheRoot: join(work, "cache") }), runs };
		await body(ctx);
		passed = true;
	} finally {
		for (const run of runs) {
			try { writeFileSync(join(run.agentDir, "probe-events.json"), JSON.stringify({ events: run.events, completions: run.completions }, null, 2)); } catch { /* retained dir may be gone */ }
		}
		if (passed) rmSync(work, { recursive: true, force: true });
		else {
			// Failed assertions must not strand our own supervised fixture until
			// its watchdog: request cancellation using only our durable UUID metadata.
			for (const run of runs) {
				try {
					if (run.meta() && !verifiedOwnedDrainSync(run.agentDir)) {
						requestOwnedCancel(run.agentDir);
						await until(() => verifiedOwnedDrainSync(run.agentDir) && !leafAlive(markers(run.home, "leaf")[0]),
							35000, `failed-test owned cleanup ${diag(run)}`);
					}
			} catch (error) { console.error(`${name}: owned UUID cancellation pending: ${String(error)}`); }
			}
			console.error(`${name}: retained evidence: ${work}; ${runs.map((r) => `${r.agentDir} ${r.meta()?.labelSupervisor ?? "?"} ${r.meta()?.labelWorker ?? "?"}`).join("; ")}`);
		}
	}
}

// The provider request must be observable through the whole core route with a
// detached, TERM-resistant fixture leaf, exactly as in the launcher suite.
async function requestedLeaf(run: Run) {
	await until(() => markers(run.home, "request").length === 1 && markers(run.home, "leaf").length === 1,
		25000, () => `real provider request and detached leaf ${diag(run)}`);
	const request = markers(run.home, "request")[0], leaf = markers(run.home, "leaf")[0];
	expect(request.leafPid).toBe(leaf.pid);
	expect(request.env.ANTHROPIC_API_KEY).toBeNull();
	expect(request.env.CLAUDE_CODE_OAUTH_TOKEN).toBeNull();
	expect(request.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
	expect(request.args).toContain("--input-format");
	expect(markers(run.home, "start")).toHaveLength(5); // 3 preflights + request + leaf
	expect(leafAlive(leaf)).toBe(true);
	const ps = spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(leaf.pid)], { encoding: "utf8", timeout: 3000 });
	expect(ps.status).toBe(0);
	expect(Number(ps.stdout.trim())).toBe(leaf.pid); // detached setsid escapee
	expect(existsSync(join(run.agentDir, "process_group"))).toBe(false); // owned stop can never tree-kill by stale PID
	return leaf;
}

for (const code of [0, 7] as const) {
	offline(`provider-owned core runtime: real spawnAgent natural fake exit ${code} settles only on bound receipt`, async () => scenario(`natural-${code}`, async (ctx) => {
		const run = start(ctx, { id: "agent", mode: code === 0 ? "exit0" : "exit7" });
		// Deterministically before any payload work: while the owned coalition
		// exists, state stays running and cleanup refuses the undrained run.
		expect(getAgentState(run.runDir, run.id)?.status).toBe("running");
		expect(findCleanupCandidates(dirname(run.runDir), 0, 0)).toEqual([]);
		expect(() => deleteRunDirs([run.runDir])).toThrow("not verified drained and retired");
		await requestedLeaf(run);
		const done = await completion(run);
		expect(done.drainValid).toBe(true); // callback fires only after a verified bound receipt
		expect(done.leafGone).toBe(true); // escaped actor gone before terminal state
		expect(done.exitCode).toBe(code === 0 ? 0 : 1); // provider error is surfaced as failure, never success
		const end = run.events.findLast((event) => event.type === "message_end" && event.message?.role === "assistant");
		expect(end?.message?.stopReason).toBe(code === 0 ? "stop" : "error");
		if (code === 0) expect(readFileSync(join(run.agentDir, "result.md"), "utf8")).toContain("OFFLINE_PROVIDER_OK");
		const request = markers(run.home, "request")[0];
		expect(markers(run.home, "exit").find((marker) => marker.token === request.token)?.code).toBe(code);
		// RPC Pi remains alive after agent_end; core cancels it intentionally.
		// The fake Claude exit above is not the launcher's Pi payload exit.
		await settled(run, code === 0 ? { exitCodeFile: "0", status: "done", causes: ["cancel", "leader_exit"] }
			: { exitCodeFile: "1", status: "failed", causes: ["cancel", "leader_exit"] });
		// Stop after a terminal state is a no-op, never another cancel.
		const stop = stopAgents(run.runDir, [run.id])[0];
		expect(stop.stopped).toBe(false);
		expect(stop.message).toContain(`agent is ${code === 0 ? "done" : "failed"}`);
		// Cleanup integration now accepts and removes the drained run.
		expect(findCleanupCandidates(dirname(run.runDir), 0, 0)).toEqual([run.runDir]);
		deleteRunDirs([run.runDir]);
		expect(existsSync(run.runDir)).toBe(false);
	}), 120000);
}

offline("provider-owned core runtime: forced bridge loss stays pending until the bound drain receipt", async () => scenario("force", async (ctx) => {
	const run = start(ctx, { id: "agent", mode: "hold" });
	await requestedLeaf(run);
	await until(() => released(run), 12000, `durably owned and released before fault ${diag(run)}`);
	run.spawned.process.kill("SIGKILL"); // our own direct bridge only
	const done = await completion(run);
	expect(done.drainValid).toBe(true);
	expect(done.leafGone).toBe(true);
	expect(done.exitCode).toBe(1);
	expect(existsSync(join(run.agentDir, "stop_requested"))).toBe(false);
	await settled(run, { exitCodeFile: "1", status: "failed", causes: ["cancel"] });
}), 120000);

offline("provider-owned core runtime: timeout publishes 124 only after the bound drain receipt", async () => scenario("timeout", async (ctx) => {
	const run = start(ctx, { id: "agent", mode: "hold", timeoutMs: 30000 });
	await requestedLeaf(run);
	await until(() => existsSync(join(run.agentDir, "timed_out_at")) && existsSync(join(run.agentDir, "timeout_ms")), 38000, () => `timeout markers ${diag(run)}`);
	const done = await completion(run);
	expect(done.drainValid).toBe(true);
	expect(done.leafGone).toBe(true);
	expect(done.exitCode).toBe(124);
	expect(readFileSync(join(run.agentDir, "result.md"), "utf8")).toContain("timed out after 30 seconds");
	expect(existsSync(join(run.agentDir, "stop_requested"))).toBe(false); // timeout is not a stop
	await settled(run, { exitCodeFile: "124", status: "failed", causes: ["cancel"] });
}), 120000);

offline("provider-owned core runtime: concurrent stop from reconstructed disk state never signals a stale PID or the peer run", async () => scenario("stop-concurrent", async (ctx) => {
	const runDir = join(ctx.work, "runs");
	const a = start(ctx, { id: "a", mode: "hold", runDir });
	const b = start(ctx, { id: "b", mode: "hold", runDir });
	const [leafA, leafB] = await Promise.all([requestedLeaf(a), requestedLeaf(b)]);
	await until(() => released(a) && released(b), 12000, "both runs bound and released");
	const metaA = a.meta()!, metaB = b.meta()!;
	expect(metaA.labelSupervisor).not.toBe(metaB.labelSupervisor);
	expect(getRunState(runDir, ["a", "b"]).agents.map((agent) => agent.status)).toEqual(["running", "running"]);
	const control = Bun.spawn(["/bin/sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	try {
		// Simulate a parent restart: the saved pid now names an unrelated live
		// process. The owned stop route must reconstruct everything else from
		// disk (owned_launch metadata + durable cancel), never this PID.
		writeFileSync(join(a.agentDir, "pid"), String(control.pid), "utf-8");
		const stop = stopAgents(runDir, ["a"])[0];
		expect(stop.stopped).toBe(false);
		expect(stop.message).toContain("drain pending");
		expect(readFileSync(join(a.agentDir, "stop_signal"), "utf-8")).toBe("SIGTERM");
		expect(existsSync(join(metaA.runDir, "cancel"))).toBe(true);
		const done = await completion(a);
		expect(done.drainValid).toBe(true);
		expect(done.leafGone).toBe(true);
		await settled(a, { exitCodeFile: "stopped", status: "stopped", causes: ["cancel"] });
		// The unrelated process was never signaled, and the concurrent peer run
		// is untouched: no cross-run cancel, job, or fixture interference.
		expect(control.exitCode).toBeNull();
		expect(leafAlive(leafB)).toBe(true);
		expect(existsSync(join(b.agentDir, "stop_requested"))).toBe(false);
		expect(existsSync(join(metaB.runDir, "cancel"))).toBe(false);
		expect(getAgentState(runDir, "b")?.status).toBe("running");
		expect(service(metaB.labelSupervisor)).toBe(true);
		stopAgents(runDir, ["b"], { signal: "SIGKILL" });
		const doneB = await completion(b);
		expect(doneB.drainValid).toBe(true);
		expect(doneB.leafGone).toBe(true);
		expect(control.exitCode).toBeNull(); // still never signaled
		await settled(b, { exitCodeFile: "stopped", status: "stopped", causes: ["cancel"] });
	} finally {
		control.kill(); // our own direct control, only after acceptance checks
	}
	expect(findCleanupCandidates(dirname(runDir), 0, 0)).toEqual([runDir]);
	deleteRunDirs([runDir]);
	expect(existsSync(runDir)).toBe(false);
}), 150000);
