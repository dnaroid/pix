import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRunDir, spawnAgent } from "../../src/async-subagents/lib.js";
import { archiveAgentTurn, readLaunchSpec, readTurnCount } from "../../src/async-subagents/core/turns.js";
import { getLiveChannel } from "../../src/async-subagents/core/live-channel.js";
import { registerSendTool } from "../../src/async-subagents/tools/send.js";

const tempDirs: string[] = [];
const originalArgv1 = process.argv[1];

afterEach(() => {
	process.argv[1] = originalArgv1;
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "async-subagents-send-"));
	tempDirs.push(dir);
	return dir;
}

async function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 5000): Promise<T> {
	return await Promise.race([
		promise,
		new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
	]);
}

const FAKE_PI_PRELUDE = `
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const sessionDir = opt("--session-dir");
const sessionFile = opt("--session") ?? (sessionDir ? path.join(sessionDir, "session.jsonl") : undefined);
const record = (text) => { if (sessionFile) fs.appendFileSync(sessionFile, text); };
const out = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const assistant = (text) => [{ role: "assistant", content: [{ type: "text", text }] }];
process.on("SIGTERM", () => process.exit(0));
setTimeout(() => {}, 10000);
`;

/** One run per prompt; records prompts/args; get_state reports the session file. */
function installEchoPi(logFile: string): void {
	const script = path.join(tempDir(), "pi.js");
	fs.writeFileSync(script, `${FAKE_PI_PRELUDE}
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.type === "get_state") {
    record("");
    out({ id: req.id, type: "response", command: "get_state", success: true, data: { sessionFile, isStreaming: false, pendingMessageCount: 0 } });
    return;
  }
  if (req.type !== "prompt") return;
  fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ message: req.message, args }) + "\\n");
  record(JSON.stringify({ message: req.message }) + "\\n");
  out({ id: req.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
  out({ type: "agent_start" });
  out({ type: "agent_end", messages: assistant("echo:" + req.message) });
  out({ type: "agent_settled" });
});
`);
	process.argv[1] = script;
}

function readLog(logFile: string): { message: string; args: string[] }[] {
	return fs.readFileSync(logFile, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
}

describe.serial("sub-agent send/resume", () => {
	test.serial("persists launch.json and resumes the same session as a new turn", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "resume");
		const logFile = path.join(cwd, "prompts.log");
		installEchoPi(logFile);
		await withTimeout(new Promise((resolve) => {
			spawnAgent(runDir, { id: "a1", task: "First task" }, cwd, ["--thinking", "low"], undefined, resolve, { timeoutMs: 60_000 });
		}), "first turn did not complete");
		const agentDir = path.join(runDir, "a1");
		const spec = readLaunchSpec(agentDir);
		expect(spec).toMatchObject({ version: 1, task: { id: "a1", task: "First task" }, extraArgs: ["--thinking", "low"], timeoutMs: 60_000 });
		const sessionFile = fs.readFileSync(path.join(agentDir, "session_file"), "utf-8").trim();
		expect(sessionFile.startsWith(path.join(agentDir, "sessions"))).toBe(true);
		const firstResult = fs.readFileSync(path.join(agentDir, "result.md"), "utf-8");
		expect(firstResult.startsWith("echo:")).toBe(true);

		expect(archiveAgentTurn(agentDir, "Second message")).toBe(1);
		expect(fs.existsSync(path.join(agentDir, "result.md"))).toBe(false);
		expect(fs.existsSync(path.join(agentDir, "pid"))).toBe(false);
		const completion: any = await withTimeout(new Promise((resolve) => {
			spawnAgent(runDir, spec!.task, cwd, spec!.extraArgs, undefined, resolve, { resume: { message: "Second message", sessionFile } });
		}), "resumed turn did not complete");

		expect(completion).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(fs.readFileSync(path.join(agentDir, "result.md"), "utf-8")).toBe("echo:Second message");
		expect(fs.readFileSync(path.join(agentDir, "turns", "1", "result.md"), "utf-8")).toBe(firstResult);
		// Turn 1 started from prompt.md; the resumed turn's message is recorded alongside it.
		expect(fs.existsSync(path.join(agentDir, "turns", "1", "turn_message.md"))).toBe(false);
		expect(fs.readFileSync(path.join(agentDir, "turn_message.md"), "utf-8")).toBe("Second message");
		expect(readTurnCount(agentDir)).toBe(1);
		const log = readLog(logFile);
		expect(log).toHaveLength(2);
		expect(log[1].message).toBe("Second message");
		expect(log[1].args[log[1].args.indexOf("--session") + 1]).toBe(sessionFile);
		// The session file survives (and accumulates) across turns.
		expect(fs.readFileSync(sessionFile, "utf-8").trim().split("\n")).toHaveLength(2);
		expect(fs.readFileSync(path.join(agentDir, "prompt.md"), "utf-8")).toContain("First task");
	});

	test.serial("send tool resumes a finished agent and reports completion", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "tool-resume");
		const logFile = path.join(cwd, "prompts.log");
		installEchoPi(logFile);
		await withTimeout(new Promise((resolve) => {
			spawnAgent(runDir, { id: "a1", task: "First task" }, cwd, [], undefined, resolve);
		}), "first turn did not complete");

		let tool: any;
		const completions: any[] = [];
		let resolveDone!: () => void;
		const done = new Promise<void>((resolve) => { resolveDone = resolve; });
		const liveAgents = new Map();
		registerSendTool({ registerTool: (t: any) => { tool = t; } } as any, liveAgents, (completion) => {
			completions.push(completion);
			resolveDone();
		});
		const result = await tool.execute("call", { agentId: "a1", runDir, message: "Continue please" }, undefined, undefined, { cwd });
		expect(result.isError).toBeUndefined();
		expect(result.details).toMatchObject({ delivery: "resume", turn: 2 });
		expect(liveAgents.get(runDir)?.get("a1")?.awaitingCompletion).toBe(true);
		await withTimeout(done, "resumed turn did not complete");
		expect(completions[0]).toMatchObject({ agentId: "a1", exitCode: 0, state: { status: "done" } });
		expect(fs.readFileSync(path.join(runDir, "a1", "result.md"), "utf-8")).toBe("echo:Continue please");

		const missing = await tool.execute("call", { agentId: "a1", runDir, message: "x", mode: "sideways" }, undefined, undefined, { cwd });
		expect(missing.isError).toBe(true);
	});

	test.serial("send tool refuses to resume when the persisted session is missing", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "missing-session");
		installEchoPi(path.join(cwd, "prompts.log"));
		await withTimeout(new Promise((resolve) => {
			spawnAgent(runDir, { id: "a1", task: "First task" }, cwd, [], undefined, resolve);
		}), "turn did not complete");
		const agentDir = path.join(runDir, "a1");
		expect((JSON.parse(fs.readFileSync(path.join(agentDir, "launch.json"), "utf-8")).piArgs as string[]).join("\n")).not.toContain("--no-session");
		fs.rmSync(path.join(agentDir, "sessions"), { recursive: true, force: true });
		let tool: any;
		registerSendTool({ registerTool: (t: any) => { tool = t; } } as any, new Map(), () => {});
		const result = await tool.execute("call", { agentId: "a1", runDir, message: "again" }, undefined, undefined, { cwd });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("no persisted session");
		expect(fs.existsSync(path.join(agentDir, "turns"))).toBe(false);
	});

	test.serial("live follow-up is queued into the running turn and drives the final result", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "live-followup");
		const script = path.join(tempDir(), "pi.js");
		fs.writeFileSync(script, `${FAKE_PI_PRELUDE}
let streaming = false; const queue = []; let last = "";
const finishLater = () => setTimeout(() => {
  if (queue.length) { last = queue.shift(); out({ type: "message_end", message: assistant("echo:" + last)[0] }); finishLater(); return; }
  streaming = false;
  out({ type: "agent_end", messages: assistant("echo:" + last) });
  out({ type: "agent_settled" });
}, 150);
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.type === "get_state") {
    out({ id: req.id, type: "response", command: "get_state", success: true, data: { sessionFile, isStreaming: streaming, pendingMessageCount: queue.length } });
    return;
  }
  if (req.type !== "prompt") return;
  if (streaming) {
    queue.push(req.message);
    out({ id: req.id, type: "response", command: "prompt", success: true, data: { disposition: "queued" } });
    return;
  }
  streaming = true; last = req.message;
  out({ id: req.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
  out({ type: "agent_start" });
  finishLater();
});
`);
		process.argv[1] = script;
		let completion: any;
		const completed = new Promise((resolve) => {
			spawnAgent(runDir, { id: "a1", task: "First task" }, cwd, [], undefined, (value) => { completion = value; resolve(value); });
		});
		const agentDir = path.join(runDir, "a1");
		const channel = getLiveChannel(agentDir);
		expect(channel).toBeDefined();
		const sent = await withTimeout(channel!.send("more", "followUp"), "live send not accepted");
		expect(sent.disposition).toBe("queued");
		await withTimeout(completed, "live turn did not complete");
		expect(completion).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(fs.readFileSync(path.join(agentDir, "result.md"), "utf-8")).toBe("echo:more");
		expect(getLiveChannel(agentDir)).toBeUndefined();
		await expect(channel!.send("late", "followUp")).rejects.toThrow("finishing");
	});

	test.serial("a live send pending at agent_settled defers termination until the new run settles", async () => {
		const cwd = tempDir();
		const runDir = createRunDir(cwd, "live-race");
		const script = path.join(tempDir(), "pi.js");
		// Mimics pi deferring a prompt received while it emits agent_settled.
		fs.writeFileSync(script, `${FAKE_PI_PRELUDE}
let streaming = false; let deferred;
const startRun = (req, text) => {
  streaming = true;
  out({ id: req.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
  out({ type: "agent_start" });
  setTimeout(() => {
    streaming = false;
    out({ type: "agent_end", messages: assistant(text) });
    out({ type: "agent_settled" });
    if (deferred) { const next = deferred; deferred = undefined; setTimeout(() => startRun(next, "echo:" + next.message), 80); }
  }, 150);
};
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.type === "get_state") {
    out({ id: req.id, type: "response", command: "get_state", success: true, data: { sessionFile, isStreaming: streaming, pendingMessageCount: deferred ? 1 : 0 } });
    return;
  }
  if (req.type !== "prompt") return;
  if (streaming) { deferred = req; return; }
  startRun(req, "echo:first");
});
`);
		process.argv[1] = script;
		const completed = new Promise<any>((resolve) => {
			spawnAgent(runDir, { id: "a1", task: "First task" }, cwd, [], undefined, resolve);
		});
		const agentDir = path.join(runDir, "a1");
		const sent = await withTimeout(getLiveChannel(agentDir)!.send("second", "followUp"), "live send not accepted");
		expect(sent.disposition).toBe("started");
		const completion = await withTimeout(completed, "deferred run did not complete");
		expect(completion).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(fs.readFileSync(path.join(agentDir, "result.md"), "utf-8")).toBe("echo:second");
	});
});
