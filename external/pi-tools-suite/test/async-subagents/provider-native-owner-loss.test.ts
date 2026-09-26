import { expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageSnapshot } from "./provider-offline-harness.ts";
import { applyNativeProviderPatch } from "./provider-native-patch.ts";
import { localNode } from "./provider-offline-rpc.ts";

const snapshot = process.env.PI_CLAUDE_PROVIDER_OFFLINE_SNAPSHOT;
const offline = snapshot === undefined ? test.skip : test;
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)), "../..");
const pi = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const fixture = fileURLToPath(new URL("./fixtures/provider-owner-loss-cli.mjs", import.meta.url));
const relay = fileURLToPath(new URL("./fixtures/provider-native-relay.c", import.meta.url));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Marker = { pid: number; token: string; at: number; [key: string]: any };
const markers = (home: string, name: string): Marker[] => readdirSync(home)
	.filter((file) => file.startsWith(`owner-loss-${name}-`) && file.endsWith(".json"))
	.map((file) => JSON.parse(readFileSync(join(home, file), "utf8")));
// Read-only observation: never signal a PID obtained from a fixture marker.
const status = (pid: number): string | undefined => {
	const observed = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)],
		{ timeout: 700, encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C" } });
	if (observed.error) throw observed.error;
	if (observed.status === 1 && !observed.stdout.trim() && !observed.stderr.trim()) return undefined;
	if (observed.status !== 0 || !observed.stdout.trim()) throw new Error(`Cannot observe fixture ${pid}: ps=${observed.status}; ${observed.stderr}`);
	return observed.stdout.trim();
};
const group = (pid: number): number => Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)],
	{ timeout: 700, env: { PATH: "/usr/bin:/bin", LANG: "C" } }).toString().trim());
const alive = (pid: number) => { const state = status(pid); return state !== undefined && !state.startsWith("Z"); };

offline("installed Pi RPC: SIGKILL of owned Pi ends active native provider CLI and resistant B-group leaf", async () => {
	if (process.platform !== "darwin") throw new Error("Native ownership test requires macOS");
	const work = mkdtempSync(join(tmpdir(), "provider-owner-loss-"));
	const home = join(work, "home"), agent = join(work, "agent"), cwd = join(work, "cwd");
	let child: ChildProcess | undefined;
	let closed: Promise<void> | undefined;
	let proven = false;
	let output = "", errors = "";
	let streamError: Error | undefined;
	const records: Record<string, any>[] = [];
	try {
		const extension = stageSnapshot(snapshot!, work);
		applyNativeProviderPatch(join(work, "provider"));
		const binary = join(work, "relay");
		execFileSync("clang", ["-std=c11", "-D_DARWIN_C_SOURCE", "-Wall", "-Wextra", "-Werror", "-O2", relay, "-o", binary], { timeout: 10_000 });
		for (const dir of [home, agent, cwd]) mkdirSync(dir);
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enableInstallTelemetry: false,
			enableAnalytics: false, extensions: [], packages: [], skills: [], prompts: [], themes: [], defaultTools: [] }));
		const node = localNode();
		const env = { HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(work, "sessions"),
			PI_CLAUDE_CODE_PROVIDER_PATH: fixture, PI_PROVIDER_TEST_NATIVE_RELAY: binary, PI_OFFLINE: "1",
			PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PATH: `${dirname(node)}:/usr/bin:/bin`,
			TMPDIR: work, LANG: "C", NO_COLOR: "1" }; // Never inherit auth, proxy or NODE_OPTIONS.
		child = spawn(node, [pi, "--mode", "rpc", "--no-session", "--offline", "--no-approve", "--no-extensions",
			"--extension", extension, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
			"--no-tools", "--provider", "pi-claude-code-provider", "--model", "sonnet",
			"--models", "pi-claude-code-provider/sonnet"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
		const owner = child;
		closed = new Promise<void>((resolveClose) => { owner.once("close", () => resolveClose()); });
		owner.on("error", (error) => { streamError = error; });
		owner.stdin!.on("error", (error) => { streamError = error; });
		owner.stdout!.on("error", (error) => { streamError = error; });
		owner.stderr!.on("error", (error) => { streamError = error; });
		owner.stdout!.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			if (output.length > 128_000) { streamError = new Error("RPC stdout exceeded 128KB"); output = output.slice(-128_000); }
			let at: number;
			while ((at = output.indexOf("\n")) >= 0) {
				const line = output.slice(0, at).trim(); output = output.slice(at + 1);
				if (line) {
					if (records.length >= 4096) { streamError = new Error("RPC record limit exceeded"); continue; }
					try { records.push(JSON.parse(line)); } catch { streamError = new Error(`Non-JSON RPC output: ${line.slice(0, 300)}`); }
				}
			}
		});
		owner.stderr!.on("data", (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-16_000); });
		const until = async (predicate: () => boolean, label: string, ms = 7_000) => {
			const end = Date.now() + ms;
			while (!predicate()) {
				if (streamError || owner.exitCode !== null || owner.signalCode !== null || Date.now() >= end)
					throw new Error(`${label}: ${String(streamError ?? "Pi exited or deadline expired")}; stderr=${errors}; stdout=${output.slice(-2000)}`);
				await sleep(20);
			}
		};
		const send = (value: object) => new Promise<void>((resolveSend, reject) => {
			const timer = setTimeout(() => reject(new Error("RPC write deadline")), 2_000);
			owner.stdin!.write(`${JSON.stringify(value)}\n`, (error) => { clearTimeout(timer); error ? reject(error) : resolveSend(); });
		});
		await send({ id: "state", type: "get_state" });
		await until(() => records.some((record) => record.id === "state"), "Pi state");
		expect(records.find((record) => record.id === "state")?.data?.model?.provider).toBe("pi-claude-code-provider");
		await send({ id: "prompt", type: "prompt", message: "offline owner loss probe" });
		await until(() => records.some((record) => record.id === "prompt") && markers(home, "request-ready").length === 1 && markers(home, "leaf-ready").length === 1,
			"active request and B-group resistant leaf");
		expect(records.find((record) => record.id === "prompt")?.success).toBe(true);
		const preflights = markers(home, "preflight");
		expect(preflights.map((mark) => JSON.stringify(mark.args)).sort()).toEqual(['["--help"]', '["--version"]', '["auth","status"]'].sort());
		const request = markers(home, "request-ready")[0];
		const leaf = markers(home, "leaf-ready")[0];
		expect(request.args).toContain("--input-format");
		expect(JSON.parse(request.input).message.content).toBeDefined();
		expect(request.leafPid).toBe(leaf.pid);
		expect(realpathSync(request.cwd)).toBe(realpathSync(cwd));
		expect(request.env.ANTHROPIC_API_KEY).toBeNull();
		expect(request.env.CLAUDE_CODE_OAUTH_TOKEN).toBeNull();
		expect(request.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
		expect(markers(home, "start")).toHaveLength(5); // 3 preflights, request CLI, resistant leaf
		expect(markers(home, "exit")).toHaveLength(3); // Preflights completed; request and leaf remain active.
		expect(alive(request.pid)).toBe(true);
		expect(alive(leaf.pid)).toBe(true);
		expect(group(request.pid)).toBe(group(leaf.pid)); // C inherited B's non-detached group.
		expect(group(request.pid)).not.toBe(group(owner.pid!));
		expect(markers(home, "exit").filter((mark) => [request.token, leaf.token].includes(mark.token))).toHaveLength(0);
		const killedAt = Date.now();
		// This is the sole signal in the acceptance path: a still-owned direct ChildProcess.
		expect(owner.kill("SIGKILL")).toBe(true);
		const deadline = Date.now() + 4_000;
		while ((alive(request.pid) || alive(leaf.pid) || owner.signalCode !== "SIGKILL") && Date.now() < deadline) await sleep(30);
		expect(owner.signalCode).toBe("SIGKILL");
		expect(alive(request.pid)).toBe(false);
		expect(alive(leaf.pid)).toBe(false);
		expect(Date.now() - killedAt).toBeLessThan(4_000);
		const starts = markers(home, "start");
		expect(Date.now()).toBeLessThan(starts.find((mark) => mark.token === request.token)!.at + 12_000);
		expect(Date.now()).toBeLessThan(starts.find((mark) => mark.token === leaf.token)!.at + 14_000);
		expect(markers(home, "exit").filter((mark) => [request.token, leaf.token].includes(mark.token))).toHaveLength(0);
		await Promise.race([closed, sleep(2_000).then(() => { throw new Error("Pi close deadline"); })]);
		expect(streamError).toBeUndefined();
		proven = true;
	} finally {
		if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); // Direct child only.
		if (closed) await Promise.race([closed, sleep(2_000)]);
		if (proven) rmSync(work, { recursive: true, force: true });
		else console.error(`Owner-loss evidence retained: ${work}; stderr=${errors.slice(-2000)}; stdout=${output.slice(-2000)}`);
	}
}, 30_000);
