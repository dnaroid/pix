// G4: the vendored local provider module entrypoint loads in an isolated child
// of the ACTUAL personal Pi installation (opt-in: PI_CLAUDE_PROVIDER_INSTALLED=1).
// The provider is resolved from the trusted suite-relative module — Pi package
// configuration and npm installs are never consulted. No inference, no auth:
// the child receives no prompt, runs with an isolated agent dir/HOME, and the
// provider's CLI boundary is the offline protocol peer (never real Claude).
import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	claudeProviderLocalRoot,
	localClaudeProviderModule,
	resolveProviderExtensions,
	SUPPORTED_CLAUDE_PROVIDER_VERSIONS,
} from "../../src/async-subagents/core/provider-extensions.js";
import { localNode } from "./provider-offline-rpc.ts";

const localAvailable = existsSync(join(claudeProviderLocalRoot(), "package.json"));
const resolution = localAvailable ? test : test.skip;
const installed = localAvailable && process.env.PI_CLAUDE_PROVIDER_INSTALLED === "1" ? test : test.skip;
const fakeCli = fileURLToPath(new URL("./fixtures/provider-offline-cli.mjs", import.meta.url));

resolution("resolution uses the vendored local module and its public standalone entry (no package lookup)", () => {
	const local = localClaudeProviderModule("pi-claude-code-provider/sonnet");
	const manifest = JSON.parse(readFileSync(join(local.root, "package.json"), "utf8"));
	expect(SUPPORTED_CLAUDE_PROVIDER_VERSIONS).toContain(manifest.version);
	const [entry] = resolveProviderExtensions({ selectedModel: "pi-claude-code-provider/sonnet", explicitModel: undefined,
		claudeSelected: true, forwardedArgs: [], cwd: process.cwd() });
	expect(entry).toBe(local.standalone);
	expect(entry).toBe(join(local.root, "index.ts"));
});

installed("personal Pi loads the vendored local provider entry in an isolated child", async () => {
	// Resolution through the trusted suite-relative module, exactly as spawnAgent does.
	const entry = localClaudeProviderModule("pi-claude-code-provider/sonnet").standalone;

	// The personal Pi executable (not the repository's SDK copy).
	const piBin = realpathSync(execFileSync("/usr/bin/which", ["pi"], { encoding: "utf8" }).trim());
	const node = localNode();
	const work = mkdtempSync(join(tmpdir(), "pi-provider-g4-"));
	try {
		const home = join(work, "home"), agent = join(work, "agent"), cwd = join(work, "cwd");
		for (const dir of [home, agent, cwd]) mkdirSync(dir);
		writeFileSync(join(home, "fake-exit-code"), "0");
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false }, enableInstallTelemetry: false,
			enableAnalytics: false, extensions: [], packages: [], skills: [], prompts: [], themes: [] }));
		const child = spawn(node, [piBin, "--mode", "rpc", "--no-session", "--offline", "--no-approve", "--no-extensions",
			"--extension", entry, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
			"--provider", "pi-claude-code-provider", "--model", "sonnet", "--models", "pi-claude-code-provider/sonnet"], {
			cwd, stdio: ["pipe", "pipe", "pipe"], env: { HOME: home, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: join(work, "sessions"),
				PI_CLAUDE_CODE_PROVIDER_PATH: fakeCli, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
				PATH: `${dirname(node)}:/usr/bin:/bin`, TMPDIR: work, LANG: "C", NO_COLOR: "1" },
		});
		const lines: any[] = [];
		let stderr = "";
		let buffer = "";
		child.stdout!.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let end: number;
			while ((end = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
				if (line) try { lines.push(JSON.parse(line)); } catch { /* ignored */ }
			}
		});
		child.stderr!.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-8000); });
		const closed = new Promise<number | null>((done) => child.once("close", (code) => done(code)));
		child.stdin!.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
		child.stdin!.write(`${JSON.stringify({ id: "models", type: "get_available_models" })}\n`);
		const end = Date.now() + 20_000;
		while (!lines.some((l) => l.id === "models") && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
		child.stdin!.end();
		const code = await Promise.race([closed, new Promise<null>((r) => setTimeout(() => { child.kill("SIGKILL"); r(null); }, 10_000))]);
		const state = lines.find((l) => l.id === "state");
		const models = lines.find((l) => l.id === "models");
		expect(state?.success, stderr).toBe(true);
		expect(state.data.model.provider).toBe("pi-claude-code-provider");
		expect(state.data.model.id).toBe("sonnet");
		expect(models?.success).toBe(true);
		expect(models.data.models.some((m: any) => m.provider === "pi-claude-code-provider" && m.id === "sonnet")).toBe(true);
		expect(code).toBe(0);
		// No request was made: the peer only ever sees capability probes, never a prompt.
		const calls = execFileSync("/bin/ls", [home], { encoding: "utf8" }).split("\n").filter((n) => n.startsWith("fake-cli-"))
			.map((n) => JSON.parse(readFileSync(join(home, n), "utf8")));
		expect(calls.some((call) => call.args.includes("--input-format"))).toBe(false);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}, 60_000);
