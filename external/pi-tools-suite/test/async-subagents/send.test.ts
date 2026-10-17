import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnAgent } from "../../src/async-subagents/lib.js";
import { ownedAgentDir } from "../../src/async-subagents/core/paths.js";
import { readResultText } from "../../src/async-subagents/core/state.js";
import { createBatch, getRecord, resetSubagentStoreForTest, resolveScope } from "../../src/async-subagents/core/store.js";
import { getLiveChannel } from "../../src/async-subagents/core/live-channel.js";
import { registerSendTool } from "../../src/async-subagents/tools/send.js";
import { getProjectSemaphore } from "../../src/async-subagents/tools/spawn.js";

const tempDirs: string[] = [];
const originalArgv1 = process.argv[1];

afterEach(() => {
	process.argv[1] = originalArgv1;
	resetSubagentStoreForTest();
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function newBatch(cwd: string, slug: string): string {
	return createBatch(cwd, resolveScope(undefined), slug);
}

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
	test.serial("records the launch on the parent record and resumes the same session as a new turn", async () => {
		const cwd = tempDir();
		const runDir = newBatch(cwd, "resume");
		const logFile = path.join(cwd, "prompts.log");
		installEchoPi(logFile);
		await withTimeout(new Promise((resolve) => {
			spawnAgent(runDir, { id: "a1", task: "First task" }, cwd, ["--thinking", "low"], undefined, resolve, { timeoutMs: 60_000 });
		}), "first turn did not complete");
		const record = getRecord(runDir, "a1")!;
		expect(record).toMatchObject({ task: { id: "a1", task: "First task" }, extraArgs: ["--thinking", "low"], timeoutMs: 60_000, turn: 1, status: "done" });
		const sessionFile = record.childSessionFile!;
		expect(sessionFile.startsWith(path.join(cwd, ".pi", "subagents"))).toBe(true);
		expect(readResultText(runDir, "a1")?.startsWith("echo:")).toBe(true);

		const completion: any = await withTimeout(new Promise((resolve) => {
			spawnAgent(runDir, record.task!, cwd, record.extraArgs ?? [], undefined, resolve, { resume: { message: "Second message", sessionFile } });
		}), "resumed turn did not complete");

		expect(completion).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(readResultText(runDir, "a1")).toBe("echo:Second message");
		const log = readLog(logFile);
		expect(log).toHaveLength(2);
		expect(log[1].message).toBe("Second message");
		expect(log[1].args[log[1].args.indexOf("--session") + 1]).toBe(sessionFile);
		// The session file survives (and accumulates) across turns.
		expect(fs.readFileSync(sessionFile, "utf-8").trim().split("\n")).toHaveLength(2);
		expect(log[0].message).toContain("First task");
	});

	test.serial("send tool resumes a finished agent and reports completion", async () => {
		const cwd = tempDir();
		const runDir = newBatch(cwd, "tool-resume");
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
		// Force this turn to queue so no replacement PID can hide stale fields.
		const semaphore = getProjectSemaphore(cwd, 1);
		await semaphore.acquire();
		try {
			const result = await tool.execute("call", { agentId: "a1", runDir, message: "Continue please" }, undefined, undefined, { cwd });
			expect(result.isError).toBeUndefined();
			expect(result.details).toMatchObject({ delivery: "resume", turn: 2 });
			expect(liveAgents.get(runDir)?.get("a1")?.awaitingCompletion).toBe(true);
			expect(getRecord(runDir, "a1")).toMatchObject({ status: "planned" });
			expect(getRecord(runDir, "a1")?.ownerPid).toBe(process.pid);
			expect(getRecord(runDir, "a1")?.pid).toBeUndefined();
			expect(getRecord(runDir, "a1")?.processGroup).toBeUndefined();
			expect(getRecord(runDir, "a1")?.startedAt).toBeUndefined();
		} finally { semaphore.release(); }
		await withTimeout(done, "resumed turn did not complete");
		expect(getRecord(runDir, "a1")?.ownerPid).toBeUndefined();
		expect(completions[0]).toMatchObject({ agentId: "a1", exitCode: 0, state: { status: "done" } });
		expect(readResultText(runDir, "a1")).toBe("echo:Continue please");
		expect(getRecord(runDir, "a1")?.turn).toBe(2);

		const missing = await tool.execute("call", { agentId: "a1", runDir, message: "x", mode: "sideways" }, undefined, undefined, { cwd });
		expect(missing.isError).toBe(true);
	});

	test.serial("queued resume honors a stop appended by another headless caller before its slot opens", async () => {
		const cwd = tempDir(), runDir = newBatch(cwd, "queued-stop"), logFile = path.join(cwd, "prompts.log");
		installEchoPi(logFile);
		await withTimeout(new Promise((resolve) => { spawnAgent(runDir, { id: "a1", task: "First" }, cwd, [], undefined, resolve); }), "first turn did not complete");
		const entries: any[] = [];
		const sessionManager = {
			getEntries: () => entries,
			appendCustomEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); },
		};
		let tool: any, completion: any, resolveDone!: () => void;
		const done = new Promise<void>((resolve) => { resolveDone = resolve; });
		registerSendTool({ registerTool: (t: any) => { tool = t; } } as any, new Map(), (value) => { completion = value; resolveDone(); });
		const semaphore = getProjectSemaphore(cwd, 1);
		await semaphore.acquire();
		try {
			const reply = await tool.execute("call", { agentId: "a1", runDir, message: "Must not launch" }, undefined, undefined, { cwd, sessionManager });
			expect(reply.isError).not.toBe(true);
			const record = getRecord(runDir, "a1")!;
			// This is a journal append, NOT a change to the owner's in-memory record.
			entries.push({ type: "custom", customType: "pi-tools-suite:subagent", data: {
				version: 1, scope: record.scope, batch: record.batch, agentId: "a1", stopRequested: true,
			} });
			expect(record.stopRequested).toBeUndefined();
		} finally { semaphore.release(); }
		await withTimeout(done, "queued stop did not complete");
		expect(completion.state.status).toBe("stopped");
		expect(readLog(logFile)).toHaveLength(1);
	});

	test.serial("send tool refuses to resume when the persisted session is missing", async () => {
		const cwd = tempDir();
		const runDir = newBatch(cwd, "missing-session");
		installEchoPi(path.join(cwd, "prompts.log"));
		await withTimeout(new Promise((resolve) => {
			spawnAgent(runDir, { id: "a1", task: "First task" }, cwd, [], undefined, resolve);
		}), "turn did not complete");
		const sessionFile = getRecord(runDir, "a1")!.childSessionFile!;
		fs.rmSync(sessionFile, { force: true });
		let tool: any;
		registerSendTool({ registerTool: (t: any) => { tool = t; } } as any, new Map(), () => {});
		const result = await tool.execute("call", { agentId: "a1", runDir, message: "again" }, undefined, undefined, { cwd });
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("no persisted session");
		expect(getRecord(runDir, "a1")?.turn).toBe(1);
	});

	test.serial("live follow-up is queued into the running turn and drives the final result", async () => {
		const cwd = tempDir();
		const runDir = newBatch(cwd, "live-followup");
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
		const agentDir = ownedAgentDir(runDir, "a1");
		const channel = getLiveChannel(agentDir);
		expect(channel).toBeDefined();
		const sent = await withTimeout(channel!.send("more", "followUp"), "live send not accepted");
		expect(sent.disposition).toBe("queued");
		await withTimeout(completed, "live turn did not complete");
		expect(completion).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(readResultText(runDir, "a1")).toBe("echo:more");
		expect(getLiveChannel(agentDir)).toBeUndefined();
		await expect(channel!.send("late", "followUp")).rejects.toThrow("finishing");
	});

	test.serial("a live send pending at agent_settled defers termination until the new run settles", async () => {
		const cwd = tempDir();
		const runDir = newBatch(cwd, "live-race");
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
		const agentDir = ownedAgentDir(runDir, "a1");
		const sent = await withTimeout(getLiveChannel(agentDir)!.send("second", "followUp"), "live send not accepted");
		expect(sent.disposition).toBe("started");
		const completion = await withTimeout(completed, "deferred run did not complete");
		expect(completion).toMatchObject({ exitCode: 0, state: { status: "done" } });
		expect(readResultText(runDir, "a1")).toBe("echo:second");
	});
});
