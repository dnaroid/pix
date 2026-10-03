import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import questionExtension, { createDesktopQuestionResponse } from "../src/bundled-extensions/question/index.js";
import { cancelQuestionRecovery, pendingQuestions, recoverQuestions, scheduleQuestionRecovery } from "../src/bundled-extensions/question/recovery.js";

const args = { questions: [{ id: "scope", label: "Scope", prompt: "Which scope?", choices: [
	{ value: "small", label: "Small" }, { value: "large", label: "Large" },
] }] };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "openai", model: "test", usage,
	timestamp: 1, stopReason: "toolUse", content: [{ type: "toolCall", id: "original-question", name: "question", arguments: args }] };

async function fixture(editor: (title: string, prefill?: string) => Promise<string | undefined>) {
	const dir = await mkdtemp(join(tmpdir(), "pix-question-recovery-"));
	const previous = process.env.PIX_QUESTION_RPC_BRIDGE;
	process.env.PIX_QUESTION_RPC_BRIDGE = "1";
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models"), refreshOnCreate: false });
	await modelRuntime.setRuntimeApiKey("openai", "test-no-network");
	const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [questionExtension] });
	await resourceLoader.reload();
	const original = SessionManager.create(dir, join(dir, "sessions"));
	original.appendMessage({ role: "user", content: "Ask before continuing", timestamp: 0 });
	original.appendMessage(assistant);
	const manager = SessionManager.open(original.getSessionFile()!);
	const { session } = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager, modelRuntime,
		model: modelRuntime.getModels("openai")[0]!, resourceLoader, sessionManager: manager, tools: ["question"] });
	await session.bindExtensions({ mode: "rpc", uiContext: { editor, notify() {} } as unknown as ExtensionUIContext });
	let continuations = 0;
	session.agent.streamFunction = () => {
		continuations++;
		const events = new AssistantMessageEventStream();
		queueMicrotask(() => events.push({ type: "done", reason: "stop", message: { ...assistant,
			content: [{ type: "text", text: "Continued" }], stopReason: "stop", timestamp: Date.now() } }));
		return events;
	};
	return { session, manager, continuations: () => continuations, cleanup: async () => {
		cancelQuestionRecovery(session); session.dispose();
		if (previous === undefined) delete process.env.PIX_QUESTION_RPC_BRIDGE;
		else process.env.PIX_QUESTION_RPC_BRIDGE = previous;
		await rm(dir, { recursive: true, force: true });
	} };
}

it("finds only unresolved question calls in the current tool turn", () => {
	assert.equal(pendingQuestions([assistant])?.calls[0]?.id, "original-question");
	const result = { role: "toolResult", toolCallId: "original-question", toolName: "question", content: [], isError: false, timestamp: 2 } as const;
	assert.equal(pendingQuestions([assistant, { ...result, content: [] }]), undefined);
	assert.equal(pendingQuestions([assistant, { role: "user", content: "New task", timestamp: 3 }]), undefined);
	assert.equal(pendingQuestions([{ ...assistant, content: [...assistant.content, { type: "toolCall", id: "side-effect", name: "bash", arguments: {} }] }]), undefined);
	assert.equal(pendingQuestions([{ ...assistant, content: [{ type: "toolCall", id: "bad", name: "question", arguments: {} }] }]), undefined);
});

it("reopens persisted arguments from scratch, persists the same ID once, and continues", async () => {
	let shown = 0;
	const f = await fixture(async (_title, prefill) => {
		shown++;
		assert.deepEqual(JSON.parse(prefill!), { version: 1, ...args });
		return createDesktopQuestionResponse([{ id: "scope", choiceValue: "large" }]);
	});
	try {
		const hookIds: string[] = [];
		f.session.agent.beforeToolCall = async (context) => { hookIds.push(context.toolCall.id); };
		assert.equal(await recoverQuestions(f.session), true);
		assert.equal(shown, 1);
		assert.deepEqual(hookIds, ["original-question"]);
		assert.equal(f.continuations(), 1);
		assert.equal(f.session.isStreaming, false);
		assert.equal(f.session.isIdle, true);
		const restored = SessionManager.open(f.manager.getSessionFile()!).buildSessionContext().messages;
		const results = restored.filter((m) => m.role === "toolResult");
		assert.equal(results.length, 1);
		assert.equal(results[0]?.toolCallId, "original-question");
		assert.equal((results[0]?.details as { canceled: boolean }).canceled, false);
		assert.equal(restored[restored.length - 1]?.role, "assistant");
		assert.equal(await recoverQuestions(f.session), false);
		assert.equal(shown, 1);
	} finally { await f.cleanup(); }
});

it("persists explicit Cancel and does not restore it again", async () => {
	const f = await fixture(async () => undefined);
	try {
		await recoverQuestions(f.session);
		const result = f.session.messages.find((m) => m.role === "toolResult");
		assert.equal((result?.details as { canceled: boolean }).canceled, true);
		assert.equal(await recoverQuestions(f.session), false);
		assert.equal(f.continuations(), 1);
	} finally { await f.cleanup(); }
});

it("claims recovery synchronously after loading the adapter under concurrent starts", async () => {
	let shown = 0;
	const f = await fixture(async () => {
		shown++;
		return createDesktopQuestionResponse([{ id: "scope", choiceValue: "small" }]);
	});
	try {
		const attempts = await Promise.all(Array.from({ length: 8 }, () => recoverQuestions(f.session)));
		assert.equal(attempts.filter(Boolean).length, 1);
		assert.equal(shown, 1);
		assert.equal(f.continuations(), 1);
		assert.equal(f.session.messages.filter((message) => message.role === "toolResult").length, 1);
	} finally { await f.cleanup(); }
});

it("drops a stale answer after ownership changes without persisting cancellation", async () => {
	let resolveAnswer!: (answer: string) => void;
	const f = await fixture(() => new Promise((resolve) => { resolveAnswer = resolve; }));
	let current = true;
	try {
		const recovery = recoverQuestions(f.session, () => current);
		while (!resolveAnswer) await delay(1);
		assert.equal(await recoverQuestions(f.session), false, "no duplicate while waiting");
		current = false;
		resolveAnswer(createDesktopQuestionResponse([{ id: "scope", choiceValue: "small" }]));
		await recovery;
		assert.ok(pendingQuestions(f.session.messages));
		assert.equal(f.continuations(), 0);
		assert.equal(f.session.messages.some((m) => m.role === "toolResult"), false);
	} finally { await f.cleanup(); }
});

it("cancels stale scheduled starts and ignores non-message extension records", async () => {
	let shown = 0;
	const f = await fixture(async () => { shown++; return undefined; });
	try {
		scheduleQuestionRecovery(f.session);
		cancelQuestionRecovery(f.session);
		await delay(10);
		assert.equal(shown, 0);
		scheduleQuestionRecovery(f.session);
		f.manager.appendCustomEntry("unrelated-extension-state", {});
		for (let i = 0; i < 100 && (shown === 0 || !f.session.isIdle); i++) await delay(5);
		assert.equal(shown, 1);
		assert.equal(f.continuations(), 1);
	} finally { await f.cleanup(); }
});
