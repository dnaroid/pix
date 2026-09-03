import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	client,
	PROTOCOL_VERSION,
	type ActiveSessionMessage,
	type CreateElicitationRequest,
	type CreateElicitationResponse,
	type SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
	JsonAgentSessionEvent,
	RpcExtensionUIResponse,
	SessionInfo as PiSessionInfo,
} from "@earendil-works/pi-coding-agent";
import { PixAcpAgent } from "../src/acp/pix-acp-agent.js";
import { SessionMapStore } from "../src/acp/session-map.js";
import type { Logger } from "../src/logging.js";
import type {
	PiAgentMessage,
	PiClient,
	PiCompactionResult,
	PiEvent,
	PiEventListener,
	PiImageContent,
	PiModel,
	PiRpcClientOptions,
	PiSessionState,
} from "../src/pi/pi-rpc-client.js";

const TEST_LOGGER: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

let fakeSessionCounter = 0;

class FakePiClient implements PiClient {
	/**
	 * Messages per session file, modeling "switchSession loads that file's
	 * history": tests populate this before triggering a load/fork.
	 */
	static readonly sessionFiles = new Map<string, PiAgentMessage[]>();

	readonly promptCalls: { message: string; images?: PiImageContent[] }[] = [];
	readonly steerCalls: string[] = [];
	readonly followUpCalls: string[] = [];
	readonly uiResponses: RpcExtensionUIResponse[] = [];
	readonly switchSessions: string[] = [];
	readonly nameCalls: string[] = [];
	readonly compactCalls: (string | undefined)[] = [];
	readonly autoCompactionCalls: boolean[] = [];
	readonly steeringModes: ("all" | "one-at-a-time")[] = [];
	readonly followUpModes: ("all" | "one-at-a-time")[] = [];
	readonly thinkingLevels: string[] = [];
	readonly modelSets: { provider: string; modelId: string }[] = [];
	readonly exportCalls: (string | undefined)[] = [];
	clones = 0;
	modelCycles = 0;
	cloneCancelled = false;
	switchCancelled = false;
	aborts = 0;
	started = false;
	startError: Error | undefined;
	startGate: Promise<void> | undefined;
	state: PiSessionState;
	private listeners: PiEventListener[] = [];
	private exitListeners: ((error: Error) => void)[] = [];

	constructor(state: Partial<PiSessionState> = {}) {
		const n = ++fakeSessionCounter;
		this.state = {
			model: { provider: "anthropic", id: "claude-4", name: "Claude 4" },
			thinkingLevel: "medium",
			sessionFile: `/tmp/pi-sessions/fake-${n}.jsonl`,
			sessionId: `pi-fake-${n}`,
			isStreaming: false,
			...state,
		};
	}

	async start(): Promise<void> {
		await this.startGate;
		if (this.startError) throw this.startError;
		this.started = true;
	}

	async stop(): Promise<void> {
		this.started = false;
	}

	onEvent(listener: PiEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((l) => l !== listener);
		};
	}

	onExit(listener: (error: Error) => void): () => void {
		this.exitListeners.push(listener);
		return () => {
			this.exitListeners = this.exitListeners.filter((l) => l !== listener);
		};
	}

	async prompt(message: string, images?: PiImageContent[]): Promise<void> {
		this.promptCalls.push({ message, images });
	}

	async steer(message: string): Promise<void> {
		this.steerCalls.push(message);
	}

	async followUp(message: string): Promise<void> {
		this.followUpCalls.push(message);
	}

	async abort(): Promise<void> {
		this.aborts++;
	}

	respondToExtensionUi(response: RpcExtensionUIResponse): void {
		this.uiResponses.push(response);
	}

	async getState(): Promise<PiSessionState> {
		return this.state;
	}

	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		this.switchSessions.push(sessionPath);
		this.state = { ...this.state, sessionFile: sessionPath };
		return { cancelled: this.switchCancelled };
	}

	async clone(): Promise<{ cancelled: boolean }> {
		this.clones++;
		if (!this.cloneCancelled) {
			const n = ++fakeSessionCounter;
			this.state = {
				...this.state,
				sessionFile: `/tmp/pi-sessions/fake-${n}.jsonl`,
				sessionId: `pi-fake-${n}`,
			};
		}
		return { cancelled: this.cloneCancelled };
	}

	async getMessages(): Promise<PiAgentMessage[]> {
		return FakePiClient.sessionFiles.get(this.state.sessionFile ?? "") ?? [];
	}

	async setSessionName(name: string): Promise<void> {
		this.nameCalls.push(name);
		this.state = { ...this.state, sessionName: name };
	}

	async getAvailableModels(): Promise<PiModel[]> {
		return [
			{ provider: "anthropic", id: "claude-4", name: "Claude 4" },
			{ provider: "anthropic", id: "claude-3", name: "Claude 3" },
			{ provider: "openai", id: "gpt-5", name: "GPT-5" },
		];
	}

	async getAvailableThinkingLevels(): Promise<string[]> {
		return ["off", "medium", "high"];
	}

	async setModel(provider: string, modelId: string): Promise<PiModel> {
		this.modelSets.push({ provider, modelId });
		const model: PiModel = { provider, id: modelId };
		this.state = { ...this.state, model };
		return model;
	}

	async cycleModel(): Promise<{ model: PiModel; thinkingLevel: string } | null> {
		this.modelCycles++;
		const model: PiModel = { provider: "openai", id: "gpt-5" };
		this.state = { ...this.state, model };
		return { model, thinkingLevel: this.state.thinkingLevel };
	}

	async setThinkingLevel(level: string): Promise<void> {
		this.thinkingLevels.push(level);
		this.state = { ...this.state, thinkingLevel: level };
	}

	async setAutoCompaction(enabled: boolean): Promise<void> {
		this.autoCompactionCalls.push(enabled);
	}

	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		this.steeringModes.push(mode);
	}

	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		this.followUpModes.push(mode);
	}

	async compact(customInstructions?: string): Promise<PiCompactionResult> {
		this.compactCalls.push(customInstructions);
		return { summary: "compacted", tokensBefore: 1000, estimatedTokensAfter: 100 };
	}

	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		this.exportCalls.push(outputPath);
		return { path: outputPath ?? "/tmp/export.html" };
	}

	/** Simulate pi emitting an RPC event or extension UI request. */
	emit(event: PiEvent): void {
		for (const listener of [...this.listeners]) listener(event);
	}

	/** Simulate the pi process dying; fires onExit listeners once. */
	emitExit(error: Error): void {
		const listeners = this.exitListeners;
		this.exitListeners = [];
		for (const listener of listeners) listener(error);
	}
}

interface TestHarness {
	adapter: PixAcpAgent;
	clients: FakePiClient[];
	options: PiRpcClientOptions[];
	/** Temp session map file shared by all sessions of this adapter. */
	sessionMapPath: string;
}

function createTestAdapter(overrides: Partial<ConstructorParameters<typeof PixAcpAgent>[0]> = {}): TestHarness {
	const clients: FakePiClient[] = [];
	const options: PiRpcClientOptions[] = [];
	const sessionMapPath = join(mkdtempSync(join(tmpdir(), "pix-acp-test-")), "sessions.json");
	const adapter = new PixAcpAgent({
		createPiClient: (opts): PiClient => {
			options.push(opts);
			const fake = new FakePiClient();
			clients.push(fake);
			return fake;
		},
		piEntry: "/test/pi-rpc-entry.js",
		logger: TEST_LOGGER,
		sessionMapPath,
		listPiSessions: async () => [],
		loadTuiTabs: async () => ({ sessionPaths: [] }),
		...overrides,
	});
	return { adapter, clients, options, sessionMapPath };
}

function nativeSession(id: string, overrides: Partial<PiSessionInfo> = {}): PiSessionInfo {
	return {
		path: `/tmp/pi-sessions/${id}.jsonl`,
		id,
		cwd: "/tmp/proj",
		created: new Date("2025-01-01T00:00:00.000Z"),
		modified: new Date("2025-01-02T00:00:00.000Z"),
		messageCount: 2,
		firstMessage: `First message for ${id}`,
		allMessagesText: `First message for ${id}`,
		...overrides,
	};
}

type TestClientContext = Parameters<Parameters<ReturnType<typeof client>["connectWith"]>[1]>[0];

async function connect<T>(
	adapter: PixAcpAgent,
	op: (cx: TestClientContext) => Promise<T>,
	setup?: (app: ReturnType<typeof client>) => void,
): Promise<T> {
	const app = client({ name: "pix-acp-test" });
	setup?.(app);
	return app.connectWith(adapter.acpApp, op);
}

/** Client capabilities advertising elicitation form support. */
const ELICITATION_CAPS = { clientCapabilities: { elicitation: { form: {} } } };

test("initialize handshake reports protocol version, capabilities, and image prompts", async () => {
	const { adapter } = createTestAdapter();
	const result = await connect(adapter, (cx) =>
		cx.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
		}),
	);
	assert.equal(result.protocolVersion, PROTOCOL_VERSION);
	assert.equal(result.agentCapabilities?.loadSession, true);
	assert.equal(result.agentCapabilities?.promptCapabilities?.image, true);
	assert.deepEqual(result.agentCapabilities?.sessionCapabilities, {
		list: {},
		delete: {},
		resume: {},
		fork: {},
		close: {},
	});
});

test("session/new spawns and starts one pi client per session with the cwd", async () => {
	const { adapter, clients, options } = createTestAdapter();
	const sessionIds = await connect(adapter, async (cx) => {
		const first = await cx.buildSession("/tmp/one").start();
		const second = await cx.buildSession("/tmp/two").start();
		return [first.sessionId, second.sessionId];
	});
	assert.equal(sessionIds.length, 2);
	assert.notEqual(sessionIds[0], sessionIds[1]);
	assert.deepEqual(options.map((o) => o.cwd), ["/tmp/one", "/tmp/two"]);
	assert.ok(options.every((o) => o.piEntry === "/test/pi-rpc-entry.js"));
	assert.equal(clients.length, 2);
	assert.ok(clients[0].started, "first pi client started");
	assert.ok(clients[1].started, "second pi client started");
	assert.ok(adapter.getSession(sessionIds[0]!), "first session registered");
	assert.ok(adapter.getSession(sessionIds[1]!), "second session registered");
});

test("session/new returns config options and persists the session map entry", async () => {
	const harness = createTestAdapter();
	const created = await connect(harness.adapter, async (cx) => {
		const result = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] });
		return result as { sessionId: string; configOptions?: { id: string; currentValue: string }[] };
	});
	assert.equal(created.configOptions?.length, 2);
	assert.equal(created.configOptions?.[0]?.id, "model");
	assert.equal(created.configOptions?.[0]?.currentValue, "anthropic/claude-4");
	assert.equal(created.configOptions?.[1]?.id, "thought_level");

	// A fresh adapter over the same map file must list the session (disk round-trip).
	const reused = new PixAcpAgent({
		createPiClient: (): PiClient => new FakePiClient(),
		piEntry: "/test/pi-rpc-entry.js",
		logger: TEST_LOGGER,
		sessionMapPath: harness.sessionMapPath,
		listPiSessions: async () => [],
		loadTuiTabs: async () => ({ sessionPaths: [] }),
	});
	const listed = await connect(reused, (cx) => cx.request("session/list", {}));
	assert.ok(
		listed.sessions.some((s) => s.sessionId === created.sessionId && s.cwd === "/tmp/proj"),
		"session map persisted the new session",
	);
	const filtered = await connect(reused, (cx) => cx.request("session/list", { cwd: "/tmp/other" }));
	assert.equal(filtered.sessions.length, 0, "cwd filter excludes other projects");
});

test("session/list reconciles native Pi sessions and reports ordered TUI tabs", async () => {
	const firstPath = "/tmp/pi-sessions/native-a.jsonl";
	const secondPath = "/tmp/pi-sessions/native-b.jsonl";
	const requestedCwds: (string | undefined)[] = [];
	const harness = createTestAdapter({
		listPiSessions: async (cwd) => {
			requestedCwds.push(cwd);
			return [
				nativeSession("native-a", { path: firstPath, name: "Native title" }),
				nativeSession("native-b", {
					path: secondPath,
					modified: new Date("2025-02-01T00:00:00.000Z"),
				}),
			];
		},
		loadTuiTabs: async () => ({ sessionPaths: [secondPath, firstPath], activeSessionPath: firstPath }),
	});
	const map = new SessionMapStore(harness.sessionMapPath, TEST_LOGGER);
	await map.put({
		sessionId: "existing-acp-id",
		piSessionPath: firstPath,
		piSessionId: "old-pi-id",
		cwd: "/tmp/proj",
		title: "Old title",
		updatedAt: "2024-01-01T00:00:00.000Z",
	});

	const listed = await connect(harness.adapter, (cx) => cx.request("session/list", { cwd: "/tmp/proj" }));
	assert.deepEqual(requestedCwds, ["/tmp/proj"]);
	assert.deepEqual(listed.sessions.map((session) => session.sessionId), ["native-b", "existing-acp-id"]);
	assert.equal(listed.sessions[1]?.title, "Native title");
	assert.deepEqual(listed._meta?.["pix.tabs"], {
		sessionIds: ["native-b", "existing-acp-id"],
		activeSessionId: "existing-acp-id",
	});

	assert.equal((await map.get("existing-acp-id"))?.piSessionId, "native-a");
	assert.equal((await map.get("native-b"))?.piSessionPath, secondPath);
	await connect(harness.adapter, (cx) => cx.request("session/load", {
		sessionId: "native-b",
		cwd: "/tmp/proj",
		mcpServers: [],
	}));
	assert.deepEqual(harness.clients[harness.clients.length - 1]?.switchSessions, [secondPath]);
});

test("session/list falls back to mapped sessions when native discovery fails", async () => {
	const harness = createTestAdapter({
		listPiSessions: async () => {
			throw new Error("native store unavailable");
		},
	});
	const map = new SessionMapStore(harness.sessionMapPath, TEST_LOGGER);
	await map.put({
		sessionId: "mapped",
		piSessionPath: "/tmp/pi-sessions/mapped.jsonl",
		piSessionId: "pi-mapped",
		cwd: "/tmp/proj",
		updatedAt: "2025-01-01T00:00:00.000Z",
	});

	const listed = await connect(harness.adapter, (cx) => cx.request("session/list", { cwd: "/tmp/proj" }));
	assert.deepEqual(listed.sessions.map((session) => session.sessionId), ["mapped"]);
	assert.deepEqual(listed._meta?.["pix.tabs"], { sessionIds: [] });
});

test("session/new failure to start pi returns a protocol error and registers nothing", async () => {
	const { adapter } = createTestAdapter({
		createPiClient: () => {
			const fake = new FakePiClient();
			fake.startError = new Error("spawn failed");
			return fake;
		},
	});
	await connect(adapter, async (cx) => {
		await assert.rejects(cx.buildSession("/tmp").start(), /failed to start pi[\s\S]*spawn failed/);
	});
	assert.equal(adapter.sessionCount, 0);
});

test("dispose waits for an in-flight session start and stops it before registration", async () => {
	let releaseStart!: () => void;
	const startGate = new Promise<void>((resolve) => {
		releaseStart = resolve;
	});
	const fake = new FakePiClient();
	fake.startGate = startGate;
	const { adapter } = createTestAdapter({ createPiClient: () => fake });

	await connect(adapter, async (cx) => {
		const creating = cx.request("session/new", { cwd: "/tmp/project", mcpServers: [] });
		await new Promise<void>((resolve) => setImmediate(resolve));
		const disposing = adapter.dispose();
		releaseStart();
		await assert.rejects(creating, /adapter is shutting down/);
		await disposing;
		assert.equal(fake.started, false);
		assert.equal(adapter.sessionCount, 0);
	});
});

test("session/prompt streams chunks and resolves end_turn when pi settles", async () => {
	const { adapter, clients } = createTestAdapter();
	const messages = await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp").start();
		const pending = session.prompt("hello");
		const pi = clients[0]!;

		await waitFor(() => pi.promptCalls.length === 1);
		assert.deepEqual(pi.promptCalls, [{ message: "hello", images: undefined }]);

		pi.emit({ type: "agent_start" });
		pi.emit({
			type: "message_update",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, total: 0 } },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi " },
		} as unknown as JsonAgentSessionEvent);
		pi.emit({
			type: "message_update",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, total: 0 } },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "there" },
		} as unknown as JsonAgentSessionEvent);
		pi.emit({
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "stop" }],
			willRetry: false,
		} as unknown as JsonAgentSessionEvent);
		pi.emit({ type: "agent_settled" });

		const response = await pending;
		const collected: ActiveSessionMessage[] = [];
		for (;;) {
			const message = await session.nextUpdate();
			collected.push(message);
			if (message.kind === "stop") break;
		}
		return { stopReason: response.stopReason, collected };
	});

	assert.equal(messages.stopReason, "end_turn");
	const chunks = messages.collected
		.filter((m) => m.kind === "session_update")
		.map((m) => (m as { update: { sessionUpdate: string; content?: unknown } }).update);
	assert.equal(chunks[0].sessionUpdate, "agent_message_chunk");
	assert.deepEqual(chunks[0].content, { type: "text", text: "Hi " });
	assert.equal(chunks[1].sessionUpdate, "agent_message_chunk");
	assert.deepEqual(chunks[1].content, { type: "text", text: "there" });
});

test("session/prompt fails fast when the pi process dies mid-run", async () => {
	const { adapter, clients } = createTestAdapter();
	const failure = await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp").start();
		const pending = session.prompt("hello");
		const pi = clients[0]!;
		await waitFor(() => pi.promptCalls.length === 1);
		pi.emit({ type: "agent_start" });
		// No agent_settled will ever arrive; only the exit watch can finish it.
		pi.emitExit(new Error("pi process exited unexpectedly (signal SIGKILL)"));
		return pending.then(
			() => "resolved",
			(error: unknown) => (error as Error).message,
		);
	});
	assert.match(failure, /pi process died.*SIGKILL/);
});

test("session/prompt forwards images and maps aborted runs to cancelled", async () => {
	const { adapter, clients } = createTestAdapter();
	const result = await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp").start();
		const pending = session.prompt([
			{ type: "text", text: "look" },
			{ type: "image", data: "aGk=", mimeType: "image/png" },
		]);
		const pi = clients[0]!;
		await waitFor(() => pi.promptCalls.length === 1);
		assert.deepEqual(pi.promptCalls[0].images, [{ type: "image", data: "aGk=", mimeType: "image/png" }]);

		pi.emit({ type: "agent_start" });
		pi.emit({
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
			willRetry: false,
		} as unknown as JsonAgentSessionEvent);
		pi.emit({ type: "agent_settled" });
		return pending;
	});
	assert.equal(result.stopReason, "cancelled");
});

test("session/cancel aborts pi and the pending prompt resolves cancelled", async () => {
	const { adapter, clients } = createTestAdapter();
	const result = await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp").start();
		const pending = session.prompt("long running");
		const pi = clients[0]!;
		await waitFor(() => pi.promptCalls.length === 1);
		pi.emit({ type: "agent_start" });
		await cx.notify("session/cancel", { sessionId: session.sessionId });
		await waitFor(() => pi.aborts === 1);
		pi.emit({
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
			willRetry: false,
		} as unknown as JsonAgentSessionEvent);
		pi.emit({ type: "agent_settled" });
		return pending;
	});
	assert.equal(result.stopReason, "cancelled");
});

test("session/cancel can settle before agent_start", async () => {
	const { adapter, clients } = createTestAdapter();
	const result = await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp").start();
		const pending = session.prompt("cancel immediately");
		const pi = clients[0]!;
		await waitFor(() => pi.promptCalls.length === 1);
		await cx.notify("session/cancel", { sessionId: session.sessionId });
		await waitFor(() => pi.aborts === 1);
		pi.emit({ type: "agent_settled" });
		return pending;
	});
	assert.equal(result.stopReason, "cancelled");
});

test("session/prompt ignores a duplicate settlement before its agent_start", async () => {
	const { adapter, clients } = createTestAdapter();
	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp").start();
		const pi = clients[0]!;
		const first = session.prompt("first");
		await waitFor(() => pi.promptCalls.length === 1);
		pi.emit({ type: "agent_start" });
		pi.emit({ type: "agent_settled" });
		await first;

		let secondSettled = false;
		const second = session.prompt("second").finally(() => {
			secondSettled = true;
		});
		await waitFor(() => pi.promptCalls.length === 2);
		pi.emit({ type: "agent_settled" });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(secondSettled, false, "stale settlement must not finish the next prompt");
		pi.emit({ type: "agent_start" });
		pi.emit({ type: "agent_settled" });
		assert.equal((await second).stopReason, "end_turn");
	});
});

test("session/prompt rejects for unknown sessions and refuses concurrent prompts", async () => {
	const { adapter, clients } = createTestAdapter();
	await connect(adapter, async (cx) => {
		await assert.rejects(
			cx.request("session/prompt", { sessionId: "does-not-exist", prompt: [{ type: "text", text: "hi" }] }),
			/not found/,
		);

		const session = await cx.buildSession("/tmp").start();
		const first = session.prompt("one");
		const pi = clients[0]!;
		await waitFor(() => pi.promptCalls.length === 1);
		await assert.rejects(session.prompt("two"), /already in progress/);

		pi.emit({ type: "agent_start" });
		pi.emit({ type: "agent_settled" });
		assert.equal((await first).stopReason, "end_turn");
	});
});

test("session/prompt rejects unsupported content", async () => {
	const { adapter } = createTestAdapter();
	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp").start();
		await assert.rejects(
			session.prompt([{ type: "audio", data: "aGk=", mimeType: "audio/wav" }]),
			/audio content is not supported/,
		);
		await assert.rejects(session.prompt([]), /no supported content/);
	});
});

test("session/close stops the pi client and unregisters the session", async () => {
	const { adapter, clients } = createTestAdapter();
	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp").start();
		assert.equal(adapter.sessionCount, 1);
		await cx.request("session/close", { sessionId: session.sessionId });
		assert.equal(adapter.sessionCount, 0);
		assert.equal(clients[0].started, false);
	});
});

test("session/close resolves an active prompt as cancelled", async () => {
	const { adapter, clients } = createTestAdapter();
	const result = await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp").start();
		const pending = session.prompt("still running");
		const pi = clients[0]!;
		await waitFor(() => pi.promptCalls.length === 1);
		await cx.request("session/close", { sessionId: session.sessionId });
		return { response: await pending, aborts: pi.aborts, started: pi.started };
	});
	assert.equal(result.response.stopReason, "cancelled");
	assert.equal(result.aborts, 1);
	assert.equal(result.started, false);
});

test("extension select dialog is bridged to an elicitation and answered", async () => {
	const { adapter, clients } = createTestAdapter();
	const elicitationParams: CreateElicitationRequest[] = [];
	await connect(
		adapter,
		async (cx) => {
			await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, ...ELICITATION_CAPS });
			await cx.buildSession("/tmp").start();
			clients[0]!.emit({
				type: "extension_ui_request",
				id: "ui-1",
				method: "select",
				title: "Allow dangerous command?",
				options: ["Allow", "Block"],
			});
			await waitFor(() => clients[0]!.uiResponses.length === 1);
		},
		(app) => {
			app.onRequest("elicitation/create", (ctx) => {
				elicitationParams.push(ctx.params);
				const response: CreateElicitationResponse = { action: "accept", content: { value: "Allow" } };
				return response;
			});
		},
	);
	assert.deepEqual(elicitationParams.length, 1);
	assert.equal(elicitationParams[0]?.mode, "form");
	assert.equal((elicitationParams[0] as { sessionId?: string } | undefined)?.sessionId !== undefined, true);
	assert.equal(elicitationParams[0]?.message, "Allow dangerous command?");
	assert.deepEqual(clients[0]!.uiResponses, [{ type: "extension_ui_response", id: "ui-1", value: "Allow" }]);
});

test("extension confirm dialog maps the boolean answer", async () => {
	const { adapter, clients } = createTestAdapter();
	await connect(
		adapter,
		async (cx) => {
			await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, ...ELICITATION_CAPS });
			await cx.buildSession("/tmp").start();
			clients[0]!.emit({
				type: "extension_ui_request",
				id: "ui-2",
				method: "confirm",
				title: "Clear session?",
				message: "All messages will be lost.",
			});
			await waitFor(() => clients[0]!.uiResponses.length === 1);
		},
		(app) => {
			app.onRequest("elicitation/create", () => ({ action: "decline" }) as CreateElicitationResponse);
		},
	);
	assert.deepEqual(clients[0]!.uiResponses, [{ type: "extension_ui_response", id: "ui-2", cancelled: true }]);
});

test("extension dialogs are cancelled immediately when the client lacks elicitation support", async () => {
	const { adapter, clients } = createTestAdapter();
	let elicitationCalls = 0;
	await connect(
		adapter,
		async (cx) => {
			await cx.request("initialize", {
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
			});
			await cx.buildSession("/tmp").start();
			clients[0]!.emit({
				type: "extension_ui_request",
				id: "ui-3",
				method: "input",
				title: "Enter a value",
			});
			await waitFor(() => clients[0]!.uiResponses.length === 1);
		},
		(app) => {
			app.onRequest("elicitation/create", () => {
				elicitationCalls++;
				return { action: "cancel" } satisfies CreateElicitationResponse;
			});
		},
	);
	assert.equal(elicitationCalls, 0);
	assert.deepEqual(clients[0]!.uiResponses, [{ type: "extension_ui_response", id: "ui-3", cancelled: true }]);
});

test("extension dialogs are cancelled when elicitation/create fails", async () => {
	const { adapter, clients } = createTestAdapter();
	await connect(
		adapter,
		async (cx) => {
			await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, ...ELICITATION_CAPS });
			await cx.buildSession("/tmp").start();
			clients[0]!.emit({
				type: "extension_ui_request",
				id: "ui-4",
				method: "select",
				title: "Pick",
				options: ["a", "b"],
			});
			await waitFor(() => clients[0]!.uiResponses.length === 1);
		},
		(app) => {
			app.onRequest("elicitation/create", () => {
				throw new Error("client cannot show forms");
			});
		},
	);
	assert.deepEqual(clients[0]!.uiResponses, [{ type: "extension_ui_response", id: "ui-4", cancelled: true }]);
});

test("session/close cancels dialogs still waiting for an elicitation answer", async () => {
	const { adapter, clients } = createTestAdapter();
	let releaseElicitation: (() => void) | undefined;
	await connect(
		adapter,
		async (cx) => {
			await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, ...ELICITATION_CAPS });
			const session = await cx.buildSession("/tmp").start();
			clients[0]!.emit({
				type: "extension_ui_request",
				id: "ui-5",
				method: "select",
				title: "Pick",
				options: ["a", "b"],
			});
			const state = adapter.getSession(session.sessionId);
			await waitFor(() => (state?.pendingDialogIds.size ?? 0) === 1);
			await cx.request("session/close", { sessionId: session.sessionId });
			await waitFor(() => clients[0]!.uiResponses.length === 1);
			releaseElicitation?.();
			await new Promise((resolve) => setTimeout(resolve, 20));
		},
		(app) => {
			app.onRequest("elicitation/create", () => {
				return new Promise<CreateElicitationResponse>((resolve) => {
					releaseElicitation = () => resolve({ action: "accept", content: { value: "a" } });
				});
			});
		},
	);
	assert.deepEqual(clients[0]!.uiResponses, [{ type: "extension_ui_response", id: "ui-5", cancelled: true }]);
});

test("fire-and-forget extension UI requests produce no response and no elicitation", async () => {
	const { adapter, clients } = createTestAdapter();
	let elicitationCalls = 0;
	await connect(
		adapter,
		async (cx) => {
			await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, ...ELICITATION_CAPS });
			await cx.buildSession("/tmp").start();
			clients[0]!.emit({
				type: "extension_ui_request",
				id: "ui-6",
				method: "notify",
				message: "Command blocked by user",
				notifyType: "warning",
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
		},
		(app) => {
			app.onRequest("elicitation/create", () => {
				elicitationCalls++;
				return { action: "cancel" } satisfies CreateElicitationResponse;
			});
		},
	);
	assert.equal(elicitationCalls, 0);
	assert.deepEqual(clients[0]!.uiResponses, []);
});

/** Text of a replayed update: plain text content or tool content blocks. */
function replayText(update: Record<string, unknown>): string | undefined {
	const content = update.content;
	if (Array.isArray(content)) {
		const texts = content
			.map((block) => (block as { content?: { text?: string } }).content?.text)
			.filter((t): t is string => t !== undefined);
		return texts.length > 0 ? texts.join("\n") : undefined;
	}
	return (content as { text?: string } | undefined)?.text;
}

test("session/load switches the pi session and replays history as chunk updates", async () => {
	const harness = createTestAdapter();
	const notifications: SessionNotification[] = [];
	const sessionId = await connect(
		harness.adapter,
		async (cx) => {
			const created = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] });
			const id = (created as { sessionId: string }).sessionId;
			// switchSession on the spawned pi returns this file's messages.
			FakePiClient.sessionFiles.set(harness.clients[0]!.state.sessionFile ?? "", [
				{ role: "user", content: "hello there" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "general kenobi" },
						{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "echo hi" } },
					],
				},
				{ role: "toolResult", content: [{ type: "text", text: "hi" }], toolCallId: "t1" } as unknown as PiAgentMessage,
				{ role: "user", content: [{ type: "text", text: "again" }, { type: "image", data: "aGk=" }] },
			]);
			await cx.request("session/load", { sessionId: id, cwd: "/tmp/proj", mcpServers: [] });
			return id;
		},
		(app) => {
			app.onNotification("session/update", (ctx) => {
				notifications.push(ctx.params);
			});
		},
	);

	assert.deepEqual(harness.clients[1]!.switchSessions, [harness.clients[0]!.state.sessionFile]);
	// Notifications are delivered asynchronously; poll for the replay to land.
	await waitFor(() => notifications.length >= 5);
	const replayed = notifications.map((n) => ({
		sessionUpdate: n.update.sessionUpdate,
		text: replayText(n.update as Record<string, unknown>),
		toolCallId: (n.update as { toolCallId?: string }).toolCallId,
	}));
	assert.deepEqual(replayed, [
		{ sessionUpdate: "user_message_chunk", text: "hello there", toolCallId: undefined },
		{ sessionUpdate: "agent_message_chunk", text: "general kenobi", toolCallId: undefined },
		{ sessionUpdate: "tool_call", text: undefined, toolCallId: "t1" },
		{ sessionUpdate: "tool_call_update", text: "hi", toolCallId: "t1" },
		{ sessionUpdate: "user_message_chunk", text: "again\n\n[image]", toolCallId: undefined },
	]);
	const toolCall = notifications.find((n) => n.update.sessionUpdate === "tool_call")!.update as Record<string, unknown>;
	assert.equal(toolCall.title, "Bash: echo hi");
	assert.equal(toolCall.kind, "execute");
	assert.equal(toolCall.status, "in_progress");
	assert.deepEqual(toolCall.rawInput, { command: "echo hi" });
	const toolUpdate = notifications.find((n) => n.update.sessionUpdate === "tool_call_update")!.update as Record<string, unknown>;
	assert.equal(toolUpdate.status, "completed");
	assert.equal(harness.adapter.getSession(sessionId) !== undefined, true, "loaded session is live");
});

test("concurrent loads for one session are serialized and stop the replaced process", async () => {
	const { adapter, clients } = createTestAdapter();
	await connect(adapter, async (cx) => {
		const created = await cx.request("session/new", { cwd: "/tmp/project", mcpServers: [] });
		await Promise.all([
			cx.request("session/load", { sessionId: created.sessionId, cwd: "/tmp/project", mcpServers: [] }),
			cx.request("session/load", { sessionId: created.sessionId, cwd: "/tmp/project", mcpServers: [] }),
		]);

		assert.equal(clients.length, 3);
		assert.equal(clients[0]!.started, false, "original process was stopped");
		assert.equal(clients[1]!.started, false, "first replacement was stopped");
		assert.equal(clients[2]!.started, true, "last replacement remains live");
		assert.equal(adapter.getSession(created.sessionId)?.pi, clients[2]);
	});
});

test("session map tracks pi-side session file moves after a run", async () => {
	const harness = createTestAdapter();
	const renamedPath = "/tmp/pi-sessions/moved-by-pi.jsonl";

	const sessionId = await connect(harness.adapter, async (cx) => {
		const session = await cx.buildSession("/tmp").start();
		const pi = harness.clients[0]!;
		const pending = session.prompt("hello");
		await waitFor(() => pi.promptCalls.length === 1);

		// pi moved the session file mid-run (e.g. branching).
		pi.state = { ...pi.state, sessionFile: renamedPath, sessionId: "pi-moved" };

		pi.emit({ type: "agent_start" });
		pi.emit({ type: "agent_settled" });
		assert.equal((await pending).stopReason, "end_turn");

		// The post-settle map sync is fire-and-forget; wait for the new path.
		const deadline = Date.now() + 1000;
		for (;;) {
			const map = JSON.parse(await readFile(harness.sessionMapPath, "utf8")) as {
				sessions?: Array<{ piSessionPath?: string }>;
			};
			if (map.sessions?.some((s) => s.piSessionPath === renamedPath)) break;
			if (Date.now() > deadline) throw new Error("session map was not updated with the moved path");
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		return session.sessionId;
	});

	// A later resume must switch to the moved file, not the stale one.
	await connect(harness.adapter, (cx) =>
		cx.request("session/resume", { sessionId, cwd: "/tmp", mcpServers: [] }),
	);
	assert.deepEqual(harness.clients[1]!.switchSessions, [renamedPath]);
});

test("session/resume switches without replaying history", async () => {
	const harness = createTestAdapter();
	const notifications: SessionNotification[] = [];
	await connect(
		harness.adapter,
		async (cx) => {
			const created = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] });
			const sessionId = (created as { sessionId: string }).sessionId;
			FakePiClient.sessionFiles.set(harness.clients[0]!.state.sessionFile ?? "", [
				{ role: "user", content: "old" },
			]);
			await cx.request("session/resume", { sessionId, cwd: "/tmp/proj", mcpServers: [] });
		},
		(app) => {
			app.onNotification("session/update", (ctx) => { notifications.push(ctx.params); });
		},
	);

	assert.deepEqual(harness.clients[1]!.switchSessions, [harness.clients[0]!.state.sessionFile]);
	assert.equal(notifications.length, 0, "resume replays nothing");
});

test("session/load rejects unknown sessions", async () => {
	const { adapter } = createTestAdapter();
	await connect(adapter, (cx) =>
		assert.rejects(
			cx.request("session/load", { sessionId: "nope", cwd: "/tmp", mcpServers: [] }),
			/unknown session nope/,
		),
	);
});

test("session/fork switches, clones, and registers a fresh mapped session", async () => {
	const harness = createTestAdapter();
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] }));
	const sourceId = (created as { sessionId: string }).sessionId;

	const forked = await connect(harness.adapter, (cx) =>
		cx.request("session/fork", { sessionId: sourceId, cwd: "/tmp/proj", mcpServers: [] }),
	) as { sessionId: string };
	assert.notEqual(forked.sessionId, sourceId);
	assert.equal(harness.clients[1]!.switchSessions.length, 1);
	assert.equal(harness.clients[1]!.clones, 1);
	assert.equal(harness.adapter.getSession(forked.sessionId) !== undefined, true);

	const listed = await connect(harness.adapter, (cx) => cx.request("session/list", {}));
	assert.equal(listed.sessions.length, 2);
});

test("session/fork clone cancelled tears down and reports an error", async () => {
	const harness = createTestAdapter({
		createPiClient: (): PiClient => {
			const fake = new FakePiClient();
			fake.cloneCancelled = true;
			return fake;
		},
	});
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] }));
	const sourceId = (created as { sessionId: string }).sessionId;

	await connect(harness.adapter, (cx) =>
		assert.rejects(
			cx.request("session/fork", { sessionId: sourceId, cwd: "/tmp/proj", mcpServers: [] }),
			/clone cancelled/,
		),
	);
	assert.equal(harness.adapter.sessionCount, 1, "only the source session stays live");
});

test("session/delete removes the mapping and closes a live session", async () => {
	const harness = createTestAdapter();
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] }));
	const sessionId = (created as { sessionId: string }).sessionId;
	assert.equal(harness.adapter.sessionCount, 1);

	await connect(harness.adapter, (cx) => cx.request("session/delete", { sessionId }));
	assert.equal(harness.adapter.sessionCount, 0);
	assert.equal(harness.clients[0].started, false);
	const listed = await connect(harness.adapter, (cx) => cx.request("session/list", {}));
	assert.equal(listed.sessions.length, 0);
});

test("session/set_config_option applies model and thought level and returns fresh options", async () => {
	const harness = createTestAdapter();
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp", mcpServers: [] }));
	const sessionId = (created as { sessionId: string }).sessionId;

	await connect(harness.adapter, async (cx) => {
		const model = await cx.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: "openai/gpt-5",
		}) as { configOptions: { id: string; currentValue: string }[] };
		assert.deepEqual(harness.clients[0]!.modelSets, [{ provider: "openai", modelId: "gpt-5" }]);
		assert.equal(model.configOptions.find((o) => o.id === "model")?.currentValue, "openai/gpt-5");

		const thought = await cx.request("session/set_config_option", {
			sessionId,
			configId: "thought_level",
			value: "high",
		}) as { configOptions: { id: string; currentValue: string }[] };
		assert.deepEqual(harness.clients[0]!.thinkingLevels, ["high"]);
		assert.equal(thought.configOptions.find((o) => o.id === "thought_level")?.currentValue, "high");

		await assert.rejects(
			cx.request("session/set_config_option", { sessionId, configId: "model", value: "bogus" }),
			/invalid model value/,
		);
		await assert.rejects(
			cx.request("session/set_config_option", { sessionId, configId: "thought_level", value: "quantum" }),
			/unknown thought level/,
		);
	});
});

test("built-in slash commands run pi-side actions and answer end_turn", async () => {
	const harness = createTestAdapter();
	const notifications: SessionNotification[] = [];
	// Everything happens over ONE connection: the session keeps the client
	// that created it, so notifications must flow on that same connection.
	await connect(
		harness.adapter,
		async (cx) => {
			const created = await cx.request("session/new", { cwd: "/tmp", mcpServers: [] });
			const sessionId = (created as { sessionId: string }).sessionId;

			const compact = await cx.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "/compact focus on tests" }],
			}) as { stopReason: string };
			assert.equal(compact.stopReason, "end_turn");
			assert.deepEqual(harness.clients[0]!.compactCalls, ["focus on tests"]);

			const named = await cx.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "/name Research" }],
			}) as { stopReason: string };
			assert.equal(named.stopReason, "end_turn");
			assert.deepEqual(harness.clients[0]!.nameCalls, ["Research"]);

			const model = await cx.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "/model openai/gpt-5" }],
			}) as { stopReason: string };
			assert.equal(model.stopReason, "end_turn");
			assert.deepEqual(harness.clients[0]!.modelSets, [{ provider: "openai", modelId: "gpt-5" }]);

			await assert.rejects(
				cx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/thinking warp" }] }),
				/unknown thought level/,
			);
			await assert.rejects(
				cx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/name" }] }),
				/usage: \/name/,
			);
		},
		(app) => {
			app.onNotification("session/update", (ctx) => { notifications.push(ctx.params); });
		},
	);

	assert.equal(harness.clients[0]!.promptCalls.length, 0, "built-ins never reach pi.prompt()");
	await waitFor(() => notifications.some((n) => n.update.sessionUpdate === "session_info_update"));
	const texts = notifications.map((n) => (n.update as { content?: { text?: string } }).content?.text ?? "");
	assert.ok(texts.some((t) => t.includes("compacted")), "compact feedback reported");
	assert.ok(texts.some((t) => t.includes("Research")), "rename feedback reported");
	const info = notifications.find((n) => n.update.sessionUpdate === "session_info_update");
	assert.equal((info?.update as { title?: string }).title, "Research");
});

test("unknown slash commands pass through to pi for native handling", async () => {
	const harness = createTestAdapter();
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp", mcpServers: [] }));
	const sessionId = (created as { sessionId: string }).sessionId;

	await connect(harness.adapter, async (cx) => {
		const pending = cx.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "/skill:pix run checks" }],
		});
		const pi = harness.clients[0]!;
		await waitFor(() => pi.promptCalls.length === 1);
		assert.deepEqual(pi.promptCalls, [{ message: "/skill:pix run checks", images: undefined }]);
		pi.emit({ type: "agent_start" });
		pi.emit({ type: "agent_settled" });
		const response = await pending as { stopReason: string };
		assert.equal(response.stopReason, "end_turn");
	});
});

test("built-in slash commands are refused while a run is active", async () => {
	const harness = createTestAdapter();
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp", mcpServers: [] }));
	const sessionId = (created as { sessionId: string }).sessionId;

	await connect(harness.adapter, async (cx) => {
		const pending = cx.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "slow work" }],
		});
		const pi = harness.clients[0]!;
		await waitFor(() => pi.promptCalls.length === 1);
		pi.emit({ type: "agent_start" });
		await assert.rejects(
			cx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/compact" }] }),
			/already in progress/,
		);
		pi.emit({ type: "agent_settled" });
		await pending;
	});
});

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
