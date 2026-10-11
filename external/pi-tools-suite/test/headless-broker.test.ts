import { test, expect } from "bun:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { waitForHeadlessSubagentCompletion } from "./fixtures/headless-subagent-completion.js";

const execFile = promisify(execFileCallback);
const CLI = path.resolve(import.meta.dir, "../src/headless/cli.ts");
const SUITE_ROOT = path.resolve(import.meta.dir, "../../..");

test("detached Pix subagents broker owns RPC pipes after CLI responds (offline fixture)", async () => {
	const artifacts = path.join(SUITE_ROOT, ".pi", "artifacts");
	await mkdir(artifacts, { recursive: true });
	const scratch = await mkdtemp(path.join(artifacts, "pix-headless-agents-"));
	const workspace = path.join(scratch, "project");
	const binaryDir = path.join(scratch, "bin");
	const releaseFile = path.join(scratch, "release-fixture");
	try {
		await mkdir(workspace);
		await mkdir(path.join(workspace, ".pi", "agents"), { recursive: true });
		await writeFile(path.join(workspace, ".pi", "agents", "project-specialist.md"), [
			"---", "description: Offline project-specific specialist", "models: [zai/glm-5-turbo]", "---",
			"This is the project's own specialized role.", "",
		].join("\n"));
		await mkdir(binaryDir);
		const agentDir = path.join(scratch, "pi-agent-test-config");
		await mkdir(agentDir);
		// Offline fixture credentials only: model metadata/availability are
		// resolved locally, and the fake child executable never calls a provider.
		await writeFile(path.join(agentDir, "auth.json"), JSON.stringify({
			zai: { type: "api_key", key: "OFFLINE_FIXTURE_DO_NOT_SEND" },
		}), { mode: 0o600 });
		const fakePiSource = [
			"#!/usr/bin/env node",
			"import { existsSync } from 'node:fs';",
			"let buffer = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', chunk => {",
			"  buffer += chunk;",
			"  while (buffer.includes('\\n')) {",
			"    const index = buffer.indexOf('\\n'); const line = buffer.slice(0,index); buffer = buffer.slice(index+1);",
			"    const request = JSON.parse(line);",
			"    if (request.type === 'get_state') console.log(JSON.stringify({ type: 'response', id: request.id, command: 'get_state', success: true, data: {} }));",
			"    if (request.type === 'prompt') { const timer = setInterval(() => {",
			`      if (!existsSync(${JSON.stringify(scratch)})) process.exit(1);`,
			"      if (!existsSync(process.env.PIX_HEADLESS_FIXTURE_RELEASE)) return;",
			"      clearInterval(timer);",
			"      const message = { role:'assistant', content: [{type:'text',text:'MOCK_PI_COMPLETED'}], stopReason:'stop' };",
			"      console.log(JSON.stringify({ type:'message_end', message }));",
			"      console.log(JSON.stringify({ type:'agent_end', messages: [message] }));",
			"      console.log(JSON.stringify({ type:'agent_settled' }));",
			"    }, 20); }",
			"  }",
			"});",
		].join("\n") + "\n";
		// Windows cannot spawn a shebang-only fixture. Use the same compiled
		// Bun child on every OS so native runs also exercise that RPC runtime.
		const source = path.join(scratch, "mock-pi.mjs");
		await writeFile(source, fakePiSource);
		await execFile("bun", ["build", "--compile", source, "--outfile",
			path.join(binaryDir, process.platform === "win32" ? "pi.exe" : "pi")]);
		const env = { ...process.env,
			PATH: `${binaryDir}${path.delimiter}${process.env.PATH ?? ""}`,
			HOME: scratch,
			XDG_CONFIG_HOME: path.join(scratch, "config"),
			PI_CODING_AGENT_DIR: agentDir,
			PIX_HEADLESS_FIXTURE_RELEASE: releaseFile,
		};
		async function call(tool: string, args: Record<string, unknown>) {
			const encoded = Buffer.from(JSON.stringify({ operation: "call", cwd: workspace, readOnly: false,
				model: { provider: "openai", id: "gpt-6" }, tool, args }), "utf8").toString("base64url");
			const { stdout, stderr } = await execFile("node", ["--import", "tsx", CLI, encoded, "--allow-write"], {
				cwd: SUITE_ROOT, env, timeout: 40_000, maxBuffer: 6 * 1024 * 1024,
			});
			const reply = JSON.parse(stdout.trim());
			if (!reply.ok) throw new Error(`${reply.error ?? "failed"}\n${stderr}`);
			return reply.result;
		}
		async function waitForAgent(runDir: string, agentId: string) {
			const finalStatus = await waitForHeadlessSubagentCompletion(runDir, agentId, async () => {
				const status = await call("subagents", { action: "status", runDir });
				const agents = (status.details as { agents?: Array<{ id: string; status: string }> } | undefined)?.agents;
				return agents?.find((agent) => agent.id === agentId)?.status ?? "missing";
			});
			const diagnostics = finalStatus === "done" ? "" : await Promise.all(
				["exit_code", "stderr.log", "progress.jsonl", "events.jsonl"].map(async (file) =>
					`${file}: ${(await readFile(path.join(runDir, agentId, file), "utf8").catch(() => "missing")).slice(-2000)}`),
			);
			expect(finalStatus, String(diagnostics)).toBe("done");
		}
		const spawn = await call("subagents", { action: "spawn", slug: "offline-proof", tasks: [{
			id: "mock-agent", task: "Only use the offline fake pi fixture", subagentType: "project-specialist",
		}] });
		expect(spawn.isError).not.toBe(true);
		expect(spawn.content[0]?.text).toContain("Scheduled 1 agent");
		const runDir = (spawn.details as { runDir: string }).runDir;
		expect(runDir).toContain("offline-proof");
		expect(await readFile(path.join(runDir, "mock-agent", "subagent_type"), "utf8")).toBe("project-specialist");
		expect(await readFile(path.join(runDir, "mock-agent", "model"), "utf8")).toBe("zai/glm-5-turbo");
		// execFile has returned only after the initiating CLI exited. Release
		// the child now, rather than racing that exit against a 350ms timer.
		expect(await readFile(path.join(runDir, "mock-agent", "result.md"), "utf8").catch(() => undefined)).toBeUndefined();
		await writeFile(releaseFile, "release");
		await waitForAgent(runDir, "mock-agent");
		const result = await call("subagents", { action: "result", agentId: "mock-agent", runDir });
		expect(result.isError).not.toBe(true);
		expect(result.content[0]?.text).toContain("MOCK_PI_COMPLETED");

		// Previously this always failed with "No configured candidate is
		// available with confirmed image support": headless omitted the
		// modelRegistry. Test the same CLI/broker path with offline SDK
		// metadata, fake credentials and fake child executable.
		await rm(releaseFile);
		const visual = await call("subagents", { action: "spawn", slug: "offline-ui-qa", tasks: [{
			id: "mock-ui-qa", task: "Validate offline visual model selection only", subagentType: "ui-qa",
		}] });
		expect(visual.isError).not.toBe(true);
		expect(visual.content[0]?.text).toContain("Scheduled 1 agent");
		const visualRun = (visual.details as { runDir: string }).runDir;
		expect(await readFile(path.join(visualRun, "mock-ui-qa", "model"), "utf8")).toBe("zai/glm-5.3-flash");
		await writeFile(releaseFile, "release");
		await waitForAgent(visualRun, "mock-ui-qa");
	} finally {
		await rm(scratch, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
	}
}, 60_000);
