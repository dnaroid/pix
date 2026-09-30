import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import quotaWait from "../src/bundled-extensions/quota-wait/index.js";
import { AgentPauseController } from "../src/app/session/agent-pause-controller.js";

async function sdkFixture() {
	let requestPause: (() => Promise<void>) | undefined;
	let toolCalls = 0;
	const dir = await mkdtemp(join(tmpdir(), "pix-quota-sdk-"));
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } });
	const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, modelsStorePath: join(dir, "models"), refreshOnCreate: false });
	await modelRuntime.setRuntimeApiKey("openai", "test-no-network");
	const model = modelRuntime.getModels("openai")[0]!;
	assert.ok(model);
	const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [(pi) => quotaWait(pi, async () => ({ kind: "available" }))] });
	await resourceLoader.reload();
	const { session } = await createAgentSession({ cwd: dir, agentDir: dir, settingsManager, modelRuntime, model,
		resourceLoader, sessionManager: SessionManager.inMemory(dir), tools: ["step"], customTools: [{
			name: "step", label: "Step", description: "Deterministic test step", parameters: { type: "object", properties: {} } as any,
			execute: async () => { toolCalls++; await requestPause?.(); return { content: [{ type: "text", text: "Step complete" }], details: {} }; },
		}] });
	const errors: unknown[] = [];
	const pause = new AgentPauseController({ render() {}, showToast() {}, isCurrentSession: (candidate) => candidate === session });
	pause.bind(session);
	await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
	const state = () => {
		const entry = session.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === "pix-quota-wait").at(-1);
		return entry?.type === "custom" ? (entry.data as any).state : undefined;
	};
	const message = (stopReason: "stop" | "error", errorMessage?: string): any => ({ role: "assistant", provider: model.provider,
		model: model.id, api: model.api, timestamp: Date.now(), content: [{ type: "text", text: stopReason === "stop" ? "Done" : "" }],
		stopReason, ...(errorMessage ? { errorMessage } : {}), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
	let calls = 0;
	const stream = (stopReason: "stop" | "error" | "toolUse", errorMessage?: string) => {
		session.agent.streamFunction = () => {
			calls++;
			const events = new AssistantMessageEventStream();
			const result = message(stopReason === "toolUse" ? "stop" : stopReason, errorMessage);
			if (stopReason === "toolUse") { result.stopReason = "toolUse"; result.content = [{ type: "toolCall", id: "step-1", name: "step", arguments: {} }]; }
			queueMicrotask(() => events.push(stopReason === "error" ? { type: "error", reason: "error", error: result } : { type: "done", reason: stopReason, message: result }));
			return events;
		};
	};
	return { session, state, stream, errors, pause, pauseDuringTool: () => { requestPause = () => pause.toggle(session); }, get toolCalls() { return toolCalls; }, get calls() { return calls; }, async close() {
		await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); await rm(dir, { recursive: true, force: true });
	} };
}

async function until(check: () => boolean) {
	for (let i = 0; i < 400 && !check(); i++) await delay(5);
	assert.ok(check(), "SDK lifecycle did not settle");
}

it("real SDK exhaustion aborts retry, persists wait and resumes the same task", async () => {
	const f = await sdkFixture();
	try {
		f.stream("error", "usage_limit_reached");
		await f.session.prompt("Finish this task");
		assert.equal(f.calls, 1); assert.equal(f.state().phase, "waiting");
		f.stream("stop");
		await f.session.prompt("/wait retry");
		await until(() => f.calls === 2 && f.session.isIdle && f.state() === null);
		assert.deepEqual(f.errors, []);
		assert.equal(f.session.messages.filter((m) => m.role === "user").length, 1);
		assert.equal(f.session.messages.some((m) => m.role === "custom" && m.customType === "pix-quota-control"), false);
	} finally { await f.close(); }
});

it("real SDK timer uses Continue after manual turn-boundary pause without repeating tools or adding a prompt", async () => {
	const f = await sdkFixture();
	try {
		f.stream("toolUse"); f.pauseDuringTool();
		await f.session.prompt("Continue my unfinished task");
		assert.equal(f.pause.state(f.session), "paused"); assert.equal(f.toolCalls, 1);
		f.stream("stop");
		await f.session.prompt("/wait 1h20m");
		assert.equal(f.state().mode, "timer"); assert.equal(f.calls, 1);
		await f.session.prompt("/wait retry");
		await until(() => f.calls === 2 && f.session.isIdle && f.state() === null);
		assert.equal(f.toolCalls, 1);
		assert.deepEqual(f.errors, []);
		assert.equal(f.session.messages.filter((m) => m.role === "user").length, 1);
		assert.equal(f.session.messages.some((m) => m.role === "custom"), false);
	} finally { await f.close(); }
});
