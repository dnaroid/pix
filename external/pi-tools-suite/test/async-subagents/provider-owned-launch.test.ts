// Opt-in G1/T3 candidate launcher acceptance, against installed Pi SDK and
// hash-verified UNMODIFIED provider 0.5.0. Never the native-patched provider.
// All kill actions address either an owned direct bridge or its exact UUID
// launchctl job. Fixture PIDs are used only for read-only ps observations.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureOwnedLaunchBinaries } from "../../src/async-subagents/core/owned-launch/bootstrap.js";
import { launchOwnedAgent, type OwnedLaunchHandle } from "../../src/async-subagents/core/owned-launch/index.js";
import { stageSnapshot } from "./provider-offline-harness.ts";
import { localNode } from "./provider-offline-rpc.ts";

const snapshot = process.env.PI_CLAUDE_PROVIDER_OFFLINE_SNAPSHOT;
const enabled = process.platform === "darwin" && process.env.PI_OFFLINE_COALITION_PROBE === "1" && snapshot !== undefined;
const offline = enabled ? test : test.skip;
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)), "../..");
const pi = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const fixture = fileURLToPath(new URL("./fixtures/provider-owned-cli.mjs", import.meta.url));
const domain = `gui/${process.getuid?.()}`;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ctl = (args: string[]) => spawnSync("/bin/launchctl", args, { timeout: 3000, encoding: "utf8" });
function service(label: string): boolean {
	const result = ctl(["print", `${domain}/${label}`]);
	if (result.error) throw result.error;
	if (result.status === 0) return true;
	if (result.status === 113 && result.stderr.includes(`Could not find service "${label}"`)) return false;
	throw new Error(`ambiguous launchctl print ${label}: ${result.status} ${result.stderr}`);
}
const markers = (home: string, name: string): Array<{ pid: number; token: string; at: number; [key: string]: any }> =>
	readdirSync(home).filter((file) => file.startsWith(`provider-owned-${name}-`) && file.endsWith(".json"))
		.map((file) => JSON.parse(readFileSync(join(home, file), "utf8")));
const receipt = (path: string) => Object.fromEntries([...readFileSync(path, "utf8").matchAll(/([a-z_]+)=(\S+)/g)]
	.map((match) => [match[1], match[2]]));

// The fixture token is in the leaf's argv. If ps sees an unrelated PID
// incarnation it is never treated as a fixture, nor ever signaled.
function leafAlive(marker: { pid: number; token: string }): boolean {
	const observed = spawnSync("/bin/ps", ["-o", "stat=", "-o", "command=", "-p", String(marker.pid)],
		{ timeout: 3000, encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C" } });
	if (observed.error) throw observed.error;
	if (observed.status === 1 && !observed.stdout.trim()) return false;
	if (observed.status !== 0) throw new Error(`ambiguous ps(${marker.pid}): ${observed.status} ${observed.stderr}`);
	if (!observed.stdout.includes(marker.token)) return false;
	return !observed.stdout.trim().startsWith("Z");
}
async function until(predicate: () => boolean, ms: number, label: string) {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (predicate()) return; await sleep(40); }
	throw new Error(`deadline: ${label}`);
}

type Run = { home: string; handle: OwnedLaunchHandle; records: Record<string, any>[]; logs: { out: string; err: string }; send(value: object): void };
type Context = { work: string; extension: string; node: string; binaries: Awaited<ReturnType<typeof ensureOwnedLaunchBinaries>>; runs: Run[]; nextId: number };
async function setup(): Promise<Context> {
	const work = mkdtempSync(join(tmpdir(), "provider-owned-"));
	try {
		const installed = JSON.parse(readFileSync(join(root, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8"));
		if (installed.version !== "0.87.1") throw new Error(`Expected installed Pi SDK 0.87.1, found ${installed.version}`);
		const extension = stageSnapshot(snapshot!, work);
		return { work, extension, node: localNode(), binaries: await ensureOwnedLaunchBinaries({ cacheRoot: join(work, "cache") }), runs: [], nextId: 0 };
	} catch (error) { console.error(`Provider-owned setup retained: ${work}`); throw error; }
}
async function start(ctx: Context, mode: "hold" | "exit0" | "exit7", watchdogSeconds = 45): Promise<Run> {
	const id = String(ctx.nextId++);
	const home = join(ctx.work, `home-${id}`), agent = join(ctx.work, `agent-${id}`), cwd = join(ctx.work, `cwd-${id}`);
	for (const dir of [home, agent, cwd]) mkdirSync(dir, { mode: 0o700 });
	writeFileSync(join(home, "owned-fake-mode"), mode);
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enableInstallTelemetry: false,
		enableAnalytics: false, extensions: [], packages: [], skills: [], prompts: [], themes: [], defaultTools: [] }));
	const env = { HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(ctx.work, `sessions-${id}`),
		PI_CLAUDE_CODE_PROVIDER_PATH: fixture, PI_OFFLINE: "1",
		PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PATH: `${dirname(ctx.node)}:/usr/bin:/bin`,
		TMPDIR: ctx.work, LANG: "C", NO_COLOR: "1" }; // No ambient auth, proxy, NODE_OPTIONS, or Pi config.
	const piArgs = [pi, "--mode", mode === "hold" ? "rpc" : "json", "--no-session", "--offline", "--no-approve", "--no-extensions", "--extension", ctx.extension,
			"--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools", "--provider",
			"pi-claude-code-provider", "--model", "sonnet", "--models", "pi-claude-code-provider/sonnet",
			...(mode === "hold" ? [] : ["-p", "offline containment probe"])];
	// Print mode reads stdin to EOF. Give Pi /dev/null without closing the
	// bridge's owner-liveness pipe, whose EOF intentionally cancels the run.
	const handle = await launchOwnedAgent({ command: mode === "hold" ? ctx.node : "/bin/sh",
		args: mode === "hold" ? piArgs : ["-c", 'exec "$@" </dev/null', "owned-print", ctx.node, ...piArgs],
		cwd, env, baseDir: join(ctx.work, "runs"), binaries: ctx.binaries,
		timeouts: { watchdogSeconds, releaseTimeoutSeconds: 12, drainDeadlineSeconds: 15 } });
	const run: Run = { home, handle, records: [], logs: { out: "", err: "" }, send(value) {
		handle.process.stdin!.write(`${JSON.stringify(value)}\n`);
	} };
	ctx.runs.push(run);
	let buffer = "";
	handle.process.stdin?.on("error", (e) => { run.logs.err += `stdin error: ${e}\n`; });
	handle.process.stdout?.on("data", (chunk: Buffer) => {
		run.logs.out = (run.logs.out + chunk.toString()).slice(-128000);
		buffer += chunk.toString();
		let pos: number;
		while ((pos = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
			try { run.records.push(JSON.parse(line)); } catch { run.logs.err += `invalid RPC: ${line.slice(0, 200)}\n`; }
		}
	});
	handle.process.stderr?.on("data", (chunk: Buffer) => { run.logs.err = (run.logs.err + chunk.toString()).slice(-16000); });
	return run;
}
async function request(run: Run) {
	run.send({ id: "state", type: "get_state" });
	await until(() => run.records.some((r) => r.id === "state"), 20000, `Pi RPC state ${run.logs.err}`);
	expect(run.records.find((r) => r.id === "state")?.data?.model?.provider).toBe("pi-claude-code-provider");
	run.send({ id: "prompt", type: "prompt", message: "offline containment probe" });
	await until(() => run.records.some((r) => r.id === "prompt") && markers(run.home, "request").length === 1 && markers(run.home, "leaf").length === 1,
		20000, `real provider request and detached leaf ${run.logs.err}`);
	const request = markers(run.home, "request")[0], leaf = markers(run.home, "leaf")[0];
	expect(request.mode).toBe("hold");
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
	return leaf;
}
async function drained(run: Run, cause?: string, leaf?: { pid: number; token: string; at: number }) {
	const { handle } = run;
	await until(() => existsSync(join(handle.runDir, "drain.json")), 35000, `durable drain receipt ${handle.runDir} ${run.logs.err}`);
	const data = receipt(join(handle.runDir, "drain.json"));
	expect(data.status).toBe("ok");
	if (cause) expect(data.cause).toBe(cause);
	expect(BigInt(`0x${data.cid}`)).toBeGreaterThan(0n);
	expect(data.cid).not.toBe(data.sup_cid);
	expect(Number(data.started)).toBeGreaterThanOrEqual(2);
	expect(Number(data.exited)).toBe(Number(data.started));
	expect(existsSync(join(handle.runDir, "owned.json"))).toBe(true);
	if (leaf) {
		await until(() => !leafAlive(leaf), 7000, "detached descendant gone");
		expect(Date.now()).toBeLessThan(leaf.at + 70000); // before the fixture's independent watchdog
	}
	expect(run.logs.err).not.toContain("invalid RPC:");
	await until(() => !service(handle.labelWorker) && !service(handle.labelSupervisor), 12000, "exact jobs booted out");
}
function release(run: Run) {
	return existsSync(join(run.handle.runDir, "owned.json")) && existsSync(join(run.handle.runDir, "release")) &&
		existsSync(join(run.handle.runDir, "gate-handoff"));
}
async function scenario(name: string, body: (ctx: Context, control: ReturnType<typeof Bun.spawn>) => Promise<void>, allowUnreleased = false) {
	let ctx: Context | undefined;
	const control = Bun.spawn(["/bin/sleep", "300"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	let passed = false;
	try {
		ctx = await setup();
		await body(ctx, control);
		for (const run of ctx.runs) {
			// Never remove the fixtures or stop their watchdog until ownership has
			// a successful bound receipt AND every observed leaf is gone.
			if (allowUnreleased && !existsSync(join(run.handle.runDir, "owned.json"))) continue;
			await drained(run, undefined, markers(run.home, "leaf")[0]);
		}
		expect(control.exitCode).toBeNull();
		passed = true;
	} finally {
		control.kill(); // our own direct control, only after acceptance checks
		if (ctx) {
			for (const run of ctx.runs) {
				writeFileSync(join(run.handle.runDir, "probe-output.json"), JSON.stringify({ records: run.records, logs: run.logs }, null, 2));
			}
			if (passed && (!allowUnreleased || ctx.runs.every((r) => existsSync(join(r.handle.runDir, "drain.json")))))
				rmSync(ctx.work, { recursive: true, force: true });
			else console.error(`${name}: retained evidence and UUID jobs (no speculative cleanup): ${ctx.work}; ${ctx.runs.map((r) => `${r.handle.runDir} ${r.handle.labelSupervisor} ${r.handle.labelWorker}`).join("; ")}`);
		}
	}
}

for (const code of [0, 7] as const) {
	offline(`owned production launcher: real SDK + unchanged provider natural fake exit ${code}`, async () => scenario(`natural-${code}`, async (ctx) => {
		const run = await start(ctx, code === 0 ? "exit0" : "exit7");
		await until(() => markers(run.home, "request").length === 1 && markers(run.home, "leaf").length === 1,
			20000, `real provider print request and detached leaf ${run.logs.err}`);
		const leaf = markers(run.home, "leaf")[0];
		expect(markers(run.home, "request")[0].mode).toBe(code === 0 ? "exit0" : "exit7");
		expect(markers(run.home, "request")[0].leafPid).toBe(leaf.pid);
		expect(leafAlive(leaf)).toBe(true);
		writeFileSync(join(run.home, `provider-owned-release-${markers(run.home, "request")[0].token}`), "release\n");
		await until(() => run.records.some((r) => r.type === "agent_end"), 20000, `provider print result ${run.logs.err}`);
		const end = run.records.findLast((r) => r.type === "message_end" && r.message?.role === "assistant");
		expect(end?.message?.stopReason).toBe(code === 0 ? "stop" : "error");
		expect((await Promise.race([run.handle.exited, sleep(30000).then(() => null)]))?.code).toBe(0);
		await drained(run, "leader_exit", leaf);
	}), 100000);
}

for (const [name, action, cause] of [
	["graceful stop", "stop", "cancel"], ["force bridge SIGKILL", "kill", "cancel"],
	["watchdog expiry", "watchdog", "watchdog"], ["supervisor KeepAlive recovery plus bridge/worker loss", "triple", "restart_recovery"],
] as const) {
	offline(`owned production launcher: ${name} drains escaped provider descendant`, async () => scenario(name, async (ctx) => {
		const run = await start(ctx, "hold", action === "watchdog" ? 9 : 45);
		const leaf = await request(run);
		await until(() => release(run), 12000, "durably owned and released before fault");
		if (action === "stop") run.handle.stop();
		if (action === "triple") {
			// Kill the supervisor while the bridge still lives: killing the
			// bridge first lets the supervisor drain and boot out the worker
			// before the exact launchctl fault can be injected.
			const result = ctl(["kill", "SIGKILL", `${domain}/${run.handle.labelSupervisor}`]);
			expect(result.status, result.stderr).toBe(0);
			run.handle.process.kill("SIGKILL");
			const worker = ctl(["kill", "SIGKILL", `${domain}/${run.handle.labelWorker}`]);
			if (worker.status !== 0) expect(existsSync(join(run.handle.runDir, "drain.json")), worker.stderr).toBe(true);
		}
		if (action === "kill") run.handle.process.kill("SIGKILL");
		await drained(run, cause, leaf);
	}), 100000);
}

offline("owned production launcher: startup release race either parks or drains, never leaves an escapee", async () => scenario("release-race", async (ctx) => {
	const run = await start(ctx, "hold");
	// No sleep or prerequisite: direct bridge kill races the supervisor's
	// worker creation and durable release. If released, a receipt is mandatory.
	run.handle.process.kill("SIGKILL");
	await until(() => existsSync(join(run.handle.runDir, "drain.json")) ||
		(!service(run.handle.labelSupervisor) && !service(run.handle.labelWorker)), 35000, "startup concluded");
	const leaves = markers(run.home, "leaf");
	if (existsSync(join(run.handle.runDir, "owned.json")) || leaves.length) await drained(run, undefined, leaves[0]);
	else {
		expect(existsSync(join(run.handle.runDir, "release"))).toBe(false);
		expect(markers(run.home, "request")).toHaveLength(0);
	}
}, true), 100000);

offline("owned production launcher: two concurrent provider requests drain independently", async () => scenario("concurrent", async (ctx) => {
	const [a, b] = await Promise.all([start(ctx, "hold"), start(ctx, "hold")]);
	const [leafA, leafB] = await Promise.all([request(a), request(b)]);
	await until(() => release(a) && release(b), 12000, "both runs bound and released");
	expect(a.handle.labelWorker).not.toBe(b.handle.labelWorker);
	a.handle.stop();
	await drained(a, "cancel", leafA);
	expect(leafAlive(leafB)).toBe(true);
	expect(service(b.handle.labelSupervisor)).toBe(true);
	b.handle.process.kill("SIGKILL");
	await drained(b, "cancel", leafB);
}), 100000);
