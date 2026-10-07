import { expect, test } from "bun:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import subagentDcp from "../../src/dcp/subagent.js";
import { loadConfig } from "../../src/dcp/config.js";

async function child(enabled = true) {
	const config = loadConfig({ homeDir: "/__subagent_dcp_fixture__" });
	config.enabled = enabled;
	config.debug = false;
	config.compress.autoCompress.enabled = false;
	config.compress.autoCandidates.enabled = false;
	config.compress.messageMode.enabled = false;
	config.strategies.emergencyCurrentTurnPruning.enabled = false;
	const manager = SessionManager.inMemory();
	const handlers = new Map<string, Function[]>();
	const tools = new Map<string, any>();
	const commands: string[] = [];
	let active = ["read"];
	let journalWrites = 0;
	const ctx = {
		hasUI: false, cwd: manager.getCwd(), sessionManager: manager,
		model: { provider: "test", id: "model", contextWindow: 100_000, maxTokens: 2_000 },
		ui: { notify() {} },
		getContextUsage: () => ({ tokens: 2_000, contextWindow: 100_000, percent: 2 }),
	};
	const emit = async (name: string, event: any = {}) => {
		let result: any;
		for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx) ?? result;
		return result;
	};
	await subagentDcp({
		on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand(name: string) { commands.push(name); },
		appendEntry(type: string, data: unknown) {
			if (type === "dcp-journal") journalWrites++;
			manager.appendCustomEntry(type, data);
		},
		sendMessage() {},
		getAllTools: () => [...tools.values(), { name: "read" }],
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
	} as any, { config });
	await emit("session_start", { reason: "new" });
	return { manager, tools, commands, ctx, emit, active: () => active, restrict: (names: string[]) => { active = names; },
		journalWrites: () => journalWrites,
		project: () => emit("context", { messages: manager.buildSessionContext().messages }),
	};
}

test("no-session child compresses in memory without rewriting raw history or writing a journal", async () => {
	const runtime = await child();
	expect(runtime.tools.size).toBe(1);
	expect(runtime.commands).toEqual([]);
	expect(runtime.active()).toEqual(["read", "compress"]);
	for (const event of ["session_start", "model_select"]) {
		runtime.restrict([]);
		await runtime.emit(event, { reason: "new" });
		await runtime.emit(event, { reason: "new" });
		expect(runtime.active()).toEqual(["compress"]);
	}
	const started = await runtime.emit("before_agent_start", { systemPrompt: "Child work instructions" });
	expect(started.systemPrompt).toContain("`compress` is the only DCP context tool");
	runtime.manager.appendMessage({ role: "user", content: "Completed investigation", timestamp: 1 });
	runtime.manager.appendMessage({
		role: "assistant", content: [{ type: "text", text: "old diagnostic evidence ".repeat(500) }],
		api: "openai-responses", provider: "test", model: "model", stopReason: "stop", timestamp: 2,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	} as any);
	runtime.manager.appendMessage({ role: "user", content: "Current request must remain exact", timestamp: 3 });
	const raw = runtime.manager.buildSessionContext().messages;
	const before = await runtime.project();
	const id = JSON.stringify(before.messages.at(-1).content).match(/(m\d+)=a/)?.[1];
	expect(id).toBeDefined();
	const compressed = await runtime.tools.get("compress").execute("compress-call", {
		topic: "Completed investigation", messages: [{ messageId: id, summary: "Investigation finished; no remaining issue." }],
	}, undefined, undefined, runtime.ctx);
	expect(compressed.isError).not.toBe(true);
	const after = await runtime.project();
	expect(JSON.stringify(after.messages)).toContain("Investigation finished; no remaining issue.");
	expect(JSON.stringify(after.messages)).not.toContain("old diagnostic evidence");
	expect(JSON.stringify(after.messages)).toContain("Current request must remain exact");
	expect((await runtime.project()).messages).toEqual(after.messages);
	expect(runtime.manager.buildSessionContext().messages).toEqual(raw);
	expect(runtime.manager.isPersisted()).toBe(false);
	expect(runtime.manager.getSessionFile()).toBeUndefined();
	expect(runtime.journalWrites()).toBe(0);
	const nextAttempt = await child();
	expect(nextAttempt.manager.buildSessionContext().messages).toEqual([]);
	expect(JSON.stringify((await nextAttempt.project()).messages)).not.toContain("Investigation finished");
});

test("child respects disabled DCP configuration and does not activate unregistered compress", async () => {
	const runtime = await child(false);
	await runtime.emit("model_select");
	expect(runtime.tools.size).toBe(0);
	expect(runtime.active()).toEqual(["read"]);
	expect(runtime.commands).toEqual([]);
});
