// T2: child isolation and the ACTUAL post-session_start tool inventory of a
// Claude-provider child (default: the vendored local provider module). The
// child is built by the real spawnAgent (argument construction + provider
// dependency resolution through the default local-module path) and runs as
// real Pi 0.99.0 with the offline protocol peer. Only the launchd boundary is
// replaced by a plain spawn; nothing is signaled except that direct child.
// The inventory is what Pi hands the provider on the first request.
import { afterAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgent } from "../../src/async-subagents/core/spawn.js";
import { localClaudeProviderModule } from "../../src/async-subagents/core/provider-extensions.js";
import { SUBAGENT_DENIED_TOOLS } from "../../src/async-subagents/core/tool-guard.js";
import { SUBAGENT_COMMON_TOOLS } from "../../src/async-subagents/core/child-tools.js";
import { REPO_DISCOVERY_TOOLS } from "../../src/tool-descriptions.js";
import { installFakeIdxOnPath } from "../support/fake-idx.js";
import type { OwnedLaunchBinaries } from "../../src/async-subagents/core/owned-launch/bootstrap.js";
import { localProviderAvailable } from "./provider-offline-harness.ts";
import { localNode } from "./provider-offline-rpc.ts";

const offline = process.platform !== "darwin" || !localProviderAvailable() ? test.skip : test;
const suite = fileURLToPath(new URL("../..", import.meta.url));
const scratchRoot = resolve(suite, "../../.pi/artifacts/subagent-provider-inventory");
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

async function inventory(tools: string[] | undefined, indexed = false, extraArgs: string[] = []): Promise<{ tools: string[]; all: string[]; piArgs: string[] }> {
	mkdirSync(scratchRoot, { recursive: true });
	const work = mkdtempSync(join(scratchRoot, "run-"));
	works.push(work);
	const home = join(work, "home"), agent = join(work, "agent"), cwd = join(work, "cwd");
	for (const dir of [home, agent, cwd]) mkdirSync(dir);
	mkdirSync(join(cwd, ".git"));
	if (indexed) mkdirSync(join(cwd, ".indexer-cli"));
	const restorePath = installFakeIdxOnPath(work);
	restorePath(); // Only the isolated child's PATH needs the fixture.
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
		["--offline", "--no-approve", "--no-prompt-templates", "--no-themes", "--no-context-files", "--extension", probe, ...extraArgs], undefined, undefined, {
			ownedBinaries: FAKE_BINARIES,
			ownedLaunchForTest: (request) => {
				child = spawn(node, [cli, ...request.args], { cwd: request.cwd, stdio: ["pipe", "pipe", "pipe"], env: {
					...request.env,
					HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(work, "sessions"),
					PI_CLAUDE_CODE_PROVIDER_PATH: fakeCli, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
					PATH: `${join(work, ".test-bin")}:${dirname(node)}:/usr/bin:/bin`, TMPDIR: work, LANG: "C", NO_COLOR: "1", T2_PROBE_LOG: probeLog } });
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

offline("research work tools are read-only in the actual child provider inventory", async () => {
	const { tools, all, piArgs } = await inventory(["read", "grep", "ast_grep", "web_search", "web_fetch"], true);
	for (const name of ["read", "grep", "ast_grep", "web_search", "web_fetch", ...SUBAGENT_COMMON_TOOLS]) expect(tools).toContain(name);
	expect(piArgs.some((arg) => arg.endsWith("async-subagents/work-tools.ts"))).toBe(true);
	expect(all).not.toContain("ast_apply");
	for (const name of tools) expect(["read", "grep", "ast_grep", "web_search", "web_fetch", ...SUBAGENT_COMMON_TOOLS]).toContain(name);
}, 60_000);

offline("coding tools gain only AST; CLI exclusions can remove optional capabilities", async () => {
	const coding = await inventory(["read", "grep", "bash", "edit", "write", "ast_grep"], true);
	expect(coding.tools).toContain("ast_grep");
	expect(coding.tools).toContain("Bash");
	for (const name of ["ast_apply", "web_search", "web_fetch"]) expect(coding.all).not.toContain(name);
	const removed = await inventory(["read", "ast_grep", "web_search", "web_fetch"], true, ["-xt", "ast_grep,web_search,web_fetch"]);
	expect(removed.piArgs.some((arg) => arg.endsWith("async-subagents/work-tools.ts"))).toBe(false);
	for (const name of ["ast_grep", "web_search", "web_fetch"]) expect(removed.all).not.toContain(name);
	for (const name of SUBAGENT_COMMON_TOOLS) expect(removed.tools).toContain(name);
}, 60_000);

const SUITE_ONLY = /^(dcp_|plan_|async_subagents|subagents$|repo_knowledge|question$)/;

offline("default role: private todo is active; provider web search and other suite tools are absent", async () => {
	const { tools, all, piArgs } = await inventory(undefined);
	// The production default path injected the vendored module's standalone entry.
	const standalone = localClaudeProviderModule("pi-claude-code-provider/sonnet").standalone;
	expect(piArgs.filter((arg) => arg === standalone)).toHaveLength(1);
	expect(all).toContain(WEB_SEARCH); // registered by the provider...
	expect(tools).not.toContain(WEB_SEARCH); // ...but never active in a child
	expect(tools.length).toBeGreaterThan(0);
	expect(tools).toContain("todo");
	expect(tools).toContain("compress");
	expect(piArgs).toContain("--no-session");
	expect(piArgs.some((arg) => arg.endsWith("dcp/subagent.ts"))).toBe(true);
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
	expect(tools).toContain("todo");
	for (const name of tools) expect(["read", "grep", "todo", "compress"]).toContain(name.toLowerCase());
}, 60_000);

offline("no-work-tools role: private todo and DCP are available", async () => {
	const { tools, piArgs } = await inventory([]);
	expect(piArgs[piArgs.indexOf("--tools") + 1]).toBe(SUBAGENT_COMMON_TOOLS.join(","));
	expect(tools.sort()).toEqual(["compress", "todo"]);
}, 60_000);

for (const selected of [undefined, ["read", "grep"], []]) {
	offline(`indexed role exposes common queries with work tools=${JSON.stringify(selected)}`, async () => {
		const { tools, all, piArgs } = await inventory(selected, true);
		for (const name of SUBAGENT_COMMON_TOOLS) expect(tools).toContain(name);
		expect(piArgs.some((arg) => arg.endsWith("repo-discovery/subagent.ts"))).toBe(true);
		expect(tools).not.toContain(WEB_SEARCH);
		for (const name of tools) expect(SUBAGENT_DENIED_TOOLS.has(name)).toBe(false);
		expect(all).not.toContain("subagents");
		if (selected) {
			const allowed = [...selected, ...SUBAGENT_COMMON_TOOLS].map((name) => name.toLowerCase());
			for (const name of tools) expect(allowed).toContain(name.toLowerCase());
		}
		expect(REPO_DISCOVERY_TOOLS).toHaveLength(8);
	}, 60_000);
}
