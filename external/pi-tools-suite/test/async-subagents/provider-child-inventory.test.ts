// T2: child isolation and the ACTUAL post-session_start tool inventory of a
// Claude-provider child (opt-in: PI_CLAUDE_PROVIDER_OFFLINE_SNAPSHOT). The
// child is built by the real spawnAgent (argument construction + provider
// dependency resolution) and runs as real Pi 0.99.0 with the unchanged
// provider and the offline protocol peer. Only the launchd boundary is
// replaced by a plain spawn; nothing is signaled except that direct child.
// The inventory is what Pi hands the provider on the first request.
import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgent } from "../../src/async-subagents/core/spawn.js";
import { SUBAGENT_DENIED_TOOLS } from "../../src/async-subagents/core/tool-guard.js";
import type { OwnedLaunchBinaries } from "../../src/async-subagents/core/owned-launch/bootstrap.js";
import { stageSnapshot } from "./provider-offline-harness.ts";
import { localNode } from "./provider-offline-rpc.ts";

const snapshot = process.env.PI_CLAUDE_PROVIDER_OFFLINE_SNAPSHOT;
const offline = snapshot === undefined || process.platform !== "darwin" ? test.skip : test;
const suite = fileURLToPath(new URL("../..", import.meta.url));
const cli = join(resolve(suite, "../.."), "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const fakeCli = fileURLToPath(new URL("./fixtures/provider-offline-cli.mjs", import.meta.url));
const FAKE_BINARIES: OwnedLaunchBinaries = { bridge: "/nonexistent/bridge", gate: "/nonexistent/gate", supervisor: "/nonexistent/supervisor" };
const WEB_SEARCH = "pi_claude_code_provider_web_search";
const PROBE = `import { appendFileSync } from "node:fs";
export default function (pi) {
	pi.on("before_provider_request", (event) => {
		appendFileSync(process.env.T2_PROBE_LOG, JSON.stringify({ tools: (event.payload.tools ?? []).map((t) => t.name), all: pi.getAllTools().map((t) => t.name) }) + "\\n");
	});
}
`;

const children: ChildProcess[] = [];
const works: string[] = [];
afterAll(async () => {
	for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	await new Promise((r) => setTimeout(r, 200));
	for (const work of works) rmSync(work, { recursive: true, force: true });
});

async function inventory(tools: string[] | undefined): Promise<{ tools: string[]; all: string[]; piArgs: string[] }> {
	const work = mkdtempSync(join(tmpdir(), "pi-provider-t2-"));
	works.push(work);
	const extension = stageSnapshot(snapshot!, work);
	const home = join(work, "home"), agent = join(work, "agent"), cwd = join(work, "cwd");
	for (const dir of [home, agent, cwd]) mkdirSync(dir);
	writeFileSync(join(home, "fake-exit-code"), "0");
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enableInstallTelemetry: false,
		enableAnalytics: false, extensions: [], packages: [], skills: [], prompts: [], themes: [] }));
	const probe = join(work, "probe.mjs");
	writeFileSync(probe, PROBE);
	const probeLog = join(work, "probe.jsonl");
	const node = localNode();
	const runDir = join(work, "run");
	mkdirSync(join(runDir, "prompts"), { recursive: true });
	const previousPlatform = process.platform;
	let child: ChildProcess | undefined;
	const spawned = spawnAgent(runDir, { id: "child", task: "offline inventory probe", model: "pi-claude-code-provider/sonnet", ...(tools ? { tools } : {}) }, cwd,
		["--offline", "--no-approve", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", probe], undefined, undefined, {
			ownedBinaries: FAKE_BINARIES,
			locateProviderPackagesForTest: () => [dirname(dirname(extension))],
			ownedLaunchForTest: (request) => {
				child = spawn(node, [cli, ...request.args], { cwd: request.cwd, stdio: ["pipe", "pipe", "pipe"], env: {
					HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(work, "sessions"),
					PI_CLAUDE_CODE_PROVIDER_PATH: fakeCli, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
					PATH: `${dirname(node)}:/usr/bin:/bin`, TMPDIR: work, LANG: "C", NO_COLOR: "1", T2_PROBE_LOG: probeLog } });
				children.push(child);
				return { pid: child.pid!, process: child, runDir: join(request.agentDir, "owned-launch", "t2"),
					labelSupervisor: "t2-supervisor", labelWorker: "t2-worker", stop: () => child?.kill("SIGTERM") } as any;
			},
		});
	expect(previousPlatform).toBe(process.platform);
	const end = Date.now() + 20_000;
	let record: { tools: string[]; all: string[] } | undefined;
	while (!record && Date.now() < end) {
		try { record = JSON.parse(readFileSync(probeLog, "utf8").split("\n")[0]); } catch { await new Promise((r) => setTimeout(r, 50)); }
	}
	child?.kill("SIGTERM");
	if (!record) throw new Error(`no provider request observed; stderr=${readFileSync(join(spawned.agentDir, "stderr.log"), "utf8").slice(-3000)}`);
	return { ...record, piArgs: readFileSync(join(spawned.agentDir, "pi_args"), "utf8").split("\n") };
}

const SUITE_ONLY = /^(compress|dcp_|todo|plan_|async_subagents|subagents$|repo_knowledge|question$)/;

offline("default role: provider web search and every denied/suite tool are absent after session_start", async () => {
	const { tools, all, piArgs } = await inventory(undefined);
	expect(all).toContain(WEB_SEARCH); // registered by the provider...
	expect(tools).not.toContain(WEB_SEARCH); // ...but never active in a child
	expect(tools.length).toBeGreaterThan(0);
	for (const name of tools) {
		expect(SUBAGENT_DENIED_TOOLS.has(name)).toBe(false);
		expect(SUITE_ONLY.test(name)).toBe(false);
	}
	expect(piArgs).toContain("--no-extensions");
	expect(piArgs).toContain("--no-skills");
}, 60_000);

offline("restricted role: only the selected tools, never the provider web search", async () => {
	const { tools } = await inventory(["read", "grep", WEB_SEARCH]);
	expect(tools).not.toContain(WEB_SEARCH);
	expect(tools.length).toBeGreaterThan(0);
	for (const name of tools) expect(["read", "grep"]).toContain(name.toLowerCase());
}, 60_000);

offline("no-tools role: empty inventory even after the provider registers its tool", async () => {
	const { tools, piArgs } = await inventory([]);
	expect(piArgs).toContain("--no-tools");
	expect(tools).toEqual([]);
}, 60_000);
