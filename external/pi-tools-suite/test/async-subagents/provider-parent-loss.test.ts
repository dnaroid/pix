// Plain (non-owned) launch: when the parent Pix dies abruptly (SIGKILL), the
// child Pi sees RPC stdin EOF and shuts down, and the Claude provider ends the
// active Claude CLI process group, including a SIGTERM-resistant leaf.
// A disposable "fake Pix" harness spawns Pi exactly like the plain launch path
// (detached process group, piped stdio). The test signals only that direct
// harness child; Pi/CLI/leaf PIDs are observed read-only via ps.
import { expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localClaudeProviderModule } from "../../src/async-subagents/core/provider-extensions.js";
import { localProviderAvailable } from "./provider-offline-harness.ts";
import { localNode } from "./provider-offline-rpc.ts";

const offline = process.platform !== "darwin" || !localProviderAvailable() ? test.skip : test;
const root = resolve(fileURLToPath(new URL("../..", import.meta.url)), "../..");
const pi = join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const fixture = fileURLToPath(new URL("./fixtures/provider-owner-loss-cli.mjs", import.meta.url));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
type Marker = { pid: number; token: string; at: number; [key: string]: any };
const markers = (home: string, name: string): Marker[] => readdirSync(home)
	.filter((file) => file.startsWith(`owner-loss-${name}-`) && file.endsWith(".json"))
	.map((file) => JSON.parse(readFileSync(join(home, file), "utf8")));
const alive = (pid: number): boolean => {
	const observed = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)],
		{ timeout: 700, encoding: "utf8", env: { PATH: "/usr/bin:/bin", LANG: "C" } });
	if (observed.error) throw observed.error;
	const state = observed.stdout.trim();
	return observed.status === 0 && state !== "" && !state.startsWith("Z");
};

// Fake Pix: launches Pi like core/spawn.ts plain mode, sends the RPC prompt,
// publishes Pi's PID and then just stays alive holding Pi's stdin open.
const HARNESS = `import { spawn } from "node:child_process";
import { writeFileSync, renameSync } from "node:fs";
const [node, cli, out, ...args] = process.argv.slice(2);
const child = spawn(node, [cli, ...args], { cwd: process.env.T_CWD, stdio: ["pipe", "pipe", "pipe"], detached: true });
child.stdout.resume(); child.stderr.resume();
child.stdin.write(JSON.stringify({ id: "state", type: "get_state" }) + "\\n" + JSON.stringify({ id: "prompt", type: "prompt", message: "parent loss probe" }) + "\\n");
writeFileSync(out + ".tmp", String(child.pid)); renameSync(out + ".tmp", out);
setInterval(() => {}, 1000);
`;

offline("plain launch: SIGKILL of the parent ends child Pi, the active Claude CLI and its resistant leaf", async () => {
	const work = mkdtempSync(join(tmpdir(), "provider-parent-loss-"));
	const home = join(work, "home"), agent = join(work, "agent"), cwd = join(work, "cwd");
	let harness: ChildProcess | undefined;
	let proven = false;
	let piPid: number | undefined;
	try {
		for (const dir of [home, agent, cwd]) mkdirSync(dir);
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enableInstallTelemetry: false,
			enableAnalytics: false, extensions: [], packages: [], skills: [], prompts: [], themes: [], defaultTools: [] }));
		const script = join(work, "fake-pix.mjs");
		writeFileSync(script, HARNESS);
		const pidFile = join(work, "pi.pid");
		const node = localNode();
		const provider = localClaudeProviderModule("pi-claude-code-provider/sonnet").standalone;
		harness = spawn(node, [script, node, pi, pidFile, "--mode", "rpc", "--no-session", "--offline", "--no-approve",
			"--no-extensions", "--extension", provider, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
			"--no-tools", "--provider", "pi-claude-code-provider", "--model", "sonnet", "--models", "pi-claude-code-provider/sonnet"], {
			stdio: "ignore",
			env: { HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(work, "sessions"),
				PI_CLAUDE_CODE_PROVIDER_PATH: fixture, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
				PATH: `${dirname(node)}:/usr/bin:/bin`, TMPDIR: work, LANG: "C", NO_COLOR: "1", T_CWD: cwd },
		});
		const ready = Date.now() + 10_000;
		while (!(markers(home, "request-ready").length === 1 && markers(home, "leaf-ready").length === 1) && Date.now() < ready) await sleep(30);
		expect(markers(home, "request-ready")).toHaveLength(1);
		expect(markers(home, "leaf-ready")).toHaveLength(1);
		piPid = Number(readFileSync(pidFile, "utf8"));
		const request = markers(home, "request-ready")[0]!;
		const leaf = markers(home, "leaf-ready")[0]!;
		expect(alive(piPid)).toBe(true);
		expect(alive(request.pid)).toBe(true);
		expect(alive(leaf.pid)).toBe(true);

		const killedAt = Date.now();
		expect(harness.kill("SIGKILL")).toBe(true); // Sole signal: the direct fake-Pix child.
		const deadline = killedAt + 6_000;
		while ((alive(piPid) || alive(request.pid) || alive(leaf.pid)) && Date.now() < deadline) await sleep(30);
		expect(alive(piPid)).toBe(false);
		expect(alive(request.pid)).toBe(false);
		expect(alive(leaf.pid)).toBe(false);
		// Cleanup, not the fixtures' own 12s/14s watchdogs, ended the actors.
		expect(markers(home, "exit").filter((mark) => [request.token, leaf.token].includes(mark.token))).toHaveLength(0);
		proven = true;
	} finally {
		if (harness && harness.exitCode === null && harness.signalCode === null) harness.kill("SIGKILL");
		if (proven) rmSync(work, { recursive: true, force: true });
		else console.error(`Parent-loss evidence retained: ${work}; pi pid=${piPid ?? "unknown"}`);
	}
}, 30_000);
