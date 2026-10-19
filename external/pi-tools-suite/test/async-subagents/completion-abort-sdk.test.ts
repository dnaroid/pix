import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import registerSubagents from "../../src/async-subagents/index.js";
import { createBatch, resetSubagentStoreForTest, resolveScope, updateRecord } from "../../src/async-subagents/core/store.js";

test("real SDK abort settles without starting a completion turn; next prompt receives the result once", async () => {
	const scratch = fileURLToPath(new URL("../../../../.pi/artifacts/completion-abort-sdk-tests/", import.meta.url));
	fs.mkdirSync(scratch, { recursive: true });
	const cwd = fs.mkdtempSync(path.join(scratch, "case-"));
	const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	resetSubagentStoreForTest();
	const runDir = createBatch(cwd, resolveScope(sessionManager), "completion-abort");
	updateRecord(runDir, "child", { status: "running", pid: process.pid, parentSession: sessionManager.getSessionFile()!, turn: 1 }, sessionManager);
	let toolStarted!: () => void;
	const started = new Promise<void>((resolve) => { toolStarted = resolve; });
	const loader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		extensionFactories: [registerSubagents, (pi) => {
			pi.registerTool({
				name: "pending", label: "Pending", description: "Wait until aborted", parameters: Type.Object({}),
				execute: async (_id, _args, signal) => new Promise<{ content: { type: "text"; text: string }[]; details: {} }>((resolve) => {
					const finish = () => resolve({ content: [{ type: "text", text: "aborted" }], details: {} });
					if (signal?.aborted) finish();
					else signal?.addEventListener("abort", finish, { once: true });
					toolStarted();
				}),
			});
		}],
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	const model = fauxProvider({ provider: "completion-abort-contract" }).getModel();
	let requests = 0;
	const modelRuntime = {
		streamSimple: (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
			if (options.signal?.aborted) {
				const response = fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Aborted" });
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "error", reason: "aborted", error: response });
					stream.end(response);
				});
				return stream;
			}
			const response = requests++ === 0
				? fauxAssistantMessage(fauxToolCall("pending", {}, { id: "pending-call" }), { stopReason: "toolUse" })
				: fauxAssistantMessage("Final answer");
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: response.stopReason as "stop" | "toolUse", message: response });
				stream.end(response);
			});
			return stream;
		},
		getModels: () => [model], getModel: () => model, getProviders: () => [], getAvailableSnapshot: () => [model],
		hasConfiguredAuth: () => true, isUsingOAuth: () => false,
	} as any;
	const { session } = await createAgentSession({
		cwd, agentDir: cwd, resourceLoader: loader, settingsManager, sessionManager, model, modelRuntime, thinkingLevel: "off",
	});
	try {
		await session.bindExtensions({});
		const prompt = session.prompt("Start work");
		await started;
		updateRecord(runDir, "child", { status: "done", exitCode: 0, finishedAt: new Date().toISOString() });
		await session.abort();
		await prompt;
		expect(requests).toBe(1);
		expect(session.isIdle).toBe(true);
		const completions = () => session.messages.filter((message) => message.role === "custom" && message.customType === "async-subagents-agent-completion");
		expect(completions()).toHaveLength(0);
		await session.prompt("Replacement message");
		expect(requests).toBe(3);
		expect(completions()).toHaveLength(1);
	} finally {
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
		session.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
		resetSubagentStoreForTest();
	}
});
