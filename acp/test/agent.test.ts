import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import {
	client,
	methods,
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
import {
	PIX_DEFER_MESSAGE_METHOD,
	PIX_GIT_ASSIST_METHOD,
	PIX_QUEUE_ACTION_METHOD,
	PIX_QUEUE_CONSUMED_METHOD,
	PIX_QUEUE_MESSAGE_METHOD,
	PIX_QUEUE_STATE_METHOD,
	PIX_REGISTRY_ACTION_METHOD,
	PIX_TAKE_AUTO_MESSAGE_METHOD,
	PIX_RESUME_PATH_METHOD,
	PIX_SESSION_HISTORY_METHOD,
	PIX_SESSION_IMAGE_METHOD,
	PIX_TOOL_RESULT_METHOD,
	type DesktopQueueStateResponse,
	type DesktopQueuedUserMessage,
} from "../src/acp/desktop-commands.js";
import { PIX_QUESTION_EDITOR_TITLE } from "../src/acp/ui-request-bridge.js";

/**
 * The session map stores `resolve()`d pi session paths. On Windows a POSIX
 * literal such as `/tmp/pi-sessions/a.jsonl` resolves to `D:\tmp\...`, so every
 * fake pi session path (and expectation derived from it) must flow through the
 * same transform to stay comparable on all platforms.
 */
function piSessionPath(literal: string): string {
	return resolve(literal);
}
import { PIX_SESSION_STATE_METHOD } from "../src/acp/session-state-bridge.js";
import type {
	AutocompleteCompleterInput,
	AutocompleteResponse,
} from "../src/acp/autocomplete.js";
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
	PiSessionTreeNode,
	PiSessionState,
	PiSessionStats,
	PiSlashCommand,
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
	readonly queuedSteering: string[] = [];
	readonly queuedFollowUp: string[] = [];
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
	readonly commands: PiSlashCommand[] = [];
	readonly sessionStats: PiSessionStats;
	getCommandsCalls = 0;
	commandsGate: Promise<void> | undefined;
	readonly forkCalls: string[] = [];
	readonly forkMessagesCalls: number[] = [];
	readonly lastAssistantTextCalls: number[] = [];
	forkMessagesList: Array<{ entryId: string; text: string }> = [];
	forkCancelled = false;
	forkText = "forked selection";
	lastAssistantText: string | null = null;
	clones = 0;
	modelCycles = 0;
	cloneCancelled = false;
	cloneGate: Promise<void> | undefined;
	switchCancelled = false;
	promptHandledWithoutRun = false;
	stateError: Error | undefined;
	aborts = 0;
	abortSettles = false;
	started = false;
	startError: Error | undefined;
	startGate: Promise<void> | undefined;
	readonly eventsOnStart: PiEvent[] = [];
	promptHook: ((message: string) => void | Promise<void>) | undefined;
	treeState: { tree: PiSessionTreeNode[]; leafId: string | null } = { tree: [], leafId: null };
	state: PiSessionState;
	private listeners: PiEventListener[] = [];
	private exitListeners: ((error: Error) => void)[] = [];

	constructor(state: Partial<PiSessionState> = {}) {
		const n = ++fakeSessionCounter;
		this.state = {
			model: { provider: "anthropic", id: "claude-4", name: "Claude 4" },
			thinkingLevel: "medium",
			sessionFile: piSessionPath(`/tmp/pi-sessions/fake-${n}.jsonl`),
			sessionId: `pi-fake-${n}`,
			isStreaming: false,
			...state,
		};
		this.sessionStats = {
			sessionFile: this.state.sessionFile,
			sessionId: this.state.sessionId,
			userMessages: 2,
			assistantMessages: 2,
			toolCalls: 1,
			toolResults: 1,
			totalMessages: 6,
			tokens: { input: 100, output: 50, cacheRead: 25, cacheWrite: 5, total: 180 },
			cost: 0.012,
		};
	}

	async start(): Promise<void> {
		await this.startGate;
		if (this.startError) throw this.startError;
		this.started = true;
		for (const event of this.eventsOnStart) this.emit(event);
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
		await this.promptHook?.(message);
		if (!this.promptHandledWithoutRun) this.state = { ...this.state, isStreaming: true };
	}

	async steer(message: string): Promise<void> {
		this.steerCalls.push(message);
		this.queuedSteering.push(message);
		this.emitQueueUpdate();
	}

	async followUp(message: string): Promise<void> {
		this.followUpCalls.push(message);
		this.queuedFollowUp.push(message);
		this.emitQueueUpdate();
	}

	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		const result = {
			steering: [...this.queuedSteering],
			followUp: [...this.queuedFollowUp],
		};
		this.queuedSteering.length = 0;
		this.queuedFollowUp.length = 0;
		this.emitQueueUpdate();
		return result;
	}

	async abort(): Promise<void> {
		this.aborts++;
		if (this.abortSettles) {
			this.state = { ...this.state, isStreaming: false, isCompacting: false };
			this.emit({ type: "agent_settled" } as PiEvent);
		}
	}

	respondToExtensionUi(response: RpcExtensionUIResponse): void {
		this.uiResponses.push(response);
	}

	async getState(): Promise<PiSessionState> {
		if (this.stateError) throw this.stateError;
		return this.state;
	}

	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		this.switchSessions.push(sessionPath);
		this.state = { ...this.state, sessionFile: sessionPath };
		return { cancelled: this.switchCancelled };
	}

	async clone(): Promise<{ cancelled: boolean }> {
		this.clones++;
		await this.cloneGate;
		if (!this.cloneCancelled) {
			const n = ++fakeSessionCounter;
			this.state = {
				...this.state,
				sessionFile: piSessionPath(`/tmp/pi-sessions/fake-${n}.jsonl`),
				sessionId: `pi-fake-${n}`,
			};
		}
		return { cancelled: this.cloneCancelled };
	}

	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		this.forkCalls.push(entryId);
		if (!this.forkCancelled) {
			const n = ++fakeSessionCounter;
			this.state = {
				...this.state,
				sessionFile: piSessionPath(`/tmp/pi-sessions/fake-${n}.jsonl`),
				sessionId: `pi-fake-${n}`,
			};
		}
		return { text: this.forkText, cancelled: this.forkCancelled };
	}

	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		this.forkMessagesCalls.push(this.forkMessagesCalls.length);
		return this.forkMessagesList;
	}

	async getTree(): Promise<{ tree: PiSessionTreeNode[]; leafId: string | null }> {
		return this.treeState;
	}

	async getLastAssistantText(): Promise<string | null> {
		this.lastAssistantTextCalls.push(this.lastAssistantTextCalls.length);
		return this.lastAssistantText;
	}

	async getMessages(): Promise<PiAgentMessage[]> {
		return FakePiClient.sessionFiles.get(this.state.sessionFile ?? "") ?? [];
	}

	async getSessionStats(): Promise<PiSessionStats> {
		return this.sessionStats;
	}

	async getCommands(): Promise<PiSlashCommand[]> {
		this.getCommandsCalls += 1;
		await this.commandsGate;
		return this.commands;
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
		if (event.type === "agent_start") this.state = { ...this.state, isStreaming: true };
		if (event.type === "agent_settled") this.state = { ...this.state, isStreaming: false };
		for (const listener of [...this.listeners]) listener(event);
	}

	private emitQueueUpdate(): void {
		this.emit({
			type: "queue_update",
			steering: [...this.queuedSteering],
			followUp: [...this.queuedFollowUp],
		} as PiEvent);
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
		loadAutocompleteConfig: () => ({
			modelRef: "zai/glm-5-turbo",
			fallbackModels: [],
			debounceMs: 350,
			timeoutMs: 3_000,
			maxTokens: 48,
			maxPromptTokens: 1_200,
			includeRecentMessages: 0,
		}),
		loadDefaultModel: () => undefined,
		loadIgnoreContextFiles: () => false,
		...overrides,
	});
	return { adapter, clients, options, sessionMapPath };
}

function nativeSession(id: string, overrides: Partial<PiSessionInfo> = {}): PiSessionInfo {
	return {
		path: piSessionPath(`/tmp/pi-sessions/${id}.jsonl`),
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
	return connectAs(adapter, "pix-acp-test", op, setup);
}

async function connectAs<T>(
	adapter: PixAcpAgent,
	name: string,
	op: (cx: TestClientContext) => Promise<T>,
	setup?: (app: ReturnType<typeof client>) => void,
): Promise<T> {
	const app = client({ name });
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
	assert.ok(options.every((o) => o.env?.PIX_ACP_SESSION_STATE_BRIDGE === "1"));
	assert.equal(clients.length, 2);
	assert.ok(clients[0].started, "first pi client started");
	assert.ok(clients[1].started, "second pi client started");
	assert.ok(adapter.getSession(sessionIds[0]!), "first session registered");
	assert.ok(adapter.getSession(sessionIds[1]!), "second session registered");
});

test("desktop lazy session/new returns before pi startup and session/load joins the same runtime", async () => {
	let releaseStart!: () => void;
	const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
	const lazyClients: FakePiClient[] = [];
	const harness = createTestAdapter({
		createPiClient: () => {
			const fake = new FakePiClient();
			fake.startGate = startGate;
			lazyClients.push(fake);
			return fake;
		},
	});

	await connect(harness.adapter, async (cx) => {
		const created = await Promise.race([
			cx.request("session/new", {
				cwd: "/tmp/lazy-new",
				mcpServers: [],
				_meta: { "pix.lazyRuntime": true },
			}),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("lazy session/new blocked on pi startup")), 250)),
		]) as { sessionId: string };

		assert.equal(lazyClients.length, 1);
		assert.equal(lazyClients[0]!.started, false, "pi startup is still gated after the tab id is returned");

		let loadSettled = false;
		const loading = cx.request("session/load", {
			sessionId: created.sessionId,
			cwd: "/tmp/lazy-new",
			mcpServers: [],
			_meta: { "pix.lazyHistory": true },
		}).finally(() => { loadSettled = true; });
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(loadSettled, false, "runtime readiness still waits for the gated pi startup");

		releaseStart();
		await loading;
		assert.equal(lazyClients.length, 1, "session/load must join the pending new-session runtime instead of spawning again");
		assert.equal(lazyClients[0]!.started, true);
		assert.equal(harness.adapter.getSession(created.sessionId)?.pi, lazyClients[0]);
	});
});

test("session/new advertises supported built-ins and pi runtime slash commands", async () => {
	const harness = createTestAdapter({
		createPiClient: () => {
			const fake = new FakePiClient();
			fake.commands.push(
				{ name: "compact", description: "Must not replace the built-in", source: "extension", sourceInfo: {} },
				{ name: "settings", description: "Must not replace a Pix renderer command", source: "extension", sourceInfo: {} },
				{ name: "followup", description: "Must not replace a built-in alias", source: "extension", sourceInfo: {} },
				{ name: "thought", description: "Must not replace a built-in alias", source: "extension", sourceInfo: {} },
				{ name: "/skill:pix", description: "Use Pix project guidance", source: "skill", sourceInfo: {} },
				{ name: "review", source: "prompt", sourceInfo: {} },
			);
			return fake;
		},
	});

	const message = await connect(
		harness.adapter,
		async (cx) => {
			const session = await cx.buildSession("/tmp").start();
			return session.nextUpdate();
		},
	);

	assert.equal(message.kind, "session_update", "catalog arrives after ActiveSession is ready");
	const commands = ((message as { update: SessionNotification["update"] }).update as {
		availableCommands: Array<{
			name: string;
			description: string;
			input?: { hint: string };
			_meta?: Record<string, unknown>;
		}>;
	}).availableCommands;
	assert.deepEqual(commands.slice(0, 4).map((command) => command.name), ["settings", "compact", "name", "export"]);
	assert.ok(commands.some((command) => command.name === "session"));
	assert.ok(commands.some((command) => command.name === "clone"));
	assert.equal(commands.filter((command) => command.name === "compact").length, 1, "built-ins win collisions");
	assert.equal(commands.some((command) => command.name === "followup"), false, "built-in aliases win collisions");
	assert.equal(commands.some((command) => command.name === "thought"), false, "built-in aliases win collisions");
	assert.equal(commands.filter((command) => command.name === "settings").length, 1, "ACP built-ins win runtime collisions");
	assert.equal(commands.find((command) => command.name === "compact")?.input, undefined);
	assert.equal(commands.find((command) => command.name === "compact")?._meta?.["pix.inputHint"], "[instructions]");
	assert.equal(commands.find((command) => command.name === "name")?.input, undefined);
	assert.equal(commands.find((command) => command.name === "name")?._meta?.["pix.inputHint"], "[conversation name]");
	assert.equal(commands.find((command) => command.name === "compact")?._meta?.["pix.commandSource"], "builtin");
	assert.equal(commands.find((command) => command.name === "skill:pix")?.description, "Use Pix project guidance");
	assert.equal(commands.find((command) => command.name === "review")?.description, "Prompt template");
});

test("command discovery drops updates after the session is closed", async () => {
	const notifications: SessionNotification[] = [];
	let releaseCommands!: () => void;
	let pi!: FakePiClient;
	const harness = createTestAdapter({
		createPiClient: () => {
			pi = new FakePiClient();
			pi.commandsGate = new Promise<void>((resolve) => { releaseCommands = resolve; });
			return pi;
		},
	});

	await connect(
		harness.adapter,
		async (cx) => {
			const created = await cx.request("session/new", { cwd: "/tmp", mcpServers: [] }) as { sessionId: string };
			await waitFor(() => pi.getCommandsCalls === 1);
			await cx.request("session/close", { sessionId: created.sessionId });
			releaseCommands();
			await new Promise((resolve) => setTimeout(resolve, 10));
		},
		(app) => {
			app.onNotification("session/update", (ctx) => { notifications.push(ctx.params); });
		},
	);

	assert.equal(notifications.some((item) => item.update.sessionUpdate === "available_commands_update"), false);
});

test("session/new forwards structured extension state emitted during pi startup", async () => {
	let fake: FakePiClient | undefined;
	const notifications: Array<{ sessionId: string; channel: string; data: unknown }> = [];
	const { adapter } = createTestAdapter({
		createPiClient: () => {
			fake = new FakePiClient();
			fake.eventsOnStart.push({
				type: "extension_ui_request",
				id: "startup-state",
				method: "setWidget",
				widgetKey: "pix.session-state",
				widgetLines: ["pi-tools-suite:todo:state", JSON.stringify({ version: 1, checkedAt: 10 })],
			});
			return fake;
		},
	});

	const sessionId = await connect(
		adapter,
		async (cx) => (await cx.buildSession("/tmp/startup-state").start()).sessionId,
		(app) => {
			const customNotifications = app as unknown as {
				onNotification(
					method: string,
					parser: (params: unknown) => typeof notifications[number],
					handler: (ctx: { params: typeof notifications[number] }) => void,
				): void;
			};
			customNotifications.onNotification(PIX_SESSION_STATE_METHOD, (params) => params as typeof notifications[number], (ctx) => {
				notifications.push(ctx.params);
			});
		},
	);
	await waitFor(() => notifications.length === 1);

	assert.equal(fake?.started, true);
	assert.deepEqual(notifications, [{
		sessionId,
		channel: "pi-tools-suite:todo:state",
		data: { version: 1, checkedAt: 10 },
	}]);
});

test("session/new starts pi with the cwd Pix default model and thinking level", async () => {
	const resolvedCwds: string[] = [];
	const { adapter, options } = createTestAdapter({
		loadDefaultModel: (cwd) => {
			resolvedCwds.push(cwd);
			return {
				provider: "openai-codex",
				modelId: "gpt-5.6-sol",
				fallbackModels: [],
				thinkingLevel: "high",
			};
		},
	});
	await connect(adapter, (cx) => cx.buildSession("/tmp/pix-default").start());

	assert.deepEqual(resolvedCwds, ["/tmp/pix-default"]);
	assert.deepEqual(options[0], {
		piEntry: "/test/pi-rpc-entry.js",
		cwd: "/tmp/pix-default",
		env: { PIX_ACP_SESSION_STATE_BRIDGE: "1" },
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		args: ["--thinking", "high"],
	});
});

test("session/new applies the Pix no-context-files setting to the Pi RPC process", async () => {
	const resolvedCwds: string[] = [];
	const { adapter, options } = createTestAdapter({
		loadIgnoreContextFiles: (cwd) => {
			resolvedCwds.push(cwd);
			return true;
		},
	});
	await connect(adapter, (cx) => cx.buildSession("/tmp/no-context-project").start());

	assert.deepEqual(resolvedCwds, ["/tmp/no-context-project"]);
	assert.deepEqual(options[0]?.args, ["--no-context-files"]);
});

test("Desktop sessions explicitly load the bundled question, session-title, and workspace-undo extensions", async () => {
	const { adapter, options } = createTestAdapter({
		questionExtensionPath: "/opt/pix/question/index.js",
		sessionTitleExtensionPath: "/opt/pix/session-title/index.js",
		workspaceUndoExtensionPath: "/opt/pix/workspace-undo/index.js",
		loadDefaultModel: () => ({
			provider: "openai-codex",
			modelId: "gpt-5.6-sol",
			fallbackModels: [],
			thinkingLevel: "high",
		}),
	});
	await connect(adapter, (cx) => cx.buildSession("/tmp/pix-question").start());
	assert.deepEqual(options[0], {
		piEntry: "/test/pi-rpc-entry.js",
		cwd: "/tmp/pix-question",
		env: {
			PIX_ACP_SESSION_STATE_BRIDGE: "1",
			PIX_ACP_WORKSPACE_UNDO_BRIDGE: "1",
			PIX_QUESTION_RPC_BRIDGE: "1",
		},
		provider: "openai-codex",
		model: "gpt-5.6-sol",
		args: [
			"--extension",
			"/opt/pix/question/index.js",
			"--extension",
			"/opt/pix/session-title/index.js",
			"--extension",
			"/opt/pix/workspace-undo/index.js",
			"--thinking",
			"high",
		],
	});
});

test("Desktop publishes provisional and generated session titles from pi state", async () => {
	const harness = createTestAdapter();
	const notifications: SessionNotification[] = [];

	await connect(
		harness.adapter,
		async (cx) => {
			const created = await cx.request("session/new", { cwd: "/tmp/session-title", mcpServers: [] });
			const sessionId = (created as { sessionId: string }).sessionId;
			const pi = harness.clients[0]!;
			const originalPrompt = pi.prompt.bind(pi);
			pi.prompt = async (message: string, images?: PiImageContent[]) => {
				// The bundled session-title input hook sets its fallback name before
				// the RPC prompt acknowledgement returns.
				pi.state = { ...pi.state, sessionName: "Fix desktop session naming" };
				await originalPrompt(message, images);
			};

			const pending = cx.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "Fix desktop session naming" }],
			});

			await waitFor(() => notifications.some((notification) =>
				notification.update.sessionUpdate === "session_info_update"
				&& notification.update.title === "Fix desktop session naming"));

			// The title generator can replace the fallback while the agent runs.
			pi.state = { ...pi.state, sessionName: "Desktop session auto naming" };
			pi.emit({ type: "agent_start" });
			pi.emit({
				type: "agent_end",
				messages: [{ role: "assistant", content: [], stopReason: "stop" }],
				willRetry: false,
			} as unknown as JsonAgentSessionEvent);
			pi.emit({ type: "agent_settled" });
			await pending;

			await waitFor(() => notifications.some((notification) =>
				notification.update.sessionUpdate === "session_info_update"
				&& notification.update.title === "Desktop session auto naming"));

			// A slow title model may finish after the agent settles. The bundled
			// extension emits setTitle whenever it refreshes its generated name;
			// ACP uses that fire-and-forget UI event only as a state-sync wake-up.
			pi.state = { ...pi.state, sessionName: "Late generated desktop title" };
			pi.emit({
				type: "extension_ui_request",
				id: "session-title-refresh",
				method: "setTitle",
				title: "pi — Late generated desktop title",
			});
			await waitFor(() => notifications.some((notification) =>
				notification.update.sessionUpdate === "session_info_update"
				&& notification.update.title === "Late generated desktop title"));

			const listed = await cx.request("session/list", { cwd: "/tmp/session-title" }) as {
				sessions: Array<{ sessionId: string; title?: string }>;
			};
			assert.equal(listed.sessions.find((session) => session.sessionId === sessionId)?.title, "Late generated desktop title");
		},
		(app) => {
			app.onNotification("session/update", (ctx) => {
				notifications.push(ctx.params);
			});
		},
	);
});

test("pix/autocomplete routes the active session without mutating its prompt", async () => {
	let autocompleteInput: AutocompleteCompleterInput | undefined;
	const harness = createTestAdapter({
		completeAutocomplete: async (input) => {
			autocompleteInput = input;
			assert.deepEqual(await input.getMessages(), [
				{ role: "user", content: "previous request" },
			]);
			return " the rest";
		},
	});

	const response = await connect(harness.adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/autocomplete-project").start();
		const pi = harness.clients[0]!;
		FakePiClient.sessionFiles.set(pi.state.sessionFile!, [
			{ role: "user", content: "previous request" },
		]);
		return cx.request<AutocompleteResponse>("pix/autocomplete", {
			sessionId: session.sessionId,
			draft: "implement",
		});
	});

	assert.deepEqual(response, { completion: " the rest" });
	assert.equal(autocompleteInput?.cwd, "/tmp/autocomplete-project");
	assert.equal(autocompleteInput?.draft, "implement");
	assert.deepEqual(harness.clients[0]?.promptCalls, []);
});

test("pix/prompt/enhance uses the dedicated enhancer without sending a session prompt", async () => {
	let observed: { cwd: string; draft: string } | undefined;
	const harness = createTestAdapter({
		enhancePrompt: async ({ cwd, draft }) => {
			observed = { cwd, draft };
			return "Improved prompt";
		},
	});

	const response = await connect(harness.adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/enhance-project").start();
		return cx.request("pix/prompt/enhance", {
			sessionId: session.sessionId,
			draft: "make tests better",
		});
	});

	assert.deepEqual(response, { prompt: "Improved prompt" });
	assert.deepEqual(observed, { cwd: "/tmp/enhance-project", draft: "make tests better" });
	assert.deepEqual(harness.clients[0]?.promptCalls, []);
});

test("pix/git/assist runs independently while the main session prompt is active", async () => {
	let observed: { cwd: string; kind: string; diff: string } | undefined;
	const harness = createTestAdapter({
		gitAssistant: async ({ cwd, kind, diff }) => {
			observed = { cwd, kind, diff };
			return "No significant findings.";
		},
	});

	await connect(harness.adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/git-review-project").start();
		const pendingPrompt = cx.request("session/prompt", {
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "keep working" }],
		});
		const pi = harness.clients[0]!;
		await waitFor(() => pi.promptCalls.length === 1);

		const review = await cx.request(PIX_GIT_ASSIST_METHOD, {
			sessionId: session.sessionId,
			kind: "review",
			diff: "diff --git a/a.ts b/a.ts\n+const ready = true;",
		});
		assert.deepEqual(review, { text: "No significant findings." });
		assert.deepEqual(observed, {
			cwd: "/tmp/git-review-project",
			kind: "review",
			diff: "diff --git a/a.ts b/a.ts\n+const ready = true;",
		});

		pi.emit({ type: "agent_start" });
		pi.emit({ type: "agent_settled" });
		await pendingPrompt;
	});
});

test("pix/autocomplete/config exposes project eligibility and debounce", async () => {
	const harness = createTestAdapter({
		loadAutocompleteConfig: () => ({
			modelRef: "",
			fallbackModels: [],
			debounceMs: 725,
			timeoutMs: 3_000,
			maxTokens: 48,
			maxPromptTokens: 1_200,
			includeRecentMessages: 0,
		}),
	});

	const response = await connect(harness.adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/autocomplete-project").start();
		return cx.request("pix/autocomplete/config", { sessionId: session.sessionId });
	});

	assert.deepEqual(response, { enabled: false, debounceMs: 725 });
});

test("pix/autocomplete propagates request cancellation to the completer", async () => {
	let observedSignal: AbortSignal | undefined;
	const harness = createTestAdapter({
		completeAutocomplete: ({ signal }) => new Promise<string>((_resolve, reject) => {
			observedSignal = signal;
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		}),
	});

	await connect(harness.adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/autocomplete-project").start();
		const request = cx.request<AutocompleteResponse>(
			"pix/autocomplete",
			{ sessionId: session.sessionId, draft: "implement" },
		);
		while (!observedSignal) await new Promise<void>((resolve) => setImmediate(resolve));
		await cx.notify(methods.protocol.cancelRequest, { requestId: 1 });
		await assert.rejects(request);
		assert.equal(observedSignal?.aborted, true);
	});
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
	const firstPath = piSessionPath("/tmp/pi-sessions/native-a.jsonl");
	const secondPath = piSessionPath("/tmp/pi-sessions/native-b.jsonl");
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
		piSessionPath: piSessionPath("/tmp/pi-sessions/mapped.jsonl"),
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
		.map((m) => (m as { update: { sessionUpdate: string; content?: unknown } }).update)
		.filter((update) => update.sessionUpdate === "agent_message_chunk");
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
			{ type: "resource_link", uri: "file:///tmp/demo.mp4", name: "demo.mp4" },
		]);
		const pi = clients[0]!;
		await waitFor(() => pi.promptCalls.length === 1);
		assert.deepEqual(pi.promptCalls[0].images, [{ type: "image", data: "aGk=", mimeType: "image/png" }]);
		assert.equal(pi.promptCalls[0].message, "look\n\n[Pix attachment: file:///tmp/demo.mp4]");

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

test("Pix Desktop file-backed prompt images are materialized server-side", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pix-acp-file-image-"));
	const imagePath = join(directory, "clipboard.png");
	await writeFile(imagePath, Buffer.from("hello image"));
	const uri = pathToFileURL(imagePath).href;
	const { adapter, clients } = createTestAdapter();

	const result = await connect(adapter, async (cx) => {
		await cx.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: { elicitation: { form: {} } },
			clientInfo: { name: "pix-desktop", version: "0.1.0" },
		});
		const created = await cx.request("session/new", { cwd: directory, mcpServers: [] });
		const pending = cx.request("session/prompt", {
			sessionId: created.sessionId,
			prompt: [
				{ type: "text", text: "inspect this" },
				{ type: "resource_link", uri, name: "clipboard.png", mimeType: "image/png", size: 11 },
			],
			_meta: {
				"pix.fileImages": [{ uri, mimeType: "image/png", size: 11, name: "clipboard.png" }],
			},
		});
		const pi = clients[0]!;
		await Promise.race([
			waitFor(() => pi.promptCalls.length === 1),
			pending.then(
				() => Promise.reject(new Error("prompt resolved before reaching pi")),
				(error: unknown) => Promise.reject(error),
			),
		]);
		assert.equal(pi.promptCalls[0].message, "inspect this");
		assert.deepEqual(pi.promptCalls[0].images, [{
			type: "image",
			data: Buffer.from("hello image").toString("base64"),
			mimeType: "image/png",
		}]);

		pi.emit({ type: "agent_start" });
		pi.emit({
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "stop" }],
			willRetry: false,
		} as unknown as JsonAgentSessionEvent);
		pi.emit({ type: "agent_settled" });
		return pending;
	});

	assert.equal((result as { stopReason: string }).stopReason, "end_turn");
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

test("malformed reserved question carriers are cancelled instead of left blocking", async () => {
	const { adapter, clients } = createTestAdapter();
	let elicitationCalls = 0;
	await connect(
		adapter,
		async (cx) => {
			await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, ...ELICITATION_CAPS });
			await cx.buildSession("/tmp").start();
			clients[0]!.emit({
				type: "extension_ui_request",
				id: "question-malformed",
				method: "editor",
				title: PIX_QUESTION_EDITOR_TITLE,
				prefill: "not json",
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
	assert.deepEqual(clients[0]!.uiResponses, [{ type: "extension_ui_response", id: "question-malformed", cancelled: true }]);
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
				{
					role: "toolResult",
					content: [
						{ type: "text", text: "hi" },
						{ type: "image", data: "dG9vbA==", mimeType: "image/png" },
					],
					toolCallId: "t1",
				} as unknown as PiAgentMessage,
				{ role: "user", content: [{ type: "text", text: "again" }, { type: "image", data: "aGk=", mimeType: "image/png" }] },
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
	await waitFor(() => notifications.filter((n) => n.update.sessionUpdate !== "available_commands_update").length >= 6);
	const replayNotifications = notifications.filter((n) => n.update.sessionUpdate !== "available_commands_update");
	const replayed = replayNotifications.map((n) => ({
		sessionUpdate: n.update.sessionUpdate,
		text: replayText(n.update as Record<string, unknown>),
		toolCallId: (n.update as { toolCallId?: string }).toolCallId,
	}));
	assert.deepEqual(replayed, [
		{ sessionUpdate: "user_message_chunk", text: "hello there", toolCallId: undefined },
		{ sessionUpdate: "agent_message_chunk", text: "general kenobi", toolCallId: undefined },
		{ sessionUpdate: "tool_call", text: undefined, toolCallId: "t1" },
		{ sessionUpdate: "tool_call_update", text: "hi", toolCallId: "t1" },
		{ sessionUpdate: "user_message_chunk", text: "again", toolCallId: undefined },
		{ sessionUpdate: "user_message_chunk", text: undefined, toolCallId: undefined },
	]);
	assert.deepEqual((replayNotifications[replayNotifications.length - 1]!.update as { content: unknown }).content, {
		type: "image",
		data: "aGk=",
		mimeType: "image/png",
	});
	const toolCall = notifications.find((n) => n.update.sessionUpdate === "tool_call")!.update as Record<string, unknown>;
	assert.equal(toolCall.name, "bash");
	assert.equal(toolCall.title, "Bash: echo hi");
	assert.equal(toolCall.kind, "execute");
	assert.equal(toolCall.status, "in_progress");
	assert.deepEqual(toolCall.rawInput, { command: "echo hi" });
	const toolUpdate = notifications.find((n) => n.update.sessionUpdate === "tool_call_update")!.update as Record<string, unknown>;
	assert.equal(toolUpdate.status, "completed");
	assert.deepEqual(toolUpdate.content, [
		{ type: "content", content: { type: "text", text: "hi" } },
		{ type: "content", content: { type: "image", data: "dG9vbA==", mimeType: "image/png" } },
	]);
	assert.equal(harness.adapter.getSession(sessionId) !== undefined, true, "loaded session is live");
});

test("Pix Desktop registry actions forward only to the extension-owned private registry RPC command", async () => {
	const harness = createTestAdapter();
	const notifications: SessionNotification[] = [];
	await connectAs(harness.adapter, "pix-desktop", async (cx) => {
		const created = await cx.request("session/new", { cwd: "/tmp/registry-gui", mcpServers: [] }) as { sessionId: string };
		const pi = harness.clients[0]!;

		await assert.rejects(
			cx.request(PIX_REGISTRY_ACTION_METHOD, { sessionId: created.sessionId, action: "refresh" }),
			/resource registry extension is unavailable/,
		);

		pi.commands.push({
			name: "registry",
			description: "Manage registry",
			source: "extension",
			sourceInfo: {},
		});
		pi.commands.push({ name: "skill:frontier-model-rollover", source: "skill", sourceInfo: {} });
		pi.promptHandledWithoutRun = true;
		const originalPrompt = pi.prompt.bind(pi);
		pi.prompt = async (message: string, images?: PiImageContent[]) => {
			await originalPrompt(message, images);
			if (message !== "/registry rpc update skill pdf") return;
			pi.emit({
				type: "extension_ui_request",
				id: "registry-reload-context-inventory",
				method: "setWidget",
				widgetKey: "pix.session-state",
				widgetLines: [
					"pi-tools-suite:context-inventory",
					JSON.stringify({
						version: 1,
						reason: "reload",
						model: "anthropic/claude-4",
						thinking: "medium",
						tools: ["read", "subagents"],
						skills: [],
						agents: ["research"],
					}),
				],
			});
		};

		await cx.request(PIX_REGISTRY_ACTION_METHOD, { sessionId: created.sessionId, action: "refresh" });
		await cx.request(PIX_REGISTRY_ACTION_METHOD, {
			sessionId: created.sessionId,
			action: "update",
			type: "skill",
			name: "pdf",
		});
		await cx.request(PIX_REGISTRY_ACTION_METHOD, {
			sessionId: created.sessionId,
			action: "pull-project",
			scope: "todo",
		});

		assert.deepEqual(pi.promptCalls.slice(-3), [
			{ message: "/registry rpc refresh", images: undefined },
			{ message: "/registry rpc update skill pdf", images: undefined },
			{ message: "/registry rpc pull todo", images: undefined },
		]);
	}, (app) => {
		app.onNotification("session/update", (ctx) => {
			notifications.push(ctx.params);
		});
	});
	const text = notifications.map((item) => (item.update as { content?: { text?: string } }).content?.text ?? "").join("\n");
	assert.match(text, /Reloaded resources\n\nModel: anthropic\/claude-4:medium/);
	assert.match(text, /Skills \(in context\): frontier-model-rollover/);
});

test("desktop lazy session/load omits tool bodies and retrieves them on demand", async () => {
	const harness = createTestAdapter();
	const notifications: SessionNotification[] = [];
	await connect(
		harness.adapter,
		async (cx) => {
			const created = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] });
			const sessionId = (created as { sessionId: string }).sessionId;
			const lazyImageData = "aGk=";
			FakePiClient.sessionFiles.set(harness.clients[0]!.state.sessionFile ?? "", [
				{
					role: "user",
					content: [
						{ type: "text", text: "inspect it" },
						{ type: "image", data: lazyImageData, mimeType: "image/png" },
					],
				} as unknown as PiAgentMessage,
				{
					role: "assistant",
					content: [
						{ type: "text", text: "checking" },
						{ type: "toolCall", id: "lazy-tool", name: "read", arguments: { path: "/tmp/proj/big.log" } },
					],
				},
				{
					role: "toolResult",
					toolCallId: "lazy-tool",
					content: [{ type: "text", text: "very large output" }],
					details: { bytes: 1_000_000 },
				} as unknown as PiAgentMessage,
			]);

			await cx.request("session/load", {
				sessionId,
				cwd: "/tmp/proj",
				mcpServers: [],
				_meta: { "pix.lazyHistory": true },
			});
			await new Promise((resolve) => setTimeout(resolve, 10));
			assert.equal(
				notifications.filter((notification) => notification.update.sessionUpdate !== "available_commands_update").length,
				0,
				"lazy load must not replay persisted messages through session/update",
			);

			const history = await cx.request(PIX_SESSION_HISTORY_METHOD, { sessionId }) as {
				updates: Array<Record<string, unknown>>;
				deferredToolCallIds: string[];
			};
			assert.deepEqual(history.deferredToolCallIds, ["lazy-tool"]);
			assert.equal(JSON.stringify(history).includes(lazyImageData), false, "initial history must omit image data");
			const imageUpdate = history.updates.find((update) => {
				if (update.sessionUpdate !== "user_message_chunk") return false;
				const content = update.content as { type?: string; uri?: string } | undefined;
				return content?.type === "resource_link" && content.uri?.startsWith("pix-deferred-image:");
			});
			const imageContent = imageUpdate?.content as { uri?: string } | undefined;
			assert.ok(imageContent?.uri);
			const imageId = decodeURIComponent(imageContent.uri.slice("pix-deferred-image:".length));
			const hydratedImage = await cx.request(PIX_SESSION_IMAGE_METHOD, { sessionId, imageId }) as {
				data: string;
				mimeType: string;
			};
			assert.deepEqual(hydratedImage, { data: lazyImageData, mimeType: "image/png" });
			const toolCall = history.updates.find((update) => update.sessionUpdate === "tool_call");
			assert.equal(toolCall?.name, "read");
			assert.equal("rawInput" in (toolCall ?? {}), false, "tool input is deferred");
			const lightResult = history.updates.find((update) => update.sessionUpdate === "tool_call_update");
			assert.equal(lightResult?.status, "completed");
			assert.equal("content" in (lightResult ?? {}), false, "tool output content is deferred");
			assert.equal("rawOutput" in (lightResult ?? {}), false, "tool raw output is deferred");

			const hydrated = await cx.request(PIX_TOOL_RESULT_METHOD, {
				sessionId,
				toolCallId: "lazy-tool",
			}) as { update: Record<string, unknown> };
			assert.equal(
				notifications.filter((notification) => notification.update.sessionUpdate !== "available_commands_update").length,
				0,
				"lazy tool-result hydration must not replay or append a session/update",
			);
			assert.deepEqual(hydrated.update.rawInput, { path: "/tmp/proj/big.log" });
			assert.deepEqual(hydrated.update.rawOutput, { bytes: 1_000_000 });
			assert.deepEqual(hydrated.update.content, [
				{ type: "content", content: { type: "text", text: "very large output" } },
			]);

			const other = await cx.request("session/new", { cwd: "/tmp/other", mcpServers: [] }) as { sessionId: string };
			await assert.rejects(
				() => cx.request(PIX_TOOL_RESULT_METHOD, { sessionId: other.sessionId, toolCallId: "lazy-tool" }),
				/tool result lazy-tool is not available for lazy loading/,
			);
		},
		(app) => {
			app.onNotification("session/update", (ctx) => { notifications.push(ctx.params); });
		},
	);
});

test("desktop lazy session/load reuses an already-live tab runtime", async () => {
	const harness = createTestAdapter();
	await connect(harness.adapter, async (cx) => {
		const created = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] });
		const sessionId = (created as { sessionId: string }).sessionId;
		const original = harness.clients[0]!;

		await cx.request("session/load", {
			sessionId,
			cwd: "/tmp/proj",
			mcpServers: [],
			_meta: { "pix.lazyHistory": true },
		});

		assert.equal(harness.clients.length, 1, "tab switch must not spawn another pi runtime");
		assert.equal(original.started, true, "the cached runtime remains alive");
		assert.deepEqual(original.switchSessions, [], "an already-live tab does not switch its session file again");
	});
});

test("desktop history is readable directly from JSONL while the pi runtime is closed", async () => {
	const harness = createTestAdapter();
	await connect(harness.adapter, async (cx) => {
		const created = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] });
		const sessionId = (created as { sessionId: string }).sessionId;
		const store = new SessionMapStore(harness.sessionMapPath, TEST_LOGGER);
		const record = await store.get(sessionId);
		assert.ok(record);
		const sessionPath = join(dirname(harness.sessionMapPath), "direct-history.jsonl");
		await writeFile(sessionPath, [
			JSON.stringify({ type: "session", version: 3, id: "pi-direct", timestamp: "2026-09-06T00:00:00.000Z", cwd: "/tmp/proj" }),
			JSON.stringify({
				type: "message",
				id: "u1",
				parentId: null,
				timestamp: "2026-09-06T00:00:01.000Z",
				message: { role: "user", content: "direct history" },
			}),
		].join("\n") + "\n", "utf8");
		await store.put({ ...record, piSessionPath: sessionPath, piSessionId: "pi-direct" });
		await cx.request("session/close", { sessionId });
		assert.equal(harness.adapter.getSession(sessionId), undefined, "test requires no live pi runtime");

		const history = await cx.request(PIX_SESSION_HISTORY_METHOD, { sessionId }) as {
			updates: Array<Record<string, unknown>>;
		};
		assert.deepEqual(history.updates, [{
			sessionUpdate: "user_message_chunk",
			messageId: "replay-0",
			content: { type: "text", text: "direct history" },
		}]);
		assert.equal(harness.clients.length, 1, "reading history must not spawn pi");
	});
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
	const renamedPath = piSessionPath("/tmp/pi-sessions/moved-by-pi.jsonl");

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
	const harness = createTestAdapter({
		loadDefaultModel: () => ({
			provider: "openai-codex",
			modelId: "gpt-5.6-sol",
			fallbackModels: [],
			thinkingLevel: "medium",
		}),
	});
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
	assert.deepEqual(harness.options[1], {
		piEntry: "/test/pi-rpc-entry.js",
		cwd: "/tmp/proj",
		env: { PIX_ACP_SESSION_STATE_BRIDGE: "1" },
	}, "resumed session history must select its own model and thinking level");
	assert.equal(
		notifications.filter((notification) => notification.update.sessionUpdate !== "available_commands_update").length,
		0,
		"resume replays nothing except command discovery",
	);
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

test("session/fork with pix.entryId forks at the entry and returns the selected text", async () => {
	const harness = createTestAdapter();
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] }));
	const sourceId = (created as { sessionId: string }).sessionId;

	const forked = await connect(harness.adapter, (cx) =>
		cx.request("session/fork", {
			sessionId: sourceId,
			cwd: "/tmp/proj",
			mcpServers: [],
			_meta: { "pix.entryId": "entry-7" },
		}),
	) as { sessionId: string; _meta?: Record<string, unknown> };
	assert.notEqual(forked.sessionId, sourceId);
	assert.deepEqual(harness.clients[1]!.forkCalls, ["entry-7"], "forks at the requested entry");
	assert.equal(harness.clients[1]!.clones, 0, "entry fork must not fall back to clone");
	assert.equal(forked._meta?.["pix.selectedText"], "forked selection");
	assert.equal(harness.adapter.getSession(forked.sessionId) !== undefined, true);
});

test("session/fork with pix.entryId reports extension cancellation", async () => {
	const harness = createTestAdapter({
		createPiClient: (): PiClient => {
			const fake = new FakePiClient();
			fake.forkCancelled = true;
			return fake;
		},
	});
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] }));
	const sourceId = (created as { sessionId: string }).sessionId;

	await connect(harness.adapter, (cx) =>
		assert.rejects(
			cx.request("session/fork", {
				sessionId: sourceId,
				cwd: "/tmp/proj",
				mcpServers: [],
				_meta: { "pix.entryId": "entry-7" },
			}),
			/fork cancelled/,
		),
	);
	assert.equal(harness.adapter.sessionCount, 1, "only the source session stays live");
});

test("pix/session/fork_messages returns forkable user messages when idle", async () => {
	const harness = createTestAdapter();
	await connect(harness.adapter, async (cx) => {
		const created = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] });
		const sessionId = (created as { sessionId: string }).sessionId;

		const empty = await cx.request<{ messages: Array<{ entryId: string; text: string }> }>(
			"pix/session/fork_messages",
			{ sessionId },
		);
		assert.deepEqual(empty.messages, []);

		harness.clients[0]!.forkMessagesList = [
			{ entryId: "e1", text: "first question" },
			{ entryId: "e2", text: "second question" },
		];
		const populated = await cx.request<{ messages: Array<{ entryId: string; text: string }> }>(
			"pix/session/fork_messages",
			{ sessionId },
		);
		assert.deepEqual(populated.messages, [
			{ entryId: "e1", text: "first question" },
			{ entryId: "e2", text: "second question" },
		]);

		await assert.rejects(
			cx.request("pix/session/fork_messages", { sessionId: "" }),
			/non-empty string sessionId/,
		);
		await assert.rejects(
			cx.request("pix/session/fork_messages", { sessionId: "missing" }),
			/unknown session missing/,
		);
	});
});

test("pix/session/branch_user_messages returns only user entries on the active tree branch", async () => {
	const harness = createTestAdapter();
	await connect(harness.adapter, async (cx) => {
		const created = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] });
		const sessionId = (created as { sessionId: string }).sessionId;
		const pi = harness.clients[0]!;
		pi.treeState = {
			leafId: "assistant-2",
			tree: [{
				entry: { id: "user-1", type: "message", message: { role: "user", content: "same prompt" } },
				children: [{
					entry: { id: "assistant-1", type: "message", message: { role: "assistant", content: [] } },
					children: [
						{
							entry: { id: "user-2", type: "message", message: { role: "user", content: [{ type: "text", text: "same prompt" }] } },
							children: [{
								entry: { id: "assistant-2", type: "message", message: { role: "assistant", content: [] } },
								children: [],
							}],
						},
						{
							entry: { id: "abandoned-user", type: "message", message: { role: "user", content: "old branch" } },
							children: [],
						},
					],
				}],
			}],
		};

		const response = await cx.request<{ messages: Array<{ entryId: string; text: string }> }>(
			"pix/session/branch_user_messages",
			{ sessionId },
		);
		assert.deepEqual(response.messages, [
			{ entryId: "user-1", text: "same prompt" },
			{ entryId: "user-2", text: "same prompt" },
		]);
	});
});

test("Desktop user-message copy and undo use the selected Pi entry id without model fallback", async () => {
	const copied: string[] = [];
	const harness = createTestAdapter({ copyText: async (text) => { copied.push(text); } });
	await connectAs(harness.adapter, "pix-desktop", async (cx) => {
		const created = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] });
		const sessionId = (created as { sessionId: string }).sessionId;
		const pi = harness.clients[0]!;
		pi.treeState = {
			leafId: "user-2",
			tree: [{
				entry: { id: "user-1", type: "message", message: { role: "user", content: "first" } },
				children: [{
					entry: { id: "user-2", type: "message", message: { role: "user", content: "second" } },
					children: [],
				}],
			}],
		};

		const copiedResponse = await cx.request<{ status: string }>("pix/session/user_message_action", {
			sessionId,
			entryId: "user-1",
			action: "copy",
		});
		assert.equal(copiedResponse.status, "ok");
		assert.deepEqual(copied, ["first"]);

		await assert.rejects(
			cx.request("pix/session/user_message_action", { sessionId, entryId: "user-1", action: "undo" }),
			/workspace undo bridge is unavailable/u,
		);
		assert.equal(pi.promptCalls.length, 0, "private undo text must never fall through when the bridge is missing");

		pi.commands.push({
			name: "__pix-workspace-undo",
			description: "internal",
			source: "extension",
			sourceInfo: {},
		});
		pi.promptHandledWithoutRun = true;
		pi.promptHook = async (message) => {
			const [, serialized = ""] = message.split(" ", 2);
			const request = JSON.parse(serialized) as { requestId: string; targetEntryId: string };
			assert.equal(request.targetEntryId, "user-1");
			pi.emit({
				type: "extension_ui_request",
				id: "undo-result",
				method: "setWidget",
				widgetKey: "pix.session-state",
				widgetLines: [
					"pix.workspace-undo-result",
					JSON.stringify({ requestId: request.requestId, status: "warning", error: "parallel edit conflict" }),
				],
			} as PiEvent);
		};

		const undo = await cx.request<{
			status: string;
			editorText: string;
			warning: string;
		}>("pix/session/user_message_action", {
			sessionId,
			entryId: "user-1",
			action: "undo",
		});
		assert.deepEqual(undo, {
			status: "warning",
			editorText: "first",
			warning: "parallel edit conflict",
		});
		assert.match(pi.promptCalls.at(-1)?.message ?? "", /^\/__pix-workspace-undo /u);
	});
});

test("Pix Desktop deferred queue persists and edit returns the paused message", async () => {
	let persisted: { auto: DesktopQueuedUserMessage[]; deferred: DesktopQueuedUserMessage[] } = {
		auto: [],
		deferred: [],
	};
	const harness = createTestAdapter({
		loadDesktopQueues: async () => ({
			auto: persisted.auto.map((message) => ({ ...message, images: message.images.map((image) => ({ ...image })) })),
			deferred: persisted.deferred.map((message) => ({ ...message, images: message.images.map((image) => ({ ...image })) })),
		}),
		saveDesktopQueues: async (_cwd, _sessionPath, queues) => {
			persisted = {
				auto: queues.auto.map((message) => ({ ...message, images: message.images.map((image) => ({ ...image })) })),
				deferred: queues.deferred.map((message) => ({ ...message, images: message.images.map((image) => ({ ...image })) })),
			};
		},
	});

	await connectAs(harness.adapter, "pix-desktop", async (cx) => {
		const created = await cx.request("session/new", { cwd: "/tmp/queue-deferred", mcpServers: [] }) as { sessionId: string };
		const queued = await cx.request(PIX_DEFER_MESSAGE_METHOD, {
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "send this later" }],
			displayText: "send this later",
		}) as { disposition: string; itemId: string };
		assert.equal(queued.disposition, "deferred");
		assert.equal(persisted.deferred.length, 1);

		const state = await cx.request(PIX_QUEUE_STATE_METHOD, { sessionId: created.sessionId }) as DesktopQueueStateResponse;
		assert.equal(state.items.length, 1);
		assert.equal(state.items[0]?.source, "deferred");
		assert.equal(state.items[0]?.text, "send this later");

		const edited = await cx.request(PIX_QUEUE_ACTION_METHOD, {
			sessionId: created.sessionId,
			source: "deferred",
			index: 0,
			text: "send this later",
			action: "edit",
		}) as { message?: DesktopQueuedUserMessage };
		assert.equal(edited.message?.promptText, "send this later");
		assert.deepEqual(persisted.deferred, []);
	});
});

test("Pix Desktop queues Enter during streaming as Pi steering and reports consumption", async () => {
	const harness = createTestAdapter({
		loadDesktopQueues: async () => ({ auto: [], deferred: [] }),
		saveDesktopQueues: async () => {},
	});
	const consumed: Array<{ sessionId: string; message: DesktopQueuedUserMessage }> = [];

	await connectAs(
		harness.adapter,
		"pix-desktop",
		async (cx) => {
			const created = await cx.request("session/new", { cwd: "/tmp/queue-steering", mcpServers: [] }) as { sessionId: string };
			const pi = harness.clients[0]!;
			pi.state = { ...pi.state, isStreaming: true };

			const queued = await cx.request(PIX_QUEUE_MESSAGE_METHOD, {
				sessionId: created.sessionId,
				prompt: [{ type: "text", text: "steer me next" }],
				displayText: "steer me next",
			}) as { disposition: string };
			assert.equal(queued.disposition, "steering");
			assert.deepEqual(pi.steerCalls, ["steer me next"]);

			const state = await cx.request(PIX_QUEUE_STATE_METHOD, { sessionId: created.sessionId }) as DesktopQueueStateResponse;
			assert.equal(state.items[0]?.source, "sdk-steering");
			assert.equal(state.items[0]?.message?.displayText, "steer me next");

			await pi.clearQueue();
			pi.emit({ type: "message_start", message: { role: "user", content: "steer me next" } } as PiEvent);
			await waitFor(() => consumed.length === 1);
			assert.equal(consumed[0]?.sessionId, created.sessionId);
			assert.equal(consumed[0]?.message.displayText, "steer me next");
		},
		(app) => {
			const customNotifications = app as unknown as {
				onNotification(
					method: string,
					parser: (params: unknown) => typeof consumed[number],
					handler: (ctx: { params: typeof consumed[number] }) => void,
				): void;
			};
			customNotifications.onNotification(
				PIX_QUEUE_CONSUMED_METHOD,
				(params) => params as typeof consumed[number],
				(ctx) => consumed.push(ctx.params),
			);
		},
	);
});

test("Pix Desktop auto queue waits while Pi is idle-but-admitted and can be taken for the next turn", async () => {
	let persisted: { auto: DesktopQueuedUserMessage[]; deferred: DesktopQueuedUserMessage[] } = { auto: [], deferred: [] };
	const harness = createTestAdapter({
		loadDesktopQueues: async () => persisted,
		saveDesktopQueues: async (_cwd, _sessionPath, queues) => {
			persisted = {
				auto: queues.auto.map((message) => ({ ...message, images: message.images.map((image) => ({ ...image })) })),
				deferred: queues.deferred.map((message) => ({ ...message, images: message.images.map((image) => ({ ...image })) })),
			};
		},
	});

	await connectAs(harness.adapter, "pix-desktop", async (cx) => {
		const created = await cx.request("session/new", { cwd: "/tmp/queue-auto", mcpServers: [] }) as { sessionId: string };
		const queued = await cx.request(PIX_QUEUE_MESSAGE_METHOD, {
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "after current turn" }],
			displayText: "after current turn",
		}) as { disposition: string };
		assert.equal(queued.disposition, "auto");
		assert.equal(persisted.auto.length, 1);

		const taken = await cx.request(PIX_TAKE_AUTO_MESSAGE_METHOD, { sessionId: created.sessionId }) as {
			message?: DesktopQueuedUserMessage;
		};
		assert.equal(taken.message?.displayText, "after current turn");
		assert.deepEqual(persisted.auto, []);
	});
});

test("Pix Desktop send-now interrupts the active run before returning the selected paused message", async () => {
	const harness = createTestAdapter({
		loadDesktopQueues: async () => ({ auto: [], deferred: [] }),
		saveDesktopQueues: async () => {},
	});

	await connectAs(harness.adapter, "pix-desktop", async (cx) => {
		const created = await cx.request("session/new", { cwd: "/tmp/queue-send-now", mcpServers: [] }) as { sessionId: string };
		const pi = harness.clients[0]!;
		const running = cx.request("session/prompt", {
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "long running turn" }],
		});
		await waitFor(() => pi.promptCalls.length === 1);
		pi.emit({ type: "agent_start" } as PiEvent);
		pi.abortSettles = true;

		await cx.request(PIX_DEFER_MESSAGE_METHOD, {
			sessionId: created.sessionId,
			prompt: [{ type: "text", text: "send this now" }],
			displayText: "send this now",
		});
		const result = await cx.request(PIX_QUEUE_ACTION_METHOD, {
			sessionId: created.sessionId,
			source: "deferred",
			index: 0,
			text: "send this now",
			action: "send-now",
		}) as { message?: DesktopQueuedUserMessage };

		assert.equal(pi.aborts, 1);
		assert.equal(result.message?.displayText, "send this now");
		assert.equal((await running).stopReason, "end_turn");
	});
});

test("pix/session/reload respawns the pi client and reports the reload", async () => {
	const harness = createTestAdapter();
	const notifications: SessionNotification[] = [];
	await connect(
		harness.adapter,
		async (cx) => {
			const created = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] });
			const sessionId = (created as { sessionId: string }).sessionId;
			const first = harness.clients[0]!;

			const response = await cx.request("pix/session/reload", { sessionId });
			assert.equal(typeof response, "object");

			assert.equal(first.started, false, "the old pi client is stopped");
			assert.equal(harness.adapter.sessionCount, 1, "the ACP session id stays the same");
			assert.equal(harness.clients.length, 2, "a fresh pi client is spawned");
			assert.equal(harness.clients[1]!.switchSessions.length, 1, "the replacement loads the same pi session");
		},
		(app) => {
			app.onNotification("session/update", (ctx) => {
				notifications.push(ctx.params);
			});
		},
	);
	const reloaded = notifications.map((n) => (n.update as { content?: { text?: string } }).content?.text ?? "");
	assert.equal(
		reloaded.some((text) => text.includes("/reload — reloaded extensions, skills, prompts, and context files")),
		true,
		"the reload status message is delivered",
	);
});

test("pix/session/reload reports model-available skills, tools, and agents from the replacement", async () => {
	const fakes: FakePiClient[] = [];
	const { adapter } = createTestAdapter({
		createPiClient: () => {
			const fake = new FakePiClient();
			fakes.push(fake);
			if (fakes.length === 2) {
				fake.commands.push(
					{ name: "skill:frontier-model-rollover", source: "skill", sourceInfo: {} },
					{ name: "skill:project-agent-creator", source: "skill", sourceInfo: {} },
				);
				fake.eventsOnStart.push({
					type: "extension_ui_request",
					id: "reload-context-inventory",
					method: "setWidget",
					widgetKey: "pix.session-state",
					widgetLines: [
						"pi-tools-suite:context-inventory",
						JSON.stringify({
							version: 1,
							model: "openai-codex/gpt-5.6-luna",
							thinking: "medium",
							tools: ["repo_search", "read", "subagents"],
							skills: ["frontier-model-rollover", "project-agent-creator"],
							agents: ["frontier-review", "research"],
						}),
					],
				});
			}
			return fake;
		},
	});
	const notifications: SessionNotification[] = [];

	await connect(
		adapter,
		async (cx) => {
			const created = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] });
			const sessionId = (created as { sessionId: string }).sessionId;
			await cx.request("pix/session/reload", { sessionId });
		},
		(app) => {
			app.onNotification("session/update", (ctx) => {
				notifications.push(ctx.params);
			});
		},
	);

	const text = notifications.map((item) => (item.update as { content?: { text?: string } }).content?.text ?? "").join("\n");
	assert.match(text, /Model: openai-codex\/gpt-5\.6-luna:medium/);
	assert.match(text, /Skills \(in context\): frontier-model-rollover, project-agent-creator/);
	assert.match(text, /Tools \(active\): repo_search, read, subagents/);
	assert.match(text, /Agents \(available\): frontier-review, research/);
});

test("pix/session/reload rejects while the session is streaming", async () => {
	const harness = createTestAdapter();
	await connect(harness.adapter, async (cx) => {
		const created = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] });
		const sessionId = (created as { sessionId: string }).sessionId;
		harness.clients[0]!.state = { ...harness.clients[0]!.state, isStreaming: true };

		await assert.rejects(
			cx.request("pix/session/reload", { sessionId }),
			/reload is unavailable while the session is busy/,
		);
		assert.equal(harness.clients.length, 1, "no replacement client is spawned");
		assert.equal(harness.adapter.sessionCount, 1);
	});
});

test("pix/session/resume_path switches the live session to an explicit path", async () => {
	const harness = createTestAdapter();
	await connect(harness.adapter, async (cx) => {
		const created = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] });
		const sessionId = (created as { sessionId: string }).sessionId;
		const response = await cx.request(PIX_RESUME_PATH_METHOD, {
			sessionId,
			path: "saved/session.jsonl",
		}) as { configOptions?: unknown[] };

		assert.equal(harness.clients[0]!.switchSessions.at(-1), resolve("/tmp/proj/saved/session.jsonl"));
		assert.ok(Array.isArray(response.configOptions));
	});
});

test("pix/session/import copies an external JSONL into the current session dir and switches to it", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pix-acp-import-"));
	const sessionDir = join(cwd, "sessions");
	const externalDir = join(cwd, "external");
	await mkdir(sessionDir, { recursive: true });
	await mkdir(externalDir, { recursive: true });
	const currentPath = join(sessionDir, "current.jsonl");
	const importPath = join(externalDir, "imported.jsonl");
	const currentJsonl = `${JSON.stringify({ type: "session", version: 3, id: "current", timestamp: "2026-09-06T00:00:00.000Z", cwd })}\n`;
	const importedJsonl = `${JSON.stringify({ type: "session", version: 3, id: "imported", timestamp: "2026-09-06T00:00:00.000Z", cwd })}\n`;
	await writeFile(currentPath, currentJsonl, "utf8");
	await writeFile(importPath, importedJsonl, "utf8");

	const harness = createTestAdapter();
	await connect(harness.adapter, async (cx) => {
		const created = await cx.request("session/new", { cwd, mcpServers: [] });
		const sessionId = (created as { sessionId: string }).sessionId;
		const pi = harness.clients[0]!;
		pi.state = { ...pi.state, sessionFile: currentPath, sessionId: "current" };

		await cx.request("pix/session/import", { sessionId, path: importPath });
		const destination = join(sessionDir, "imported.jsonl");
		assert.deepEqual(pi.switchSessions, [destination]);
		assert.equal(await readFile(destination, "utf8"), importedJsonl);
	});
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

test("session/set_config_option reports the effective context after a model change", async () => {
	const harness = createTestAdapter();
	const notifications: SessionNotification[] = [];
	await connect(
		harness.adapter,
		async (cx) => {
			const created = await cx.request("session/new", { cwd: "/tmp", mcpServers: [] });
			const sessionId = (created as { sessionId: string }).sessionId;
			const pi = harness.clients[0]!;
			pi.commands.push({ name: "skill:frontier-model-rollover", source: "skill", sourceInfo: {} });
			const originalSetModel = pi.setModel.bind(pi);
			pi.setModel = async (provider: string, modelId: string) => {
				const model = await originalSetModel(provider, modelId);
				pi.emit({
					type: "extension_ui_request",
					id: "model-context-inventory",
					method: "setWidget",
					widgetKey: "pix.session-state",
					widgetLines: [
						"pi-tools-suite:context-inventory",
						JSON.stringify({
							version: 1,
							reason: "model_select",
							model: `${provider}/${modelId}`,
							thinking: "medium",
							tools: ["read", "subagents"],
							skills: ["frontier-model-rollover"],
							agents: ["frontier-review", "research"],
						}),
					],
				});
				return model;
			};

			await cx.request("session/set_config_option", {
				sessionId,
				configId: "model",
				value: "openai/gpt-5",
			});
		},
		(app) => {
			app.onNotification("session/update", (ctx) => {
				notifications.push(ctx.params);
			});
		},
	);

	const text = notifications.map((item) => (item.update as { content?: { text?: string } }).content?.text ?? "").join("\n");
	assert.match(text, /Model changed to openai\/gpt-5\n\nModel: openai\/gpt-5:medium/);
	assert.match(text, /Skills \(in context\): frontier-model-rollover/);
	assert.match(text, /Agents \(available\): frontier-review, research/);
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

			const currentName = await cx.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "/name" }],
			}) as { stopReason: string };
			assert.equal(currentName.stopReason, "end_turn");
			assert.deepEqual(harness.clients[0]!.nameCalls, ["Research"], "querying the name does not rename");

			const sessionInfo = await cx.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "/session" }],
			}) as { stopReason: string };
			assert.equal(sessionInfo.stopReason, "end_turn");

			const cloned = await cx.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "/clone" }],
			}) as { stopReason: string };
			assert.equal(cloned.stopReason, "end_turn");
			assert.equal(harness.clients[0]!.clones, 1);

			const model = await cx.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "/model openai/gpt-5:high" }],
			}) as { stopReason: string };
			assert.equal(model.stopReason, "end_turn");
			assert.deepEqual(harness.clients[0]!.modelSets, [{ provider: "openai", modelId: "gpt-5" }]);
			assert.deepEqual(harness.clients[0]!.thinkingLevels, ["high"]);

			await assert.rejects(
				cx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/thinking warp" }] }),
				/unknown thought level/,
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
	assert.ok(texts.some((t) => t.includes("Session info") && t.includes("180 total")), "session stats reported");
	assert.ok(texts.some((t) => t.includes("session duplicated")), "clone feedback reported");
	const info = notifications.find((n) => n.update.sessionUpdate === "session_info_update");
	assert.equal((info?.update as { title?: string }).title, "Research");
});

test("no-argument Pix config commands elicit a choice instead of guessing", async () => {
	const harness = createTestAdapter();
	const requests: CreateElicitationRequest[] = [];

	await connect(
		harness.adapter,
		async (cx) => {
			await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, ...ELICITATION_CAPS });
			const created = await cx.request("session/new", { cwd: "/tmp", mcpServers: [] });
			const sessionId = (created as { sessionId: string }).sessionId;
			const response = await cx.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "/default-model" }],
			}) as { stopReason: string };
			assert.equal(response.stopReason, "cancelled");
		},
		(app) => {
			app.onRequest("elicitation/create", (ctx) => {
				requests.push(ctx.params);
				return { action: "cancel" } satisfies CreateElicitationResponse;
			});
		},
	);

	assert.equal(requests.length, 1);
	const schema = (requests[0] as { requestedSchema?: { properties?: { value?: { enum?: string[] } } } }).requestedSchema;
	assert.deepEqual(schema?.properties?.value?.enum, [
		"anthropic/claude-4",
		"anthropic/claude-3",
		"openai/gpt-5",
	]);
});

test("/export preserves TUI HTML-vs-JSONL semantics", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pix-acp-export-"));
	const source = join(cwd, "source.jsonl");
	await writeFile(source, "session-jsonl\n", "utf8");
	const harness = createTestAdapter();

	await connect(harness.adapter, async (cx) => {
		const created = await cx.request("session/new", { cwd, mcpServers: [] });
		const sessionId = (created as { sessionId: string }).sessionId;
		const pi = harness.clients[0]!;
		pi.state = { ...pi.state, sessionFile: source };

		await cx.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "/export 'exports/copy.jsonl'" }],
		});
		assert.equal(await readFile(join(cwd, "exports", "copy.jsonl"), "utf8"), "session-jsonl\n");
		assert.deepEqual(pi.exportCalls, [], "JSONL export copies the native session rather than invoking the HTML exporter");

		await cx.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "/export exports/copy.html" }],
		});
		assert.deepEqual(pi.exportCalls, [join(cwd, "exports", "copy.html")]);
	});
});

test("/copy copies the last assistant message and reports when there is none", async () => {
	const copied: string[] = [];
	const harness = createTestAdapter({
		copyText: async (text) => {
			copied.push(text);
		},
	});
	const notifications: SessionNotification[] = [];
	await connect(
		harness.adapter,
		async (cx) => {
			const created = await cx.request("session/new", { cwd: "/tmp", mcpServers: [] });
			const sessionId = (created as { sessionId: string }).sessionId;
			const pi = harness.clients[0]!;

			await assert.rejects(
				cx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/copy" }] }),
				/no assistant messages to copy yet/,
			);
			assert.deepEqual(copied, [], "nothing is copied without an assistant message");

			pi.lastAssistantText = "the answer text";
			const copy = await cx.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "/copy" }],
			}) as { stopReason: string };
			assert.equal(copy.stopReason, "end_turn");
			assert.deepEqual(copied, ["the answer text"]);
			assert.equal(pi.promptCalls.length, 0, "/copy never reaches pi.prompt()");
		},
		(app) => {
			app.onNotification("session/update", (ctx) => {
				notifications.push(ctx.params);
			});
		},
	);
	await waitFor(() =>
		notifications.some((n) =>
			((n.update as { content?: { text?: string } }).content?.text ?? "").includes("copied the last assistant message"),
		),
	);
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

test("remaining Pix renderer commands are not forwarded to the model", async () => {
	const harness = createTestAdapter();
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp", mcpServers: [] }));
	const sessionId = (created as { sessionId: string }).sessionId;

	await assert.rejects(
		connect(harness.adapter, (cx) => cx.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "/queue send this later" }],
		})),
		/requires Pix renderer UI/,
	);
	assert.equal(harness.clients[0]!.promptCalls.length, 0);
});

test("intentionally unsupported Pix commands are rejected explicitly and not forwarded", async () => {
	const harness = createTestAdapter();
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp", mcpServers: [] }));
	const sessionId = (created as { sessionId: string }).sessionId;

	await assert.rejects(
		connect(harness.adapter, (cx) => cx.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "/trust" }],
		})),
		/intentionally not supported in Pix Desktop/,
	);
	assert.equal(harness.clients[0]!.promptCalls.length, 0);
});

test("extension-handled slash commands finish without an agent run", async () => {
	const harness = createTestAdapter();
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp", mcpServers: [] }));
	const sessionId = (created as { sessionId: string }).sessionId;
	const pi = harness.clients[0]!;
	pi.promptHandledWithoutRun = true;

	const response = await connect(harness.adapter, (cx) => cx.request("session/prompt", {
		sessionId,
		prompt: [{ type: "text", text: "/extension-action" }],
	})) as { stopReason: string };

	assert.equal(response.stopReason, "end_turn");
	assert.deepEqual(pi.promptCalls, [{ message: "/extension-action", images: undefined }]);
});

test("extension-handled reload commands report the final effective context", async () => {
	const harness = createTestAdapter();
	const notifications: SessionNotification[] = [];
	await connect(
		harness.adapter,
		async (cx) => {
			const created = await cx.request("session/new", { cwd: "/tmp", mcpServers: [] });
			const sessionId = (created as { sessionId: string }).sessionId;
			const pi = harness.clients[0]!;
			pi.promptHandledWithoutRun = true;
			pi.commands.push({ name: "skill:frontier-model-rollover", source: "skill", sourceInfo: {} });
			const originalPrompt = pi.prompt.bind(pi);
			pi.prompt = async (message: string, images?: PiImageContent[]) => {
				await originalPrompt(message, images);
				pi.emit({
					type: "extension_ui_request",
					id: "extension-reload-context-inventory",
					method: "setWidget",
					widgetKey: "pix.session-state",
					widgetLines: [
						"pi-tools-suite:context-inventory",
						JSON.stringify({
							version: 1,
							reason: "reload",
							model: "anthropic/claude-4",
							thinking: "medium",
							tools: ["read", "subagents"],
							skills: [],
							agents: ["research"],
						}),
					],
				});
			};

			const response = await cx.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "/registry install helper" }],
			}) as { stopReason: string };
			assert.equal(response.stopReason, "end_turn");
		},
		(app) => {
			app.onNotification("session/update", (ctx) => {
				notifications.push(ctx.params);
			});
		},
	);

	const text = notifications.map((item) => (item.update as { content?: { text?: string } }).content?.text ?? "").join("\n");
	assert.match(text, /Reloaded resources\n\nModel: anthropic\/claude-4:medium/);
	assert.match(text, /Skills \(in context\): frontier-model-rollover/);
	assert.match(text, /Tools \(active\): read, subagents/);
	assert.match(text, /Agents \(available\): research/);
});

test("extension-handled commands with attachments finish without an agent run", async () => {
	const harness = createTestAdapter();
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp", mcpServers: [] }));
	const sessionId = (created as { sessionId: string }).sessionId;
	const pi = harness.clients[0]!;
	pi.promptHandledWithoutRun = true;

	const response = await connect(harness.adapter, (cx) => cx.request("session/prompt", {
		sessionId,
		prompt: [
			{ type: "text", text: "/extension-action" },
			{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
		],
	})) as { stopReason: string };

	assert.equal(response.stopReason, "end_turn");
	assert.equal(pi.promptCalls.length, 1);
	assert.equal(pi.promptCalls[0]?.images?.length, 1);
});

test("input-hook-handled plain prompts finish without an agent run", async () => {
	const harness = createTestAdapter();
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp", mcpServers: [] }));
	const sessionId = (created as { sessionId: string }).sessionId;
	const pi = harness.clients[0]!;
	pi.promptHandledWithoutRun = true;

	const response = await connect(harness.adapter, (cx) => cx.request("session/prompt", {
		sessionId,
		prompt: [{ type: "text", text: "handled by an input hook" }],
	})) as { stopReason: string };

	assert.equal(response.stopReason, "end_turn");
	assert.deepEqual(pi.promptCalls, [{ message: "handled by an input hook", images: undefined }]);
});

test("slash command state inspection failures reject instead of hanging", async () => {
	const harness = createTestAdapter();
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp", mcpServers: [] }));
	const sessionId = (created as { sessionId: string }).sessionId;
	const pi = harness.clients[0]!;
	pi.promptHandledWithoutRun = true;
	pi.stateError = new Error("state unavailable");

	await assert.rejects(
		connect(harness.adapter, (cx) => cx.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "/extension-action" }],
		})),
		/prompt state inspection failed: state unavailable/,
	);
	assert.equal(harness.adapter.getSession(sessionId)?.activeRun, undefined);
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

test("normal prompts are refused while a built-in mutates the session", async () => {
	const harness = createTestAdapter();
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp", mcpServers: [] }));
	const sessionId = (created as { sessionId: string }).sessionId;
	const pi = harness.clients[0]!;
	let releaseClone!: () => void;
	pi.cloneGate = new Promise<void>((resolve) => { releaseClone = resolve; });

	await connect(harness.adapter, async (cx) => {
		const cloning = cx.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "/clone" }],
		});
		await waitFor(() => pi.clones === 1);
		await assert.rejects(
			cx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "overlapping work" }] }),
			/already in progress/,
		);
		releaseClone();
		await cloning;
	});
});

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
