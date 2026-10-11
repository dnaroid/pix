import { test, expect } from "bun:test";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const execFile = promisify(execFileCallback);
const CLI = path.resolve(import.meta.dir, "../src/headless/cli.ts");
const SUITE_ROOT = path.resolve(import.meta.dir, "../../..");

test("detached Pix subagents broker owns RPC pipes after CLI responds (offline fixture)", async () => {
	const scratch = await mkdtemp(path.join(tmpdir(), "pix-headless-agents-"));
	const workspace = path.join(scratch, "project");
	const binaryDir = path.join(scratch, "bin");
	try {
		await mkdir(workspace);
		await mkdir(path.join(workspace, ".pi", "agents"), { recursive: true });
		await writeFile(path.join(workspace, ".pi", "agents", "project-specialist.md"), [
			"---", "description: Offline project-specific specialist", "models: [zai/glm-5-turbo]", "---",
			"This is the project's own specialized role.", "",
		].join("\n"));
		await mkdir(binaryDir);
		const pi = path.join(binaryDir, "pi");
		await writeFile(pi, [
			"#!/usr/bin/env node",
			"let buffer = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', chunk => {",
			"  buffer += chunk;",
			"  while (buffer.includes('\\n')) {",
			"    const index = buffer.indexOf('\\n'); const line = buffer.slice(0,index); buffer = buffer.slice(index+1);",
			"    const request = JSON.parse(line);",
			"    if (request.type === 'get_state') console.log(JSON.stringify({ type: 'response', id: request.id, command: 'get_state', success: true, data: {} }));",
			"    if (request.type === 'prompt') setTimeout(() => {",
			"      const message = { role:'assistant', content: [{type:'text',text:'MOCK_PI_COMPLETED'}], stopReason:'stop' };",
			"      console.log(JSON.stringify({ type:'message_end', message }));",
			"      console.log(JSON.stringify({ type:'agent_end', messages: [message] }));",
			"      console.log(JSON.stringify({ type:'agent_settled' }));",
			"    }, 350);",
			"  }",
			"});",
		].join("\n") + "\n");
		await chmod(pi, 0o755);
		const env = { ...process.env,
			PATH: `${binaryDir}:${process.env.PATH ?? ""}`,
			HOME: scratch,
			XDG_CONFIG_HOME: path.join(scratch, "config"),
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
		const spawn = await call("subagents", { action: "spawn", slug: "offline-proof", tasks: [{
			id: "mock-agent", task: "Only use the offline fake pi fixture", subagentType: "project-specialist",
		}] });
		expect(spawn.isError).not.toBe(true);
		expect(spawn.content[0]?.text).toContain("Scheduled 1 agent");
		const runDir = (spawn.details as { runDir: string }).runDir;
		expect(runDir).toContain("offline-proof");
		expect(await readFile(path.join(runDir, "mock-agent", "subagent_type"), "utf8")).toBe("project-specialist");
		expect(await readFile(path.join(runDir, "mock-agent", "model"), "utf8")).toBe("zai/glm-5-turbo");
		let finalStatus = "";
		for (let attempt = 0; attempt < 25; attempt++) {
			const status = await call("subagents", { action: "status", runDir });
			const agents = (status.details as { agents?: Array<{ status: string }> } | undefined)?.agents;
			finalStatus = agents?.[0]?.status ?? "missing";
			if (["done", "failed", "stopped"].includes(finalStatus)) break;
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		expect(finalStatus).toBe("done");
		const result = await call("subagents", { action: "result", agentId: "mock-agent", runDir });
		expect(result.isError).not.toBe(true);
		expect(result.content[0]?.text).toContain("MOCK_PI_COMPLETED");
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}, 60_000);
