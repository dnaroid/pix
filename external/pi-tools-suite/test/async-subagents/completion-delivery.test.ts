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
	const { createRunDir } = await import("../../src/async-subagents/lib.js");
	fs.mkdirSync(scratchRoot, { recursive: true });
	const cwd = fs.mkdtempSync(path.join(scratchRoot, "case-"));
	dirs.push(cwd);
	const parent = path.join(cwd, "parent.jsonl");
	let busy = false;
	const ctx = { cwd, isIdle: () => !busy, sessionManager: { getSessionFile: () => parent, getSessionId: () => parent, getLeafId: () => "spawn-entry" } };
	const runDir = createRunDir(cwd, "delivery");
	for (const id of ids) {
		const dir = path.join(runDir, id);
		fs.mkdirSync(dir, { recursive: true });
		for (const [name, content] of Object.entries({ "prompt.md": id, pid: String(process.pid), parent_session: parent })) {
			fs.writeFileSync(path.join(dir, name), content);
		}
	}
	const tools = new Map<string, any>();
	const handlers = new Map<string, any>();
	const messages: any[] = [];
	const evidenceEvents: any[] = [];
	register({
		events: { emit: (channel: string, event: unknown) => { if (channel === "async-subagents:delegated-evidence") evidenceEvents.push(event); } },
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand() {},
		on: (event: string, handler: any) => handlers.set(event, handler),
		sendMessage: (message: any) => messages.push(message),
	} as any);
	await handlers.get("session_start")({}, ctx);
	return {
		ctx, runDir, messages, evidenceEvents,
		setBusy: (value: boolean) => { busy = value; },
		boundary: (context = ctx, outcome = "completed", canContinue = true) => handlers.get("agent_before_settle")({ outcome, context: { canContinue } }, context),
		settle: () => { busy = false; return handlers.get("agent_settled")({}, ctx); },
		startTool: (event: any, context = ctx) => handlers.get("tool_call")(event, context),
		endTool: (event: any, context = ctx) => handlers.get("tool_execution_end")({ ...event, result: { content: event.content, details: event.details } }, context),
		result: () => tools.get("subagents").execute("result", { action: "result", runDir, agentId: "child" }, undefined, undefined, ctx),
		finish: (id = "child", code = "0") => fs.writeFileSync(path.join(runDir, id, "exit_code"), code),
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

	for (const mode of ["full", "partial", "error", "changed", "late-error", "aborted", "sibling", "nonterminal", "shutdown"]) {
		test(`direct artifact read: ${mode}`, async () => {
			const h = await entryHarness();
			try {
				h.setBusy(true);
				const file = path.join(h.runDir, "child", "result.md");
				fs.writeFileSync(file, "audit complete\nno changes\n");
				if (mode !== "nonterminal") h.finish();
				await h.refresh();
				const event = { toolCallId: "read", toolName: "read", input: { path: file } };
				await h.startTool(event);
				if (mode === "nonterminal") h.finish();
				if (mode === "late-error") h.finish("child", "1");
				if (mode === "changed") fs.writeFileSync(file, "new version");
				if (mode === "shutdown") await h.close();
				const controller = new AbortController();
				if (mode === "aborted") controller.abort();
				const context = mode === "sibling"
					? { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionFile: () => "/sibling" } }
					: { ...h.ctx, signal: controller.signal };
				await h.endTool({ ...event, isError: mode === "error", content: [{ type: "text", text: mode === "partial" ? "audit complete" : "audit complete\nno changes\n" }] }, context);
				const boundary = h.boundary();
				if (mode === "full" || mode === "shutdown") expect(boundary).toBeUndefined();
				else expect(boundary.entries).toHaveLength(1);
				expect(h.messages).toHaveLength(0);
			} finally { await h.close(); }
		});
	}

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
