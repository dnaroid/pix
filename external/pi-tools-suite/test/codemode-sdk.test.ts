import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession, createCodemodeExtension, DefaultResourceLoader,
	SessionManager, SettingsManager, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import codemode from "../src/codemode/index.js";
import sessionTools from "../src/session/index.js";

const cleanups: (() => void)[] = [];
beforeEach(() => {
	// These tests exercise an unrestricted parent, even when run by a subagent.
	for (const key of ["PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION", "MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION"]) {
		const previous = process.env[key];
		delete process.env[key];
		cleanups.push(() => {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		});
	}
});
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function sessionHarness(code: string, extensions: ExtensionFactory[] = []) {
	const root = mkdtempSync(join(tmpdir(), "suite-codemode-sdk-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: root, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [...extensions, codemode],
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	const model = fauxProvider({ provider: "suite-codemode" }).getModel();
	const responses = [fauxAssistantMessage(fauxToolCall("codemode", { code }, { id: "script" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")];
	const contexts: any[] = [];
	const modelRuntime = {
		streamSimple: (_model: unknown, context: unknown) => {
			contexts.push(structuredClone(context));
			const response = responses.shift();
			if (!response) throw new Error("unexpected provider call");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: response.stopReason as "stop" | "toolUse", message: response });
				stream.end(response);
			});
			return stream;
		},
		getModels: () => [model], getModel: () => model, getProviders: () => [],
		getAvailableSnapshot: () => [model], hasConfiguredAuth: () => true, isUsingOAuth: () => false,
	} as any;
	const { session } = await createAgentSession({
		cwd: root, agentDir: root, resourceLoader: loader, settingsManager,
		sessionManager: SessionManager.inMemory(root), model, modelRuntime, thinkingLevel: "off",
	});
	cleanups.push(() => session.dispose());
	await session.bindExtensions({});
	const events: any[] = [];
	const unsubscribe = session.subscribe((event) => events.push(event));
	cleanups.push(unsubscribe);
	return { session, events, contexts };
}

test("real SDK runs QuickJS alongside direct tools and retains nested-call events, not separate transcript messages", async () => {
	const calls: string[] = [];
	const { session, events, contexts } = await sessionHarness('console.log(await tools.echo({ text: "quickjs-ok" }))', [(pi) => {
		pi.registerTool({ name: "echo", label: "Echo", description: "Test echo", parameters: Type.Object({ text: Type.String() }),
			execute: async (_id, args) => ({ content: [{ type: "text", text: args.text }], details: {} }) });
		pi.on("tool_call", (event) => { calls.push(event.toolName); });
	}]);
	expect(session.getActiveToolNames()).toContain("codemode");
	expect(session.getActiveToolNames()).toContain("read");
	await session.prompt("run script");
	expect(calls).toEqual(["codemode", "echo"]);
	const results = session.messages.filter((message) => message.role === "toolResult");
	expect(results).toHaveLength(1);
	expect(JSON.stringify(results[0])).toContain("quickjs-ok");
	expect(events.some((event) => event.type === "tool_execution_start" && event.toolName === "echo" && event.parentToolCallId === "script")).toBe(true);
	const declared = contexts[0].messages.flatMap((message: any) => message.role === "system" ? message.toolsAdded ?? [] : []);
	expect(declared.some((tool: any) => tool.name === "read")).toBe(true);
	expect(declared.some((tool: any) => tool.name === "codemode")).toBe(true);
});

test("session actions share one schema and dispatch through real SDK codemode", async () => {
	const { session, events, contexts } = await sessionHarness(`
		console.log(await tools.session({ action: "name", name: "Codemode session" }));
		console.log(await tools.session({ action: "name" }));
		console.log(await tools.session({ action: "overview", max_sections: 1 }));
	`, [sessionTools]);
	expect(session.getAllTools().filter((tool) => tool.name === "session")).toHaveLength(1);
	expect(session.getActiveToolNames()).not.toContain("session_name");
	await session.prompt("run script");
	const result = JSON.stringify(session.messages.filter((message) => message.role === "toolResult"));
	expect(result).toContain("Session name set: Codemode session");
	expect(result).toContain("Current session name: Codemode session");
	expect(result).toContain("selectedEntries");
	expect(events.filter((event) => event.type === "tool_execution_start" && event.toolName === "session" && event.parentToolCallId === "script")).toHaveLength(3);
	const declared = contexts[0].messages.flatMap((message: any) => message.role === "system" ? message.toolsAdded ?? [] : []);
	expect(declared.filter((tool: any) => tool.name === "session")).toHaveLength(1);
});

test("nested calls respect blockers and cannot reach inactive direct tools", async () => {
	let executed = false;
	const { session } = await sessionHarness('try { await tools.denied({}); } catch (e) { console.log(String(e)); } console.log("inactive" in tools)', [(pi) => {
		for (const name of ["denied", "inactive"]) pi.registerTool({ name, label: name, description: name, defaultActive: name !== "inactive", parameters: Type.Object({}),
			execute: async () => { executed = true; return { content: [{ type: "text", text: "unsafe" }], details: {} }; } });
		pi.on("tool_call", (event) => event.toolName === "denied" ? { block: true, reason: "denied by policy" } : undefined);
	}]);
	await session.prompt("run script");
	expect(executed).toBe(false);
	const result = JSON.stringify(session.messages.filter((message) => message.role === "toolResult"));
	expect(result).toContain("denied by policy");
	expect(result).toContain("false");
});

test("CLI builtin coexists without duplicate registrations", async () => {
	const { session } = await sessionHarness('console.log(6 * 7)', [createCodemodeExtension()]);
	expect(session.getAllTools().filter((tool) => tool.name === "codemode")).toHaveLength(1);
	await session.prompt("run script");
	expect(JSON.stringify(session.messages.filter((message) => message.role === "toolResult"))).toContain("42");
});

test("aborting a parent script cancels its pending nested call", async () => {
	let started!: () => void;
	const pending = new Promise<void>((resolve) => { started = resolve; });
	let aborted = false;
	const { session } = await sessionHarness('await tools.pending({})', [(pi) => {
		pi.registerTool({ name: "pending", label: "Pending", description: "Wait until aborted", parameters: Type.Object({}),
			execute: async (_id, _args, signal) => new Promise<{ content: { type: "text"; text: string }[]; details: {} }>((resolve) => {
				const finish = () => { aborted = true; resolve({ content: [{ type: "text", text: "aborted" }], details: {} }); };
				if (signal?.aborted) finish();
				else signal?.addEventListener("abort", finish, { once: true });
				started();
			}) });
	}]);
	const prompt = session.prompt("run script");
	await pending;
	await session.abort();
	await prompt;
	expect(aborted).toBe(true);
}, 10000);
