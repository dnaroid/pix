import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CompletionDelivery } from "../../src/async-subagents/completion-delivery.js";
import type { LiveAgent } from "../../src/async-subagents/types.js";
import type { AgentState, RunState } from "../../src/async-subagents/lib.js";

function tracked(agentId = "child", parentSession = "/parent"): LiveAgent {
	return { runDir: "/run", agentId, parentSession, completed: Promise.resolve() };
}

function snapshot(status: AgentState["status"] = "done", id = "child"): RunState {
	return { runDir: "/run", agents: [{ id, status }] };
}

function deliveryHarness(agents = [tracked()]) {
	const liveRun = new Map(agents.map((agent) => [agent.agentId, agent]));
	const live = new Map([["/run", liveRun]]);
	let refreshes = 0;
	const delivery = new CompletionDelivery(live, () => { refreshes++; });
	return { live, liveRun, delivery, refreshes: () => refreshes };
}

describe("completion delivery arbitration", () => {
	for (const status of ["done", "failed", "stopped"] as const) {
		test(`acknowledges a returned ${status} snapshot before releasing the reservation`, () => {
			const agent = tracked();
			const { live, delivery, refreshes } = deliveryHarness([agent]);
			const wait = delivery.begin("/parent", [agent]);
			expect(delivery.isReserved(agent)).toBe(true);
			wait.finish(snapshot(status));
			expect(live.size).toBe(0);
			expect(delivery.isReserved(agent)).toBe(false);
			expect(refreshes()).toBe(1);
			wait.finish(snapshot(status));
			expect(refreshes()).toBe(1);
		});
	}

	test("timeout commits only terminal agents in the returned snapshot", () => {
		const done = tracked();
		const running = tracked("other");
		const { liveRun, delivery } = deliveryHarness([done, running]);
		const wait = delivery.begin("/parent", [done, running]);
		wait.finish({ ...snapshot(), agents: [...snapshot().agents, { id: "other", status: "running" }] });
		expect([...liveRun.keys()]).toEqual(["other"]);
		expect(delivery.isReserved(running)).toBe(false);
	});

	test("abort, errors and stale running snapshots do not acknowledge completion", () => {
		for (const reason of ["abort", "error", "timeout"] as const) {
			const agent = tracked();
			const { liveRun, delivery } = deliveryHarness([agent]);
			const wait = delivery.begin("/parent", [agent]);
			const controller = new AbortController();
			if (reason === "abort") controller.abort();
			wait.finish(reason === "error" ? undefined : snapshot(reason === "timeout" ? "running" : "done"), controller.signal);
			expect(liveRun.get("child")).toBe(agent);
			expect(delivery.isReserved(agent)).toBe(false);
		}
	});

	test("overlapping waits release only their own reservation", () => {
		const agent = tracked();
		const { delivery } = deliveryHarness([agent]);
		const first = delivery.begin("/parent", [agent]);
		const second = delivery.begin("/parent", [agent]);
		first.finish();
		expect(delivery.isReserved(agent)).toBe(true);
		second.finish();
		expect(delivery.isReserved(agent)).toBe(false);
	});

	test("another session and a replacement launch cannot be acknowledged", () => {
		const agent = tracked();
		const { delivery, liveRun } = deliveryHarness([agent]);
		const foreign = delivery.begin("/sibling", [agent]);
		expect(delivery.isReserved(agent)).toBe(false);
		foreign.finish(snapshot());
		expect(liveRun.get("child")).toBe(agent);
		const original = delivery.begin("/parent", [agent]);
		const replacement = tracked();
		liveRun.set("child", replacement);
		original.finish(snapshot());
		expect(liveRun.get("child")).toBe(replacement);
	});

	test("intermediate receipts are not terminal until the final callback settles", () => {
		const agent = tracked();
		agent.awaitingCompletion = true;
		const { delivery, liveRun } = deliveryHarness([agent]);
		const wait = delivery.begin("/parent", [agent]);
		expect(delivery.settledState(snapshot("failed")).agents[0]?.status).toBe("running");
		wait.finish(snapshot("failed"));
		expect(liveRun.get("child")).toBe(agent);
		agent.awaitingCompletion = false;
		expect(delivery.settledState(snapshot()).agents[0]?.status).toBe("done");
	});
});

// Exercise the actual entrypoint and unified tool. Terminal receipts and refresh
// calls are driven explicitly, rather than racing arbitrary completion timers.
const scratchRoot = fileURLToPath(new URL("../../../../.pi/artifacts/completion-delivery-tests/", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function entryHarness(ids = ["child"]) {
	const { default: register } = await import("../../src/async-subagents/index.js");
	const { createBatch, resolveScope, updateRecord } = await import("../../src/async-subagents/core/store.js");
	fs.mkdirSync(scratchRoot, { recursive: true });
	const cwd = fs.mkdtempSync(path.join(scratchRoot, "case-"));
	dirs.push(cwd);
	const parent = path.join(cwd, "parent.jsonl");
	let busy = false;
	const ctx = { cwd, isIdle: () => !busy, sessionManager: { getSessionFile: () => parent, getSessionId: () => parent, getLeafId: () => "spawn-entry" } };
	const runDir = createBatch(cwd, resolveScope(ctx.sessionManager), "delivery");
	for (const id of ids) {
		updateRecord(runDir, id, { cwd, status: "running", pid: process.pid, parentSession: parent, startedAt: new Date().toISOString(), turn: 1 });
	}
	const tools = new Map<string, any>();
	const handlers = new Map<string, any>();
	const messages: any[] = [];
	const messageOptions: unknown[] = [];
	const evidenceEvents: any[] = [];
	register({
		events: { emit: (channel: string, event: unknown) => { if (channel === "async-subagents:delegated-evidence") evidenceEvents.push(event); } },
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand() {},
		on: (event: string, handler: any) => handlers.set(event, handler),
		sendMessage: (message: any, options: unknown) => { messages.push(message); messageOptions.push(options); },
	} as any);
	await handlers.get("session_start")({}, ctx);
	return {
		ctx, runDir, messages, messageOptions, evidenceEvents,
		setBusy: (value: boolean) => { busy = value; },
		boundary: (context = ctx, outcome = "completed", canContinue = true) => handlers.get("agent_before_settle")({ outcome, context: { canContinue } }, context),
		settle: (aborted = false) => { busy = false; return handlers.get("agent_settled")({ aborted }, ctx); },
		start: () => { busy = true; return handlers.get("agent_start")({}, ctx); },
		startTool: (event: any, context = ctx) => handlers.get("tool_call")(event, context),
		endTool: (event: any, context = ctx) => handlers.get("tool_execution_end")({ ...event, result: { content: event.content, details: event.details } }, context),
		result: () => tools.get("subagents").execute("result", { action: "result", runDir, agentId: "child" }, undefined, undefined, ctx),
		finish: (id = "child", code = "0") => {
			updateRecord(runDir, id, code === "stopped"
				? { status: "stopped", stopRequested: true, exitCode: null, finishedAt: new Date().toISOString() }
				: { status: code === "0" ? "done" : "failed", exitCode: Number(code), finishedAt: new Date().toISOString() });
		},
		refresh: () => handlers.get("tool_execution_end")({ toolName: "subagents" }),
		close: (stopChildren = false) => handlers.get("session_shutdown")(stopChildren ? {} : { reason: "reload" }, ctx),
		wait: (params: any = {}, onUpdate?: (update: any) => void, signal?: AbortSignal, context = ctx) =>
			tools.get("subagents").execute("wait", { action: "wait", runDir, timeout: 0, ...params }, signal, onUpdate, context),
		spawn: (watchSeconds: number, onUpdate?: () => void, subagentType = "research") => tools.get("subagents").execute("spawn", {
			action: "spawn", runDir, watchSeconds,
			tasks: [{ id: "child", task: "Return a result", subagentType }],
		}, undefined, onUpdate, ctx),
	};
}

describe.serial("completion delivery through the entrypoint", () => {
	test("normal settlement releases the watcher gate and wakes the parent once", async () => {
		const h = await entryHarness();
		try {
			await h.start();
			h.finish();
			h.setBusy(false);
			await h.refresh();
			expect(h.messages).toHaveLength(0);
			await h.settle(false);
			await h.refresh();
			expect(h.messages).toHaveLength(1);
			expect(h.messageOptions[0]).toMatchObject({ triggerTurn: true, deliverAs: "followUp" });
		} finally { await h.close(); }
	});

	test("watcher cannot wake an idle-looking parent before its aborted settlement hook", async () => {
		const h = await entryHarness();
		try {
			await h.start();
			h.finish();
			// The SDK exposes idle while an earlier extension's asynchronous
			// agent_settled handler is still pending.
			h.setBusy(false);
			await h.refresh();
			expect(h.messages).toHaveLength(0);
			await h.settle(true);
			await h.refresh();
			expect(h.messages).toHaveLength(0);
		} finally { await h.close(); }
	});

	for (const timing of ["before-abort", "after-abort"] as const) {
		test(`completion ${timing} cannot restart an interrupted parent`, async () => {
			const h = await entryHarness();
			try {
				h.setBusy(true);
				if (timing === "before-abort") h.finish();
				await h.settle(true);
				if (timing === "after-abort") h.finish();
				await h.refresh();
				await h.refresh();
				expect(h.messages).toHaveLength(0);
				await h.start();
				expect(h.boundary().entries).toHaveLength(1);
				expect(h.boundary()).toBeUndefined();
				await h.settle();
				expect(h.messages).toHaveLength(0);
			} finally { await h.close(); }
		});
	}

	test("result consumed after busy completion does not schedule a second report", async () => {
		const h = await entryHarness();
		try {
			h.setBusy(true);
			h.finish();
			await h.refresh();
			expect(h.messages).toHaveLength(0);
			const event = { toolCallId: "result", toolName: "subagents", input: { action: "result", runDir: h.runDir, agentId: "child" } };
			await h.startTool(event);
			await h.endTool({ ...event, ...await h.result(), isError: false });
			expect(h.boundary()).toBeUndefined();
			await h.settle();
			expect(h.messages).toHaveLength(0);
		} finally { await h.close(); }
	});

	test("unconsumed busy completions share one boundary continuation", async () => {
		const h = await entryHarness(["child", "other"]);
		try {
			h.setBusy(true);
			h.finish(); h.finish("other", "1");
			await h.refresh();
			expect(h.messages).toHaveLength(0);
			const boundary = h.boundary();
			expect(boundary.continue).toBe(true);
			expect(boundary.entries.map((entry: any) => entry.details.agentId).sort()).toEqual(["child", "other"]);
			expect(h.boundary()).toBeUndefined();
			await h.settle();
			expect(h.messages).toHaveLength(0);
		} finally { await h.close(); }
	});

	test("a completion after the boundary still wakes the idle parent", async () => {
		const h = await entryHarness();
		try {
			h.setBusy(true);
			expect(h.boundary()).toBeUndefined();
			h.finish("child", "1");
			await h.refresh();
			expect(h.messages).toHaveLength(0);
			await h.settle();
			expect(h.messages).toHaveLength(1);
			expect(h.messages[0].details.status).toBe("failed");
		} finally { await h.close(); }
	});

	test("foreign, aborted and noncontinuable boundaries do not consume pending results", async () => {
		const h = await entryHarness();
		try {
			h.setBusy(true); h.finish();
			const sibling = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionFile: () => "/sibling" } };
			expect(h.boundary(sibling)).toBeUndefined();
			expect(h.boundary(h.ctx, "aborted")).toBeUndefined();
			expect(h.boundary(h.ctx, "completed", false)).toBeUndefined();
			expect(h.boundary().entries).toHaveLength(1);
		} finally { await h.close(); }
	});
	test("routing rejection retires the observer launch without delivering a completion", async () => {
		const h = await entryHarness([]);
		try {
			const result = await h.spawn(0, undefined, "definitely-not-an-available-role");
			expect(result.isError).toBe(true);
			expect(h.evidenceEvents.map((event) => event.phase)).toEqual(["started", "retired"]);
			expect(h.evidenceEvents[0].launchId).toBe(h.evidenceEvents[1].launchId);
			expect(h.messages).toHaveLength(0);
		} finally { await h.close(); }
	});
	for (const mode of ["spawn", "wait"]) {
		test(`${mode} consumes the in-process final callback without a follow-up`, async () => {
			const h = await entryHarness([]);
			const originalArgv = process.argv[1];
			const script = path.join(h.ctx.cwd, "pi.js");
			const release = path.join(h.ctx.cwd, "release");
			fs.writeFileSync(script, `
const fs = require("node:fs");
let buffer = "";
process.stdin.on("data", (data) => {
  buffer += data;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const command = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (command.type !== "prompt") continue;
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(release)})) return;
      clearInterval(timer);
      console.log(JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "finished" }] }] }));
      console.log(JSON.stringify({ type: "agent_settled" }));
    }, 10);
  }
});
`);
			process.argv[1] = script;
			try {
				const releaseChild = () => { fs.writeFileSync(release, ""); };
				if (mode === "wait") await h.spawn(0);
				const result = mode === "spawn"
					? await h.spawn(3, releaseChild)
					: await h.wait({ timeout: 3, interval: 0.25 }, releaseChild);
				expect(result.details.agents[0].status).toBe("done");
				await h.refresh();
				expect(h.messages).toHaveLength(0);
				for (let i = 0; i < 100 && !h.evidenceEvents.some((event) => event.phase === "completed"); i++) await Bun.sleep(10);
				expect(h.evidenceEvents.map((event) => event.phase)).toEqual(["started", "completed"]);
				expect(h.evidenceEvents[1].report).toContain("finished");
			} finally {
				process.argv[1] = originalArgv;
				await h.close(true);
			}
		});
	}

	for (const code of ["0", "1", "stopped"]) {
		test(`wait consumes terminal receipt ${code} without a follow-up`, async () => {
			const h = await entryHarness();
			try {
				h.finish("child", code);
				const result = await h.wait({}, () => { void h.refresh(); });
				expect(result.details.agents[0].status).toBe(code === "0" ? "done" : code === "1" ? "failed" : "stopped");
				await h.refresh();
				expect(h.messages).toHaveLength(0);
			} finally { await h.close(); }
		});
	}

	test("completion between the final poll and timeout return still wakes the parent", async () => {
		const h = await entryHarness();
		try {
			const result = await h.wait({}, () => { h.finish(); void h.refresh(); });
			expect(result.details.agents[0].status).toBe("running");
			expect(h.messages).toHaveLength(1);
			await h.refresh();
			expect(h.messages).toHaveLength(1);
		} finally { await h.close(); }
	});

	test("abort and thrown update release pending notifications", async () => {
		for (const mode of ["abort", "throw"]) {
			const h = await entryHarness();
			const controller = new AbortController();
			try {
				h.finish();
				const waiting = h.wait({}, () => {
					void h.refresh();
					if (mode === "throw") throw new Error("update failed");
					controller.abort();
				}, controller.signal);
				if (mode === "throw") await expect(waiting).rejects.toThrow("update failed");
				else await waiting;
				expect(h.messages).toHaveLength(1);
			} finally { await h.close(); }
		}
	});

	test("a filtered wait consumes only selected completions", async () => {
		const h = await entryHarness(["child", "other"]);
		try {
			h.finish();
			h.finish("other");
			await h.wait({ agentIds: ["child"] }, () => { void h.refresh(); });
			expect(h.messages.map((message) => message.details.agentId)).toEqual(["other"]);
		} finally { await h.close(); }
	});

	test("fail-fast delivers the failed child but leaves the running child eligible", async () => {
		const h = await entryHarness(["child", "other"]);
		try {
			h.finish("child", "1");
			await h.wait({ failFast: true, timeout: 10 }, () => { void h.refresh(); });
			expect(h.messages).toHaveLength(0);
			h.finish("other");
			await h.refresh();
			expect(h.messages.map((message) => message.details.agentId)).toEqual(["other"]);
		} finally { await h.close(); }
	});

	test("a sibling session cannot consume the originating parent's completion", async () => {
		const h = await entryHarness();
		try {
			h.finish();
			const sibling = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => "sibling", getSessionFile: () => path.join(h.ctx.cwd, "sibling.jsonl") } };
			await h.wait({}, undefined, undefined, sibling);
			expect(h.messages).toHaveLength(1);
		} finally { await h.close(); }
	});
});
