import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import {
	client,
	methods,
	PROTOCOL_VERSION,
	RequestError,
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
import { DesktopSearchService } from "../src/search/service.js";
import { SearchPreferences } from "../src/search/config.js";
import { SEARCH_QUERY_METHOD, SEARCH_CONFIG_METHOD, SEARCH_INTENT_METHOD, SEARCH_TASKS_METHOD, type SearchQueryResponse, type SemanticTasksResponse } from "../src/search/contract.js";
import { TASK_TYPE_CLASSIFY_METHOD } from "../src/tasks/type-classification-contract.js";
import { SEARCH_RAG_METHOD, SEARCH_RAG_DELTA_METHOD } from "../src/search/rag-contract.js";
import { SEARCH_COMMITS_METHOD, type CommitSearchRequest } from "../src/search/commit-contract.js";
import { BTW_METHOD, type BtwCommand, type BtwState } from "../src/btw/contract.js";
import {
	PIX_DEFER_MESSAGE_METHOD,
	PIX_FORK_MESSAGE_METHOD,
	PIX_FORK_READY_METHOD,
	PIX_DCP_STATS_METHOD,
	PIX_DRAFT_CONFIG_METHOD,
	PIX_BASH_METHOD,
	PIX_CLEAR_TODOS_METHOD,
	PIX_LSP_CONTROL_METHOD,
	PIX_AGENT_CONTROL_METHOD,
	PIX_GIT_ASSIST_METHOD,
	PIX_QUEUE_ACTION_METHOD,
	PIX_QUEUE_CONSUMED_METHOD,
	PIX_QUEUE_MESSAGE_METHOD,
	PIX_QUEUE_STATE_METHOD,
	PIX_REGISTRY_ACTION_METHOD,
	PIX_REGISTRY_DIFF_METHOD,
	PIX_TAKE_AUTO_MESSAGE_METHOD,
	PIX_RESUME_PATH_METHOD,
	PIX_RUNTIME_STATUS_METHOD,
	PIX_CLAUDE_QUOTA_REFRESH_METHOD,
	PIX_SESSION_USAGE_METHOD,
	PIX_SESSION_HISTORY_METHOD,
	PIX_SESSION_IMAGE_METHOD,
	PIX_TOOL_RESULT_METHOD,
	type DesktopQueueStateResponse,
	type DesktopAgentControlResponse,
	type DesktopDcpStatsResponse,
	type DesktopDraftConfigResponse,
	type DesktopRuntimeStatusResponse,
	type DesktopSessionUsageResponse,
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
import {
	PIX_CONTEXT_USAGE_CHANNEL,
	PIX_DCP_TOKENS_SAVED_CHANNEL,
	PIX_DCP_CONTEXT_MAP_CHANNEL,
	PIX_MODEL_USAGE_CHANNEL,
	PIX_SESSION_STATE_METHOD,
} from "../src/acp/session-state-bridge.js";
import type {
	AutocompleteCompleterInput,
	AutocompleteResponse,
} from "../src/acp/autocomplete.js";
import { SessionMapStore } from "../src/acp/session-map.js";
import { PIX_SESSION_CATALOG_CHANGED_METHOD } from "../src/acp/session-catalog-contract.js";
import type { PersistedDesktopQueues } from "../src/acp/queue-store.js";
import type { DesktopForkSnapshot, DesktopForkChild } from "../src/acp/desktop-fork-snapshot.js";
import type { Logger } from "../src/logging.js";
import type {
	PiAgentMessage,
	PiBashResult,
	PiClient,
	PiCompactionResult,
	PiEvent,
	PiEventListener,
	PiImageContent,
	PiModel,
	PiRpcClientOptions,
	PiSessionEntry,
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
	clearTodosCalls = 0;
	clearTodosGate: Promise<void> | undefined;
	clearTodosError: Error | undefined;
	readonly lspControlCalls: Array<{ action: string; id?: string; root?: string }> = [];
	readonly bashCalls: { command: string; excludeFromContext: boolean }[] = [];
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
	getSessionStatsCalls = 0;
	getCommandsCalls = 0;
	commandsGate: Promise<void> | undefined;
	readonly forkCalls: string[] = [];
	readonly forkMessagesCalls: number[] = [];
	getEntriesCalls = 0;
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
	pauses = 0;
	cancelPauses = 0;
	continues = 0;
	abortSettles = false;
	started = false;
	startError: Error | undefined;
	startGate: Promise<void> | undefined;
	readonly eventsOnStart: PiEvent[] = [];
	promptHook: ((message: string) => void | Promise<void>) | undefined;
	bashGate: Promise<void> | undefined;
	bashResult: PiBashResult = {
		output: "command output",
		exitCode: 0,
		cancelled: false,
		truncated: false,
	};
	pauseHook: (() => void | Promise<void>) | undefined;
	cancelPauseHook: (() => void | Promise<void>) | undefined;
	continueHook: (() => void | Promise<void>) | undefined;
	entriesState: { entries: PiSessionEntry[]; leafId: string | null } = { entries: [], leafId: null };
	state: PiSessionState;
	private listeners: PiEventListener[] = [];
	private exitListeners: ((error: Error) => void)[] = [];

	get eventListenerCount(): number {
		return this.listeners.length;
	}

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

	async clearTodos(): Promise<void> {
		this.clearTodosCalls++;
		await this.clearTodosGate;
		if (this.clearTodosError) throw this.clearTodosError;
	}

	async lspControl(action: "status" | "start" | "stop" | "restart" | "trust", id?: string, root?: string) {
		this.lspControlCalls.push({ action, ...(id === undefined ? {} : { id }), ...(root === undefined ? {} : { root }) });
		return { servers: [{ id: "ts", root: root ?? "/tmp", state: "running" as const }], warnings: [] };
	}

	async bash(command: string, excludeFromContext = false): Promise<PiBashResult> {
		this.bashCalls.push({ command, excludeFromContext });
		await this.bashGate;
		return this.bashResult;
	}

	async pause(): Promise<void> {
		this.pauses += 1;
		await this.pauseHook?.();
	}

	async cancelPause(): Promise<void> {
		this.cancelPauses += 1;
		await this.cancelPauseHook?.();
	}

	async continue(): Promise<void> {
		this.continues += 1;
		await this.continueHook?.();
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

	async getEntries(): Promise<{ entries: PiSessionEntry[]; leafId: string | null }> {
		this.getEntriesCalls += 1;
		return this.entriesState;
	}

	async getLastAssistantText(): Promise<string | null> {
		this.lastAssistantTextCalls.push(this.lastAssistantTextCalls.length);
		return this.lastAssistantText;
	}

	async getMessages(): Promise<PiAgentMessage[]> {
		return FakePiClient.sessionFiles.get(this.state.sessionFile ?? "") ?? [];
	}

	async getSessionStats(): Promise<PiSessionStats> {
		this.getSessionStatsCalls += 1;
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

test("desktop draft model metadata overrides the configured default only for the new session", async () => {
	const harness = createTestAdapter({
		loadDefaultModel: () => ({
			provider: "anthropic",
			modelId: "claude-4",
			thinkingLevel: "medium",
			fallbackModels: [],
		}),
	});

	await connect(harness.adapter, async (cx) => {
		await cx.request("session/new", {
			cwd: "/tmp/draft-model",
			mcpServers: [],
			_meta: {
				"pix.draftModel": "openai-codex/gpt-5.6-sol",
				"pix.draftThinking": "high",
			},
		});
	});

	assert.equal(harness.options.length, 1);
	assert.equal(harness.options[0]?.provider, "openai-codex");
	assert.equal(harness.options[0]?.model, "gpt-5.6-sol");
	assert.ok(harness.options[0]?.args?.includes("--thinking"));
	assert.ok(harness.options[0]?.args?.includes("high"));
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

test("startup and idle extension warnings/errors reach system rows without a prompt", async () => {
	const notifications: SessionNotification[] = [];
	let pi!: FakePiClient;
	const harness = createTestAdapter({
		createPiClient: () => {
			pi = new FakePiClient();
			pi.eventsOnStart.push({ type: "extension_ui_request", id: "auth-startup", method: "notify",
				message: "Claude Code provider is unavailable: Run `claude auth login`, then /reload", notifyType: "error" });
			return pi;
		},
	});
	let sessionId = "";
	await connect(harness.adapter, async (cx) => {
		sessionId = (await cx.buildSession("/tmp/startup-notice").start()).sessionId;
		await waitFor(() => notifications.some((item) => item.update.sessionUpdate === "agent_message_chunk"));
		pi.emit({ type: "extension_ui_request", id: "idle-warning", method: "notify", message: "Idle warning", notifyType: "warning" });
		pi.emit({ type: "extension_ui_request", id: "idle-info", method: "notify", message: "Background info", notifyType: "info" });
		await waitFor(() => notifications.filter((item) => item.update.sessionUpdate === "agent_message_chunk").length === 2);
	}, (app) => {
		app.onNotification("session/update", (ctx) => { notifications.push(ctx.params); });
	});
	const feedback = notifications.filter((item) => item.update.sessionUpdate === "agent_message_chunk");
	assert.equal(feedback.length, 2);
	for (const item of feedback) {
		assert.equal(item.sessionId, sessionId);
		assert.match((item.update as { messageId: string }).messageId, /^pix-system:/);
	}
	assert.deepEqual(feedback.map((item) => (item.update as { content: { text: string } }).content.text), [
		"Claude Code provider is unavailable: Run `claude auth login`, then /reload", "Idle warning",
	]);
	assert.deepEqual(pi.uiResponses, []);
});

test("desktop activity attachment rebinds a reused lazy runtime and replays its cached snapshot", async () => {
	const notifications: Array<{ sessionId: string; channel: string; data: unknown; activityOwner?: string }> = [];
	const harness = createTestAdapter({
		createPiClient: () => {
			const fake = new FakePiClient();
			fake.eventsOnStart.push({
				type: "extension_ui_request", id: "startup-activity", method: "setWidget",
				widgetKey: "pix.session-state",
				widgetLines: ["pi-tools-suite:todo:state", JSON.stringify({ version: 1, checkedAt: 10 })],
			});
			return fake;
		},
	});
	await connect(harness.adapter, async (cx) => {
		const created = await cx.request("session/new", {
			cwd: "/tmp/activity-owner", mcpServers: [], _meta: { "pix.lazyRuntime": true, "pix.activityOwner": "first" },
		}) as { sessionId: string };
		await cx.request("session/load", { sessionId: created.sessionId, cwd: "/tmp/activity-owner",
			mcpServers: [], _meta: { "pix.lazyHistory": true, "pix.activityOwner": "first" } });
		await waitFor(() => notifications.length === 1);
		assert.equal(notifications[0]?.activityOwner, "first");
		await cx.request("session/load", { sessionId: created.sessionId, cwd: "/tmp/activity-owner",
			mcpServers: [], _meta: { "pix.lazyHistory": true, "pix.activityOwner": "second" } });
		await waitFor(() => notifications.length === 2);
		assert.deepEqual(notifications[1], { ...notifications[0], activityOwner: "second" });
	}, (app) => {
		const custom = app as unknown as { onNotification(method: string, parser: (params: unknown) => typeof notifications[number],
			handler: (ctx: { params: typeof notifications[number] }) => void): void };
		custom.onNotification(PIX_SESSION_STATE_METHOD, (params) => params as typeof notifications[number],
			(ctx) => { notifications.push(ctx.params); });
	});
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

test("Desktop sessions explicitly load all bundled extensions", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pix-acp-session-extensions-"));
	t.after(() => rm(agentDir, { recursive: true, force: true }));
	const { adapter, options } = createTestAdapter({
		agentDir,
		questionExtensionPath: "/opt/pix/question/index.js",
		sessionTitleExtensionPath: "/opt/pix/session-title/index.js",
		headsUpExtensionPath: "/opt/pix/heads-up/index.js",
		workspaceUndoExtensionPath: "/opt/pix/workspace-undo/index.js",
		toolsSuiteExtensionPath: "/opt/pix/pi-tools-suite/index.ts",
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
			"--extension",
			"/opt/pix/pi-tools-suite/index.ts",
			"--extension",
			"/opt/pix/heads-up/index.js",
			"--thinking",
			"high",
		],
	});
});

test("interactive HTML capability extension is loaded only for Pix Desktop, never other ACP clients", async (t) => {
	const agentDir = mkdtempSync(join(tmpdir(), "pix-acp-html-extension-"));
	t.after(() => rm(agentDir, { recursive: true, force: true }));
	const path = "/opt/pix/html-sandbox/index.js";
	const desktop = createTestAdapter({
		agentDir,
		htmlSandboxExtensionPath: path,
	});
	await connectAs(desktop.adapter, "pix-desktop", async (cx) => {
		await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "pix-desktop", version: "test" } });
		await cx.buildSession("/tmp/pix-html-desktop").start();
	});
	assert.deepEqual(desktop.options[0]?.args, ["--extension", path]);

	const other = createTestAdapter({
		agentDir,
		htmlSandboxExtensionPath: path,
	});
	await connectAs(other.adapter, "zed", async (cx) => {
		await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "zed", version: "test" } });
		await cx.buildSession("/tmp/pix-html-zed").start();
	});
	assert.equal(other.options[0]?.args?.includes(path) ?? false, false);
});

function draftProviderExtensionSource(provider: string, model: string): string {
	return `
export default function registerDraftProvider(pi) {
	pi.registerProvider("${provider}", {
		baseUrl: "https://example.invalid",
		apiKey: "test-key",
		api: "openai-completions",
		models: [{
			id: "${model}",
			name: "Draft model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1024,
			maxTokens: 256,
		}],
	});
}
`;
}

test("Desktop draft config includes bundled and workspace extension models without starting a Pi session", async () => {
	const root = mkdtempSync(join(tmpdir(), "pix-acp-draft-models-"));
	const workspaceWithExtension = join(root, "with-extension");
	const workspaceWithoutExtension = join(root, "without-extension");
	const extensionDir = join(workspaceWithExtension, ".pi", "extensions", "workspace-provider");
	const bundledExtensionPath = join(root, "bundled-provider.ts");
	const agentDir = join(root, "agent");
	try {
		await mkdir(extensionDir, { recursive: true });
		await mkdir(workspaceWithoutExtension, { recursive: true });
		await writeFile(
			join(extensionDir, "index.ts"),
			draftProviderExtensionSource("workspace-provider", "workspace-model"),
			"utf8",
		);
		await writeFile(
			bundledExtensionPath,
			draftProviderExtensionSource("bundled-provider", "bundled-model"),
			"utf8",
		);

		const harness = createTestAdapter({ agentDir, toolsSuiteExtensionPath: bundledExtensionPath });
		const withExtension = await connect(harness.adapter, (cx) =>
			cx.request(PIX_DRAFT_CONFIG_METHOD, { cwd: workspaceWithExtension })) as DesktopDraftConfigResponse;
		const withoutExtension = await connect(harness.adapter, (cx) =>
			cx.request(PIX_DRAFT_CONFIG_METHOD, { cwd: workspaceWithoutExtension })) as DesktopDraftConfigResponse;

		assert.match(JSON.stringify(withExtension.configOptions), /bundled-provider\/bundled-model/u);
		assert.match(JSON.stringify(withoutExtension.configOptions), /bundled-provider\/bundled-model/u);
		assert.match(JSON.stringify(withExtension.configOptions), /workspace-provider\/workspace-model/u);
		assert.doesNotMatch(JSON.stringify(withoutExtension.configOptions), /workspace-provider\/workspace-model/u);

		const addedExtensionDir = join(workspaceWithExtension, ".pi", "extensions", "added-provider");
		await mkdir(addedExtensionDir, { recursive: true });
		await writeFile(
			join(addedExtensionDir, "index.ts"),
			draftProviderExtensionSource("added-provider", "added-model"),
			"utf8",
		);
		const reloaded = await connect(harness.adapter, (cx) =>
			cx.request(PIX_DRAFT_CONFIG_METHOD, { cwd: workspaceWithExtension })) as DesktopDraftConfigResponse;
		assert.match(JSON.stringify(reloaded.configOptions), /added-provider\/added-model/u);
		assert.equal(harness.clients.length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Desktop uses an installed pi-tools-suite instead of loading the bundled copy twice", async () => {
	const root = mkdtempSync(join(tmpdir(), "pix-acp-installed-tools-suite-"));
	const workspace = join(root, "workspace");
	const agentDir = join(root, "agent");
	const installedExtensionDir = join(agentDir, "extensions", "pi-tools-suite");
	const bundledExtensionPath = join(root, "bundled-provider.ts");
	try {
		await mkdir(workspace, { recursive: true });
		await mkdir(installedExtensionDir, { recursive: true });
		await writeFile(
			join(installedExtensionDir, "index.ts"),
			draftProviderExtensionSource("installed-provider", "installed-model"),
			"utf8",
		);
		await writeFile(
			bundledExtensionPath,
			draftProviderExtensionSource("bundled-provider", "bundled-model"),
			"utf8",
		);

		const harness = createTestAdapter({ agentDir, toolsSuiteExtensionPath: bundledExtensionPath });
		const draft = await connect(harness.adapter, (cx) =>
			cx.request(PIX_DRAFT_CONFIG_METHOD, { cwd: workspace })) as DesktopDraftConfigResponse;
		assert.match(JSON.stringify(draft.configOptions), /installed-provider\/installed-model/u);
		assert.doesNotMatch(JSON.stringify(draft.configOptions), /bundled-provider\/bundled-model/u);

		await connect(harness.adapter, (cx) => cx.buildSession(workspace).start());
		assert.equal(harness.options[0]?.args?.includes(bundledExtensionPath) ?? false, false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
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

test("pix/git/assist runs independently without creating or loading a session", async () => {
	let observed: { cwd: string; kind: string; diff: string } | undefined;
	const harness = createTestAdapter({
		gitAssistant: async ({ cwd, kind, diff }) => {
			observed = { cwd, kind, diff };
			return "No significant findings.";
		},
	});

	await connect(harness.adapter, async (cx) => {
		const review = await cx.request(PIX_GIT_ASSIST_METHOD, {
			cwd: "/tmp/git-review-project",
			kind: "review",
			diff: "diff --git a/a.ts b/a.ts\n+const ready = true;",
		});
		assert.deepEqual(review, { text: "No significant findings." });
		assert.deepEqual(observed, {
			cwd: "/tmp/git-review-project",
			kind: "review",
			diff: "diff --git a/a.ts b/a.ts\n+const ready = true;",
		});
		assert.equal(harness.adapter.sessionCount, 0);
		assert.deepEqual(harness.clients, []);
	});
});

test("pix/git/assist exposes backend failures instead of masking them as Internal error", async () => {
	const harness = createTestAdapter({
		gitAssistant: async () => {
			throw new Error("review backend unavailable");
		},
	});

	await connect(harness.adapter, async (cx) => {
		await assert.rejects(
			cx.request(PIX_GIT_ASSIST_METHOD, {
				cwd: "/tmp/git-review-project",
				kind: "review",
				diff: "diff --git a/a.ts b/a.ts\n+const ready = true;",
			}),
			/Git assistant failed: review backend unavailable/,
		);
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
					parentSessionPath: firstPath,
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
	assert.deepEqual(listed.sessions[0]?._meta, {
		"pix.isFork": true,
		"pix.parentSessionId": "existing-acp-id",
	});
	assert.equal(listed.sessions[1]?._meta, undefined);
	assert.equal(listed.sessions[1]?.title, "Native title");
	assert.deepEqual(listed._meta?.["pix.tabs"], {
		sessionIds: ["native-b", "existing-acp-id"],
		activeSessionId: "existing-acp-id",
	});

	assert.equal((await map.get("existing-acp-id"))?.piSessionId, "native-a");
	assert.equal((await map.get("native-b"))?.piSessionPath, secondPath);
	assert.equal((await map.get("native-b"))?.parentSessionPath, firstPath);
	await connect(harness.adapter, (cx) => cx.request("session/load", {
		sessionId: "native-b",
		cwd: "/tmp/proj",
		mcpServers: [],
	}));
	assert.deepEqual(harness.clients[harness.clients.length - 1]?.switchSessions, [secondPath]);
});

test("native discovery records actual session names but excludes first-prompt fallback from embedding provenance", async () => {
	const privatePrompt = "PRIVATE first user request — no embedding";
	let sessions = [
		nativeSession("named", { name: "Concise project design", firstMessage: privatePrompt }),
		nativeSession("fallback", { name: privatePrompt, firstMessage: privatePrompt }),
		nativeSession("truncated", { name: "PRIVATE first user...", firstMessage: privatePrompt }),
		nativeSession("unnamed", { name: undefined, firstMessage: "Another confidential first message" }),
	];
	const harness = createTestAdapter({ listPiSessions: async () => sessions });
	const map = new SessionMapStore(harness.sessionMapPath, TEST_LOGGER);
	await connect(harness.adapter, cx => cx.request("session/list", { cwd: "/tmp/proj" }));
	assert.equal((await map.get("named"))?.namedTitle, "Concise project design");
	assert.equal((await map.get("fallback"))?.title, privatePrompt, "fallback still supports local lexical lookup");
	assert.equal((await map.get("fallback"))?.namedTitle, undefined, "fallback is not eligible for embeddings");
	assert.equal((await map.get("truncated"))?.namedTitle, undefined, "truncated first-message fallback is not eligible either");
	assert.equal((await map.get("unnamed"))?.namedTitle, undefined);

	sessions = [
		nativeSession("named", { name: "New saved name", firstMessage: privatePrompt }),
		nativeSession("fallback", { name: "Renamed explicitly", firstMessage: privatePrompt }),
	];
	await connect(harness.adapter, cx => cx.request("session/list", { cwd: "/tmp/proj" }));
	assert.equal((await map.get("named"))?.namedTitle, "New saved name");
	assert.equal((await map.get("fallback"))?.namedTitle, "Renamed explicitly");
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

test("Pix Desktop session/list returns its persisted map without awaiting a slow native scan", async (t) => {
  const root = resolve(".pi/artifacts/session-list-fast");
  await mkdir(root, { recursive: true });
  const cwd = mkdtempSync(join(root, "test-"));
  const path = join(cwd, "new-session.jsonl");
  await writeFile(path, '{"type":"session"}\n');
  let started!: () => void;
  const scanning = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let scans = 0;
  const harness = createTestAdapter({
    listPiSessions: async (requested, signal) => {
      assert.equal(requested, cwd);
      scans += 1;
      started();
      await waiting;
      signal?.throwIfAborted();
      return [nativeSession("fresh-native", { cwd, path, name: "Discovered conversation" })];
    },
    nativeSessionRevision: async () => "stable-revision",
    loadTuiTabs: async () => ({ sessionPaths: [] }),
  });
  t.after(async () => {
    release();
    await harness.adapter.dispose();
    await rm(cwd, { recursive: true, force: true });
  });
  const store = new SessionMapStore(harness.sessionMapPath, TEST_LOGGER);
  await store.put({
    sessionId: "stored-id", piSessionId: "stored-native", piSessionPath: path,
    cwd, title: "Saved conversation", updatedAt: "2025-01-01T00:00:00.000Z",
  });
  let completed!: () => void;
  const notified = new Promise<void>(resolve => { completed = resolve; });
  const events: string[] = [];
  await connectAs(harness.adapter, "pix-desktop", async cx => {
    await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "pix-desktop", version: "test" } });
    const initial = await Promise.race([
      cx.request("session/list", { cwd }) as Promise<{ sessions: Array<{ sessionId: string }> }>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("session/list waited for the native scan")), 1_000)),
    ]);
    assert.deepEqual(initial.sessions.map(s => s.sessionId), ["stored-id"]);
    await scanning;
    assert.deepEqual(events, [], "native scan has not finished");
    release();
    await notified;
    assert.deepEqual(events, [cwd]);
    const updated = await cx.request("session/list", { cwd }) as { sessions: Array<{ sessionId: string; title?: string }> };
    assert.deepEqual(updated.sessions.map(s => s.sessionId), ["stored-id"]);
    assert.equal(updated.sessions[0]?.title, "Discovered conversation");
    assert.equal(scans, 1, "a matching filesystem revision must not start another full scan");
  }, app => {
    const custom = app as unknown as {
      onNotification(
        method: string,
        parser: (params: unknown) => { cwd: string },
        handler: (context: { params: { cwd: string } }) => void,
      ): void;
    };
    custom.onNotification(PIX_SESSION_CATALOG_CHANGED_METHOD,
      params => params as { cwd: string },
      ({ params }) => { events.push(params.cwd); completed(); });
  });
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

test("Pix Desktop pause stops at the turn boundary and exposes a paused continuation", async () => {
	const { adapter, clients } = createTestAdapter();
	const states: DesktopAgentControlResponse[] = [];
	await connect(
		adapter,
		async (cx) => {
			const session = await cx.buildSession("/tmp/pause-control").start();
			const pi = clients[0]!;
			const pending = session.prompt("keep working");
			await waitFor(() => pi.promptCalls.length === 1);
			pi.emit({ type: "agent_start" });

			const pause = await cx.request(PIX_AGENT_CONTROL_METHOD, {
				sessionId: session.sessionId,
				action: "pause",
			}) as DesktopAgentControlResponse;
			assert.equal(pause.state, "pause-requested");
			assert.equal(pi.pauses, 1);

			FakePiClient.sessionFiles.set(pi.state.sessionFile!, [
				{ role: "user", content: "keep working" },
				{ role: "toolResult", content: [] },
			]);
			pi.emit({
				type: "agent_end",
				messages: [{ role: "assistant", content: [], stopReason: "stop" }],
				willRetry: false,
			} as unknown as JsonAgentSessionEvent);
			pi.emit({ type: "agent_settled" });
			await pending;

			await waitFor(() => states.some((state) => state.state === "paused"));
			const current = await cx.request(PIX_AGENT_CONTROL_METHOD, {
				sessionId: session.sessionId,
				action: "state",
			}) as DesktopAgentControlResponse;
			assert.equal(current.state, "paused");
		},
		(app) => {
			const customNotifications = app as unknown as {
				onNotification(
					method: string,
					parser: (params: unknown) => { sessionId: string; channel: string; data: unknown },
					handler: (ctx: { params: { sessionId: string; channel: string; data: unknown } }) => void,
				): void;
			};
			customNotifications.onNotification(
				PIX_SESSION_STATE_METHOD,
				(params) => params as { sessionId: string; channel: string; data: unknown },
				(ctx) => {
					if (ctx.params.channel !== "agent-control") return;
					const data = ctx.params.data as { state?: DesktopAgentControlResponse["state"] };
					if (data.state) states.push({ sessionId: ctx.params.sessionId, state: data.state });
				},
			);
		},
	);

	assert.deepEqual(states.map((state) => state.state), ["pause-requested", "paused"]);
});

test("wait commands preserve paused state and do not replace an active run", async () => {
	const pi = new FakePiClient();
	pi.commands.push({ name: "wait", source: "extension", sourceInfo: {}, description: "Schedule continuation" });
	pi.promptHandledWithoutRun = true;
	const options: PiRpcClientOptions[] = [];
	const { adapter } = createTestAdapter({ quotaWaitExtensionPath: "/test/quota-wait.js",
		createPiClient: (opts) => { options.push(opts); return pi; } });
	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/wait-control").start();
		const runtime = adapter.getSession(session.sessionId)!;
		await waitFor(() => runtime.runtimeExtensionCommands.has("wait"));
		runtime.agentControlState = "paused";
		pi.promptHandledWithoutRun = true;
		await session.prompt("/wait 1h20m");
		assert.equal(runtime.agentControlState, "paused");
		assert.equal(runtime.activeRun, undefined);
		pi.promptHandledWithoutRun = false;
		const pending = session.prompt("work");
		await waitFor(() => pi.promptCalls.some((call) => call.message === "work"));
		pi.emit({ type: "agent_start" });
		const run = runtime.activeRun;
		assert.ok(run);
		await session.prompt("/wait usage-reset");
		assert.equal(runtime.activeRun, run);
		pi.emit({ type: "agent_settled" });
		await pending;
	});
	assert.ok(options[0]?.args?.includes("/test/quota-wait.js"));
});

test("heads-up commands stay out-of-band while parent is idle, paused or running", async () => {
	const pi = new FakePiClient();
	pi.commands.push({ name: "heads-up", source: "extension", sourceInfo: {}, description: "Passive observer" });
	pi.promptHandledWithoutRun = true;
	const options: PiRpcClientOptions[] = [];
	const { adapter } = createTestAdapter({ headsUpExtensionPath: "/test/heads-up.js",
		createPiClient: (opts) => { options.push(opts); return pi; } });
	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/observer-control").start();
		const runtime = adapter.getSession(session.sessionId)!;
		await waitFor(() => runtime.runtimeExtensionCommands.has("heads-up"));
		await session.prompt("/heads-up on");
		assert.equal(runtime.activeRun, undefined);
		runtime.agentControlState = "paused";
		await session.prompt("/heads-up check");
		assert.equal(runtime.agentControlState, "paused");
		await session.prompt("/heads-up snapshot");
		assert.equal(runtime.agentControlState, "paused");
		assert.equal(runtime.activeRun, undefined);
		pi.promptHandledWithoutRun = false;
		const pending = session.prompt("work");
		await waitFor(() => pi.promptCalls.some((call) => call.message === "work"));
		pi.emit({ type: "agent_start" });
		const run = runtime.activeRun;
		assert.ok(run);
		await session.prompt("/heads-up off");
		assert.equal(runtime.activeRun, run);
		await session.prompt("/heads-up snapshot");
		assert.equal(runtime.activeRun, run);
		pi.emit({ type: "agent_settled" });
		await pending;
	});
	assert.ok(options[0]?.args?.includes("/test/heads-up.js"));
});

test("BTW controls and progress do not enter the parent run, queue or transcript; teardown resets memory", async () => {
	const pi = new FakePiClient();
	const calls: BtwCommand[] = [];
	const states: Array<{ sessionId: string; channel: string; data: { phase: string; runtimeId: string; text: string } }> = [];
	const updates: SessionNotification[] = [];
	const state: BtwState = { runtimeId: "btw-runtime", contextKey: "context", busyRequestId: null };
	const { adapter } = createTestAdapter({ createPiClient: () => Object.assign(pi, { btw: async (command: BtwCommand) => { calls.push(command); return state; } }) });
	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/btw-control").start();
		const runtime = adapter.getSession(session.sessionId)!;
		runtime.agentControlState = "paused";
		assert.deepEqual(await cx.request(BTW_METHOD, { sessionId: session.sessionId, action: "state" }), state);
		assert.equal(runtime.agentControlState, "paused");
		const parent = session.prompt("parent work");
		await waitFor(() => pi.promptCalls.length === 1);
		pi.emit({ type: "agent_start" });
		const activeRun = runtime.activeRun;
		await cx.request(BTW_METHOD, { sessionId: session.sessionId, action: "ask", runtimeId: state.runtimeId, requestId: "q", question: "SIDE_ONLY", history: [], excerpts: [] });
		pi.emit({ type: "pix_btw_event", data: { version: 1, runtimeId: state.runtimeId, requestId: "q", phase: "done", sequence: 1, text: "SIDE_ANSWER", busyRequestId: null } });
		await waitFor(() => states.some((event) => event.channel === "btw"));
		assert.equal(runtime.activeRun, activeRun);
		assert.equal(runtime.builtinRunning, false);
		assert.equal(pi.aborts, 0); assert.equal(pi.continues, 0);
		assert.deepEqual(pi.promptCalls.map((call) => call.message), ["parent work"]);
		assert.deepEqual(pi.steerCalls, []); assert.deepEqual(pi.followUpCalls, []);
		assert.doesNotMatch(JSON.stringify(updates), /SIDE_ONLY|SIDE_ANSWER/);
		assert.equal(runtime.activitySnapshots.has("btw"), false);
		await assert.rejects(cx.request(BTW_METHOD, { sessionId: session.sessionId, action: "ask", question: "bad payload" }));
		assert.equal(calls.length, 2);
		pi.emit({ type: "agent_settled" }); await parent;
		await cx.request("session/close", { sessionId: session.sessionId });
		await waitFor(() => states.some((event) => event.channel === "btw" && event.data.phase === "reset"));
	}, (app) => {
		app.onNotification("session/update", (ctx) => { updates.push(ctx.params); });
		(app as unknown as { onNotification(method: string, parser: (data: unknown) => typeof states[number], callback: (ctx: { params: typeof states[number] }) => void): void })
			.onNotification(PIX_SESSION_STATE_METHOD, (data) => data as typeof states[number], (ctx) => { states.push(ctx.params); });
	});
});

const preparedDcpMapFixture = { revision: 1, sessionEpoch: 0, generatedAt: 100,
	tokenEstimates: { candidate: 1000, protected: 0, compressed: 100, retained: 2000 } };

test("Pix Desktop runtime status exposes pi context usage without refreshing model quota", async () => {
	const { adapter, clients } = createTestAdapter();
	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/runtime-status").start();
		const pi = clients[0]!;
		Object.assign(pi.sessionStats, {
			contextUsage: { tokens: 128_000, contextWindow: 200_000, percent: 64 },
			pixDcpTokensSaved: 12_345,
			pixDcpContextMap: preparedDcpMapFixture,
		});

		const response = await cx.request(PIX_RUNTIME_STATUS_METHOD, {
			sessionId: session.sessionId,
			refreshModelUsage: false,
		}) as DesktopRuntimeStatusResponse;

		assert.equal(response.sessionId, session.sessionId);
		assert.deepEqual(response.context, { tokens: 128_000, contextWindow: 200_000, percent: 64 });
		assert.equal(response.dcpTokensSaved, 12_345);
		assert.deepEqual(response.dcpContextMap, preparedDcpMapFixture);
		assert.equal(response.modelUsageRefresh, "skipped");
		assert.equal(response.modelUsage, undefined);
		assert.equal(pi.getEntriesCalls, 0, "periodic runtime status must not read the full session entries");
	});
});

test("Pix Desktop pushes context usage on message and compaction boundaries without polling stream deltas", async () => {
	type ContextNotification = { sessionId: string; channel: string; data: unknown };
	const notifications: ContextNotification[] = [];
	const savingsNotifications: ContextNotification[] = [];
	const mapNotifications: ContextNotification[] = [];
	const { adapter, clients } = createTestAdapter();

	await connect(
		adapter,
		async (cx) => {
			const session = await cx.buildSession("/tmp/runtime-context-push").start();
			const pi = clients[0]!;

			pi.emit({
				type: "message_update",
				usage: {
					input: 100,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 110,
					cost: { input: 0, output: 0, total: 0 },
				},
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "streaming" },
			} as PiEvent);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(pi.getSessionStatsCalls, 0, "streaming deltas must not poll context stats");
			assert.equal(notifications.length, 0);

			Object.assign(pi.sessionStats, {
				contextUsage: { tokens: 128_000, contextWindow: 200_000, percent: 64 },
				pixDcpTokensSaved: 12_345,
				pixDcpContextMap: preparedDcpMapFixture,
			});
			pi.emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
					usage: {
						input: 100_000,
						output: 28_000,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 128_000,
						cost: { input: 0, output: 0, total: 0 },
					},
				},
			} as PiEvent);
			await waitFor(() => notifications.length === 1);
			await waitFor(() => savingsNotifications.length === 1);
			await waitFor(() => mapNotifications.length === 1);
			assert.deepEqual(mapNotifications[0]?.data, preparedDcpMapFixture);
			// Context and model-usage pushes each read the session snapshot once.
			assert.equal(pi.getSessionStatsCalls, 2);
			assert.deepEqual(notifications[0], {
				sessionId: session.sessionId,
				channel: PIX_CONTEXT_USAGE_CHANNEL,
				data: { tokens: 128_000, contextWindow: 200_000, percent: 64 },
			});
			assert.deepEqual(savingsNotifications[0], {
				sessionId: session.sessionId,
				channel: PIX_DCP_TOKENS_SAVED_CHANNEL,
				data: 12_345,
			});

			Object.assign(pi.sessionStats, {
				contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
				pixDcpTokensSaved: 18_000,
				pixDcpContextMap: undefined,
			});
			pi.emit({
				type: "compaction_end",
				reason: "manual",
				result: { summary: "compact", tokensBefore: 128_000, estimatedTokensAfter: 20_000 },
				aborted: false,
				willRetry: false,
			} as PiEvent);
			await waitFor(() => notifications.length === 2);
			await waitFor(() => savingsNotifications.length === 2);
			await waitFor(() => mapNotifications.length === 2);
			assert.equal(mapNotifications[1]?.data, null, "unavailable after compaction explicitly clears the old map");
			// Compaction only refreshes the context snapshot (no header record).
			assert.equal(pi.getSessionStatsCalls, 3);
			assert.deepEqual(notifications[1], {
				sessionId: session.sessionId,
				channel: PIX_CONTEXT_USAGE_CHANNEL,
				data: { tokens: null, contextWindow: 200_000, percent: null },
			});
			assert.equal(savingsNotifications[1]?.data, 18_000);

			pi.promptHandledWithoutRun = true;
			Object.assign(pi.sessionStats, {
				contextUsage: { tokens: 40_000, contextWindow: 200_000, percent: 20 },
				pixDcpTokensSaved: 24_000,
			});
			await cx.request("session/prompt", {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "/dcp sweep" }],
			});
			await waitFor(() => notifications.length === 3);
			await waitFor(() => savingsNotifications.length === 3);
			assert.equal(pi.getSessionStatsCalls, 4, "extension-handled slash commands get one boundary snapshot");
			assert.deepEqual(notifications[2], {
				sessionId: session.sessionId,
				channel: PIX_CONTEXT_USAGE_CHANNEL,
				data: { tokens: 40_000, contextWindow: 200_000, percent: 20 },
			});
			assert.equal(savingsNotifications[2]?.data, 24_000);
		},
		(app) => {
			const customNotifications = app as unknown as {
				onNotification(
					method: string,
					parser: (params: unknown) => ContextNotification,
					handler: (ctx: { params: ContextNotification }) => void,
				): void;
			};
			customNotifications.onNotification(
				PIX_SESSION_STATE_METHOD,
				(params) => params as ContextNotification,
				(ctx) => {
					if (ctx.params.channel === PIX_CONTEXT_USAGE_CHANNEL) notifications.push(ctx.params);
					if (ctx.params.channel === PIX_DCP_TOKENS_SAVED_CHANNEL) savingsNotifications.push(ctx.params);
					if (ctx.params.channel === PIX_DCP_CONTEXT_MAP_CHANNEL) mapNotifications.push(ctx.params);
				},
			);
		},
	);
});

test("Pix Desktop loads DCP statistics only through the on-demand DCP request", async () => {
	const { adapter, clients } = createTestAdapter();
	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/runtime-dcp-stats").start();
		const pi = clients[0]!;
		Object.assign(pi.sessionStats, {
			contextUsage: { tokens: 10_000, contextWindow: 200_000, percent: 5 },
		});

		const response = await cx.request(PIX_DCP_STATS_METHOD, {
			sessionId: session.sessionId,
		}) as DesktopDcpStatsResponse;

		assert.equal(response.sessionId, session.sessionId);
		assert.match(response.dcpStats ?? "", /DCP Session Statistics:/u);
		assert.equal(pi.getEntriesCalls, 1);
	});
});

test("Pix Desktop loads whole-session spend on demand without provider quota I/O", async () => {
	let quotaQueries = 0;
	const { adapter, clients } = createTestAdapter({
		queryModelUsage: async () => {
			quotaQueries += 1;
			return { refresh: "unavailable" };
		},
	});
	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/runtime-session-usage").start();
		const pi = clients[0]!;
		pi.entriesState = {
			leafId: "agent-usage",
			entries: [
				{
					type: "message", id: "assistant", parentId: null, timestamp: new Date().toISOString(),
					message: {
						role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol",
						content: [], stopReason: "stop", timestamp: Date.now(),
						usage: {
							input: 100, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 150,
							cost: { input: 0.01, output: 0.02, cacheRead: 0.003, cacheWrite: 0, total: 0.033 },
						},
					},
				},
				{
					type: "usage", id: "agent-usage", parentId: "assistant", timestamp: new Date().toISOString(),
					kind: "async-subagent", provider: "anthropic", model: "claude-sonnet",
					usage: {
						input: 200, output: 40, cacheRead: 10, cacheWrite: 0, totalTokens: 250,
						cost: { input: 0.02, output: 0.04, cacheRead: 0.005, cacheWrite: 0, total: 0.065 },
					},
				},
			],
		};

		const response = await cx.request(PIX_SESSION_USAGE_METHOD, {
			sessionId: session.sessionId,
		}) as DesktopSessionUsageResponse;

		assert.equal(response.sessionId, session.sessionId);
		assert.equal(response.usage.totals.totalTokens, 400);
		assert.ok(Math.abs(response.usage.totals.cost - 0.098) < 1e-9);
		assert.equal(response.usage.providers[0]?.provider, "anthropic");
		assert.equal(response.usage.providers[0]?.models[0]?.model, "claude-sonnet");
		assert.equal(response.usage.providers[0]?.models[0]?.totals.totalTokens, 250);
		assert.equal(response.usage.providers[1]?.provider, "openai-codex");
		assert.equal(response.usage.providers[1]?.models[0]?.model, "gpt-5.6-sol");
		assert.equal(response.usage.providers[1]?.models[0]?.totals.totalTokens, 150);
		assert.equal(pi.getEntriesCalls, 1);
		assert.equal(quotaQueries, 0);
	});
});

test("Pix Desktop requests survive deeply chained sessions without nested tree reads", async () => {
	const { adapter, clients } = createTestAdapter();
	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/runtime-deep-chain").start();
		const pi = clients[0]!;

		// Mirrors a real long-lived linear session (~5.6k entries) where the
		// SDK's nested get_tree response blows V8's stack during serialization.
		// The flat entries path must keep serving desktop statistics requests.
		const depth = 6_000;
		const entries: PiSessionEntry[] = [];
		for (let i = 0; i < depth; i += 1) {
			entries.push({
				type: "message",
				id: `entry-${i}`,
				parentId: i === 0 ? null : `entry-${i - 1}`,
				timestamp: new Date().toISOString(),
				message: {
					role: i % 2 === 0 ? "user" : "assistant",
					content: i % 2 === 0 ? `message ${i}` : [],
					...(i % 2 === 1
						? {
							usage: {
								input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						}
						: {}),
				},
			} as PiSessionEntry);
		}
		pi.entriesState = { entries, leafId: `entry-${depth - 1}` };

		const usageResponse = await cx.request(PIX_SESSION_USAGE_METHOD, {
			sessionId: session.sessionId,
		}) as DesktopSessionUsageResponse;
		assert.equal(usageResponse.sessionId, session.sessionId);
		// Half of the depth entries carry usage records of 2 tokens each.
		assert.equal(usageResponse.usage.totals.totalTokens, depth);

		const dcpResponse = await cx.request(PIX_DCP_STATS_METHOD, {
			sessionId: session.sessionId,
		}) as DesktopDcpStatsResponse;
		assert.equal(dcpResponse.sessionId, session.sessionId);

		const branchResponse = await cx.request("pix/session/branch_user_messages", {
			sessionId: session.sessionId,
		}) as { messages: Array<{ entryId: string }> };
		assert.equal(branchResponse.messages.length, depth / 2);
		assert.equal(branchResponse.messages.at(-1)?.entryId, `entry-${depth - 2}`);

		assert.equal(pi.getEntriesCalls, 3);
	});
});

test("Pix Desktop deduplicates concurrent quota refreshes for one session model route", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let queryCalls = 0;
	const { adapter } = createTestAdapter({
		queryModelUsage: async (state) => {
			queryCalls += 1;
			await gate;
			return {
				refresh: "ready",
				status: {
					modelKey: `${state.model?.provider ?? "unknown"}/${state.model?.id ?? "unknown"}`,
					provider: "openai",
					updatedAt: Date.now(),
					hourly: { remainingPercent: 75, resetAt: Date.now() + 60_000, windowSeconds: 3_600 },
				},
			};
		},
	});

	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/runtime-quota-single-flight").start();
		const first = cx.request(PIX_RUNTIME_STATUS_METHOD, { sessionId: session.sessionId, refreshModelUsage: true });
		const second = cx.request(PIX_RUNTIME_STATUS_METHOD, { sessionId: session.sessionId, refreshModelUsage: true });

		await waitFor(() => queryCalls === 1);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(queryCalls, 1);
		release();
		const [firstResult, secondResult] = await Promise.all([first, second]) as DesktopRuntimeStatusResponse[];

		assert.equal(queryCalls, 1);
		assert.equal(firstResult.modelUsageRefresh, "ready");
		assert.equal(secondResult.modelUsageRefresh, "ready");
		assert.equal(firstResult.modelUsage?.hourly?.remainingPercent, 75);
		assert.equal(secondResult.modelUsage?.hourly?.remainingPercent, 75);
	});
});

type HeaderUsageNotification = { sessionId: string; channel: string; data: unknown };

test("Pix Desktop flags credential-pending Claude Code quota unavailability for faster local-only retries", async () => {
	const results: Array<{ refresh: "unavailable"; credentialPending?: true }> = [
		{ refresh: "unavailable", credentialPending: true },
		{ refresh: "unavailable" },
	];
	let index = 0;
	const { adapter } = createTestAdapter({
		queryModelUsage: async () => results[Math.min(index, results.length - 1)]!,
	});

	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/runtime-quota-credential-pending").start();
		const first = await cx.request(PIX_RUNTIME_STATUS_METHOD, {
			sessionId: session.sessionId,
			refreshModelUsage: true,
		}) as DesktopRuntimeStatusResponse;
		assert.equal(first.modelUsageRefresh, "unavailable");
		assert.equal(first.modelUsageCredentialPending, true);
		index += 1;

		// Once a credential exists (or another provider is unavailable), the
		// flag is absent so clients keep the regular refresh cadence.
		const second = await cx.request(PIX_RUNTIME_STATUS_METHOD, {
			sessionId: session.sessionId,
			refreshModelUsage: true,
		}) as DesktopRuntimeStatusResponse;
		assert.equal(second.modelUsageRefresh, "unavailable");
		assert.equal(second.modelUsageCredentialPending, undefined);
	});
});

test("manual Claude limits discard a route switched while the CLI runs", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let nudges = 0;
	let quotaQueries = 0;
	const { adapter, clients } = createTestAdapter({
		claudeCodeLoginNudge: async () => { nudges += 1; await gate; return true; },
		queryModelUsage: async () => { quotaQueries += 1; return { refresh: "unavailable" }; },
	});
	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/runtime-claude-manual-switch").start();
		await clients[0]!.setModel("pi-claude-code-provider", "claude-opus");
		const first = cx.request(PIX_CLAUDE_QUOTA_REFRESH_METHOD, { sessionId: session.sessionId });
		await waitFor(() => nudges === 1);
		await clients[0]!.setModel("anthropic", "claude-4");
		release();
		await assert.rejects(first, /claude quota refresh requires an active pi-claude-code-provider model/);
		assert.equal(nudges, 1);
		assert.equal(quotaQueries, 0, "route switch must not query or expose the previous route's limits");
	});
});

function anthropicHeaderRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		modelKey: "anthropic/claude-4",
		status: 200,
		headers: {
			"anthropic-ratelimit-requests-limit": "1000",
			"anthropic-ratelimit-requests-remaining": "400",
			"anthropic-ratelimit-requests-reset": "30s",
		},
		receivedAt: Date.parse("2025-07-01T12:00:00.000Z"),
		...overrides,
	};
}

/** Deterministic shared-module stand-in: derives one window from the record. */
function headerUsageFromRecord(record: { modelKey: string; headers: Record<string, string>; receivedAt: number }) {
	const limit = Number(record.headers["anthropic-ratelimit-requests-limit"] ?? "0");
	const remaining = Number(record.headers["anthropic-ratelimit-requests-remaining"] ?? "0");
	return {
		modelKey: record.modelKey,
		provider: "anthropic" as const,
		updatedAt: record.receivedAt,
		rateWindows: [{
			remainingPercent: limit > 0 ? Math.round((remaining / limit) * 100) : 0,
			resetAt: record.receivedAt + 30_000,
			windowSeconds: 60,
			hasKnownWindowDuration: true,
			label: "RPM",
		}],
	};
}

function registerHeaderUsageSink(notifications: HeaderUsageNotification[]) {
	return (app: ReturnType<typeof client>) => {
		const customNotifications = app as unknown as {
			onNotification(
				method: string,
				parser: (params: unknown) => HeaderUsageNotification,
				handler: (ctx: { params: HeaderUsageNotification }) => void,
			): void;
		};
		customNotifications.onNotification(
			PIX_SESSION_STATE_METHOD,
			(params) => params as HeaderUsageNotification,
			(ctx) => {
				if (ctx.params.channel === PIX_MODEL_USAGE_CHANNEL) notifications.push(ctx.params);
			},
		);
	};
}

test("Pix Desktop pushes Anthropic API-key header usage immediately without quota I/O", async () => {
	const notifications: HeaderUsageNotification[] = [];
	let quotaQueries = 0;
	const { adapter, clients } = createTestAdapter({
		queryModelUsage: async () => {
			quotaQueries += 1;
			return { refresh: "unavailable" };
		},
		parseAnthropicUsageHeaders: async (record) => headerUsageFromRecord(record),
	});

	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/runtime-header-usage").start();
		const pi = clients[0]!;

		// A response boundary without a recorded header snapshot pushes nothing.
		pi.emit({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		} as PiEvent);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(notifications.length, 0, "no record means no usage push");

		Object.assign(pi.sessionStats, {
			pixAnthropicUsage: anthropicHeaderRecord({
				headers: {
					"anthropic-ratelimit-requests-limit": "1000",
					"anthropic-ratelimit-requests-remaining": "400",
					"x-api-key": "sk-ant-api03-SECRET",
					"authorization": "Bearer SECRET",
				},
			}),
		});
		pi.emit({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
		} as PiEvent);
		await waitFor(() => notifications.length === 1);

		assert.deepEqual(notifications[0], {
			sessionId: session.sessionId,
			channel: PIX_MODEL_USAGE_CHANNEL,
			data: headerUsageFromRecord({
				modelKey: "anthropic/claude-4",
				headers: {
					"anthropic-ratelimit-requests-limit": "1000",
					"anthropic-ratelimit-requests-remaining": "400",
				},
				receivedAt: Date.parse("2025-07-01T12:00:00.000Z"),
			}),
		});
		// Security: the pushed payload carries parsed usage only — raw response
		// headers (and any credentials inside them) never cross the wire.
		const pushed = notifications[0]!.data as Record<string, unknown>;
		assert.equal("headers" in pushed, false);
		assert.equal(JSON.stringify(pushed).includes("SECRET"), false);

		const response = await cx.request(PIX_RUNTIME_STATUS_METHOD, {
			sessionId: session.sessionId,
			refreshModelUsage: false,
		}) as DesktopRuntimeStatusResponse;
		assert.deepEqual(response.headerUsage, notifications[0]!.data);
		assert.equal(response.modelUsageRefresh, "skipped");
		assert.equal(quotaQueries, 0, "header usage must not hit a provider quota endpoint");
	}, registerHeaderUsageSink(notifications));
});

test("Pix Desktop clears pushed header usage when the session model changes", async () => {
	const notifications: HeaderUsageNotification[] = [];
	const { adapter, clients } = createTestAdapter({
		parseAnthropicUsageHeaders: async (record) => headerUsageFromRecord(record),
	});

	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/runtime-header-usage-model-switch").start();
		const pi = clients[0]!;
		Object.assign(pi.sessionStats, { pixAnthropicUsage: anthropicHeaderRecord() });

		pi.emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } } as PiEvent);
		await waitFor(() => notifications.length === 1);

		// Switching models must not keep serving the previous model's snapshot.
		await pi.setModel("anthropic", "claude-3");
		pi.emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } } as PiEvent);
		await waitFor(() => notifications.length === 2);
		assert.deepEqual(notifications[1], {
			sessionId: session.sessionId,
			channel: PIX_MODEL_USAGE_CHANNEL,
			data: null,
		});

		// And a later snapshot request exposes no header usage for the new model.
		const response = await cx.request(PIX_RUNTIME_STATUS_METHOD, {
			sessionId: session.sessionId,
			refreshModelUsage: false,
		}) as DesktopRuntimeStatusResponse;
		assert.equal(response.headerUsage, undefined);
	}, registerHeaderUsageSink(notifications));
});

test("Pix Desktop isolates concurrent sessions' header usage", async () => {
	const notifications: HeaderUsageNotification[] = [];
	const { adapter, clients } = createTestAdapter({
		parseAnthropicUsageHeaders: async (record) => headerUsageFromRecord(record),
	});

	await connect(adapter, async (cx) => {
		const first = await cx.buildSession("/tmp/runtime-header-usage-a").start();
		const second = await cx.buildSession("/tmp/runtime-header-usage-b").start();
		const piA = clients[0]!;
		const piB = clients[1]!;
		assert.notEqual(first.sessionId, second.sessionId);

		Object.assign(piA.sessionStats, {
			pixAnthropicUsage: anthropicHeaderRecord({
				headers: {
					"anthropic-ratelimit-requests-limit": "1000",
					"anthropic-ratelimit-requests-remaining": "100",
				},
			}),
		});
		Object.assign(piB.sessionStats, {
			pixAnthropicUsage: anthropicHeaderRecord({
				headers: {
					"anthropic-ratelimit-requests-limit": "1000",
					"anthropic-ratelimit-requests-remaining": "900",
				},
			}),
		});

		piA.emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } } as PiEvent);
		piB.emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } } as PiEvent);
		await waitFor(() => notifications.length === 2);

		// Each push carries its own session id and its own session's observed
		// usage; neither session ever sees the other's snapshot.
		const bySession = new Map(notifications.map((n) => [n.sessionId, n]));
		assert.equal(bySession.size, 2);
		const aUsage = bySession.get(first.sessionId)?.data as { rateWindows?: Array<{ remainingPercent: number }> };
		const bUsage = bySession.get(second.sessionId)?.data as { rateWindows?: Array<{ remainingPercent: number }> };
		assert.equal(aUsage?.rateWindows?.[0]?.remainingPercent, 10);
		assert.equal(bUsage?.rateWindows?.[0]?.remainingPercent, 90);
	}, registerHeaderUsageSink(notifications));
});

test("Pix Desktop drops header-usage pushes after the session is closed", async () => {
	const notifications: HeaderUsageNotification[] = [];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const { adapter, clients } = createTestAdapter({
		parseAnthropicUsageHeaders: async (record) => {
			await gate;
			return headerUsageFromRecord(record);
		},
	});

	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/runtime-header-usage-teardown").start();
		const pi = clients[0]!;
		Object.assign(pi.sessionStats, { pixAnthropicUsage: anthropicHeaderRecord() });

		pi.emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } } as PiEvent);
		// Let the push reach the gated parser before tearing the session down.
		await new Promise<void>((resolve) => setImmediate(resolve));
		await cx.request("session/close", { sessionId: session.sessionId });
		release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setImmediate(resolve));

		assert.equal(notifications.length, 0, "closed sessions must not receive usage pushes");
	}, registerHeaderUsageSink(notifications));
});

test("Pix Desktop ignores malformed Anthropic header records without pushing", async () => {
	const notifications: HeaderUsageNotification[] = [];
	const { adapter, clients } = createTestAdapter({
		parseAnthropicUsageHeaders: async (record) => headerUsageFromRecord(record),
	});

	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/runtime-header-usage-invalid").start();
		const pi = clients[0]!;

		const invalid = [
			undefined,
			"nope",
			anthropicHeaderRecord({ modelKey: "claude-4" }),
			anthropicHeaderRecord({ modelKey: "anthropic/claude-4", status: Number.NaN }),
			anthropicHeaderRecord({ receivedAt: 0 }),
			anthropicHeaderRecord({ headers: [] }),
			anthropicHeaderRecord({ headers: { "anthropic-ratelimit-requests-limit": 1000 } }),
			anthropicHeaderRecord({ headers: {} }),
		];
		for (const record of invalid) {
			Object.assign(pi.sessionStats, { pixAnthropicUsage: record });
			pi.emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "stop" } } as PiEvent);
			await new Promise<void>((resolve) => setImmediate(resolve));
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		assert.equal(notifications.length, 0);

		// The runtime-status response equally refuses to echo malformed records.
		Object.assign(pi.sessionStats, { pixAnthropicUsage: anthropicHeaderRecord({ headers: { ok: 1 } }) });
		const response = await cx.request(PIX_RUNTIME_STATUS_METHOD, {
			sessionId: session.sessionId,
			refreshModelUsage: false,
		}) as DesktopRuntimeStatusResponse;
		assert.equal(response.headerUsage, undefined);
	}, registerHeaderUsageSink(notifications));
});

test("Pix Desktop exposes generic resumable stops and continues without a user prompt", async () => {
	const { adapter, clients } = createTestAdapter();
	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/continue-control").start();
		const pi = clients[0]!;
		const pending = session.prompt("use more tools");
		await waitFor(() => pi.promptCalls.length === 1);
		pi.emit({ type: "agent_start" });
		FakePiClient.sessionFiles.set(pi.state.sessionFile!, [
			{ role: "user", content: "use more tools" },
			{ role: "toolResult", content: [] },
		]);
		pi.emit({
			type: "agent_end",
			messages: [{ role: "assistant", content: [], stopReason: "stop" }],
			willRetry: false,
		} as unknown as JsonAgentSessionEvent);
		pi.emit({ type: "agent_settled" });
		await pending;

		const stopped = await cx.request(PIX_AGENT_CONTROL_METHOD, {
			sessionId: session.sessionId,
			action: "state",
		}) as DesktopAgentControlResponse;
		assert.equal(stopped.state, "continuable");

		pi.continueHook = () => {
			pi.emit({ type: "agent_start" });
			FakePiClient.sessionFiles.set(pi.state.sessionFile!, [
				{ role: "user", content: "use more tools" },
				{ role: "assistant", content: [] },
			]);
			pi.emit({
				type: "agent_end",
				messages: [{ role: "assistant", content: [], stopReason: "stop" }],
				willRetry: false,
			} as unknown as JsonAgentSessionEvent);
			pi.emit({ type: "agent_settled" });
		};

		const resumed = await cx.request(PIX_AGENT_CONTROL_METHOD, {
			sessionId: session.sessionId,
			action: "continue",
		}) as DesktopAgentControlResponse;
		assert.equal(resumed.state, "idle");
		assert.equal(resumed.stopReason, "end_turn");
		assert.equal(pi.continues, 1);
		assert.deepEqual(pi.promptCalls, [{ message: "use more tools", images: undefined }]);
	});
});

test("session/prompt fails fast when the pi process dies mid-run", async () => {
	const { adapter, clients } = createTestAdapter();
	const failure = await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp").start();
		const pending = session.prompt("hello");
		const pi = clients[0]!;
		const deferredCaches = adapter as unknown as {
			desktopDeferredToolResults: Map<string, Map<string, unknown>>;
			desktopDeferredImages: Map<string, Map<string, unknown>>;
		};
		deferredCaches.desktopDeferredToolResults.set(session.sessionId, new Map([["tool", {}]]));
		deferredCaches.desktopDeferredImages.set(session.sessionId, new Map([["image", {}]]));
		await waitFor(() => pi.promptCalls.length === 1);
		pi.emit({ type: "agent_start" });
		// No agent_settled will ever arrive; only the exit watch can finish it.
		pi.emitExit(new Error("pi process exited unexpectedly (signal SIGKILL)"));
		assert.equal(pi.eventListenerCount, 0);
		assert.equal(deferredCaches.desktopDeferredToolResults.has(session.sessionId), false);
		assert.equal(deferredCaches.desktopDeferredImages.has(session.sessionId), false);
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

test("a recovered-question extension run publishes pause-ready running state", async () => {
	const { adapter, clients } = createTestAdapter();
	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/recovered-question-pause").start();
		const pi = clients[0]!;
		pi.emit({ type: "agent_start" });
		const owner = adapter.getSession(session.sessionId)!.activeRun;
		const state = await cx.request(PIX_AGENT_CONTROL_METHOD, {
			sessionId: session.sessionId, action: "state",
		}) as DesktopAgentControlResponse;
		assert.equal(state.state, "running", "agent_start must not leave Pause disabled as resuming");

		pi.pauseHook = () => { throw new Error("pause failed"); };
		await assert.rejects(cx.request(PIX_AGENT_CONTROL_METHOD, {
			sessionId: session.sessionId, action: "pause",
		}), /pause failed/);
		assert.equal(adapter.getSession(session.sessionId)!.agentControlState, "running");
		assert.equal(adapter.getSession(session.sessionId)!.activeRun, owner);

		pi.pauseHook = undefined;
		const pause = await cx.request(PIX_AGENT_CONTROL_METHOD, {
			sessionId: session.sessionId, action: "pause",
		}) as DesktopAgentControlResponse;
		assert.equal(pause.state, "pause-requested");
		assert.equal(pi.pauses, 2);
		assert.equal(adapter.getSession(session.sessionId)!.activeRun, owner,
			"requesting Pause must not settle the adopted run early");
		FakePiClient.sessionFiles.set(pi.state.sessionFile!, [{ role: "toolResult", content: [] }]);
		pi.emit({ type: "agent_settled" });
		await waitFor(() => adapter.getSession(session.sessionId)?.activeRun === undefined);
		assert.equal(adapter.getSession(session.sessionId)!.agentControlState, "paused");
	});
});

for (const origin of ["prompt", "extension"] as const) {
	for (const outcome of ["cancel", "boundary", "settled-during-cancel"] as const) {
		test(`${origin} pending pause ${outcome} retains ownership without implicit continuation`, async () => {
			const { adapter, clients } = createTestAdapter();
			await connect(adapter, async (cx) => {
				const session = await cx.buildSession("/tmp/cancel-pending-pause").start();
				const pi = clients[0]!;
				const pending = origin === "prompt" ? session.prompt("work") : undefined;
				if (pending) await waitFor(() => pi.promptCalls.length === 1);
				pi.emit({ type: "agent_start" });
				const owner = adapter.getSession(session.sessionId)!.activeRun;
				const request = (action: "pause" | "cancel-pause") => cx.request(PIX_AGENT_CONTROL_METHOD, {
					sessionId: session.sessionId, action,
				}) as Promise<DesktopAgentControlResponse>;
				await request("pause");
				assert.equal(adapter.getSession(session.sessionId)!.agentControlState, "pause-requested");
				FakePiClient.sessionFiles.set(pi.state.sessionFile!, [{ role: "toolResult", content: [] }]);
				if (outcome === "boundary") {
					pi.cancelPauseHook = () => { throw new Error("Agent has already reached the pause boundary"); };
					await assert.rejects(request("cancel-pause"), /pause boundary/);
					assert.equal(adapter.getSession(session.sessionId)!.agentControlState, "pause-requested");
				} else if (outcome === "settled-during-cancel") {
					let release!: () => void;
					const gate = new Promise<void>((resolve) => { release = resolve; });
					pi.cancelPauseHook = () => gate;
					const undo = request("cancel-pause");
					await waitFor(() => pi.cancelPauses === 1);
					pi.emit({ type: "agent_settled" });
					await waitFor(() => adapter.getSession(session.sessionId)?.activeRun === undefined);
					release();
					assert.equal((await undo).state, "paused", "late cancel must not publish running after settlement");
				} else {
					assert.equal((await request("cancel-pause")).state, "running");
					assert.equal(adapter.getSession(session.sessionId)!.activeRun, owner);
					assert.equal(pi.cancelPauses, 1);
					assert.equal((await request("cancel-pause")).state, "running");
					assert.equal(pi.cancelPauses, 1, "duplicate withdrawal outside pending state is a no-op");
				}
				assert.equal(pi.continues, 0);
				assert.equal(pi.aborts, 0);
				assert.equal(pi.promptCalls.length, origin === "prompt" ? 1 : 0);
				if (outcome !== "settled-during-cancel") {
					assert.equal(adapter.getSession(session.sessionId)!.activeRun, owner);
					pi.emit({ type: "agent_settled" });
					await waitFor(() => adapter.getSession(session.sessionId)?.activeRun === undefined);
				}
				if (pending) await pending;
				const settled = outcome === "cancel" ? "continuable" : "paused";
				assert.equal(adapter.getSession(session.sessionId)!.agentControlState, settled);
				assert.equal((await request("cancel-pause")).state, settled);
				assert.equal(pi.cancelPauses, 1, "withdrawal must never resume a settled pause");
			});
		});
	}

	test(`an extension restart during ${origin} settlement keeps run ownership`, async () => {
		const { adapter, clients } = createTestAdapter();
		await connect(adapter, async (cx) => {
			const session = await cx.buildSession("/tmp/settlement-restart").start();
			const pi = clients[0]!;
			let promptSettled = false;
			const pending = origin === "prompt"
				? session.prompt("first").finally(() => { promptSettled = true; })
				: undefined;
			void pending?.catch(() => {});
			if (pending) await waitFor(() => pi.promptCalls.length === 1);
			pi.emit({ type: "agent_start" });
			const owner = adapter.getSession(session.sessionId)!.activeRun;
			let release!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			const getMessages = pi.getMessages.bind(pi);
			pi.getMessages = async () => { await gate; return []; };
			pi.emit({
				type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "error" }], willRetry: false,
			} as unknown as JsonAgentSessionEvent);
			pi.emit({ type: "agent_settled" });
			// A todo nudge/hidden continuation starts before the old RPC snapshot returns.
			pi.emit({ type: "agent_start" });
			release();
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(adapter.getSession(session.sessionId)!.activeRun, owner);
			assert.equal(promptSettled, false, "old settlement must not resolve a still-running prompt");
			if (origin === "extension") {
				assert.equal(adapter.getSession(session.sessionId)!.agentControlState, "running",
					"an adopted run must not publish an idle indicator while streaming");
			}
			assert.equal(owner!.stopReason, undefined, "previous run's error must not leak into the restart");
			await assert.rejects(session.prompt("overlap"), /already in progress/);
			const queued = await cx.request(PIX_QUEUE_MESSAGE_METHOD, {
				sessionId: session.sessionId,
				prompt: [{ type: "text", text: "queued during restart" }],
				displayText: "queued during restart",
			}) as { disposition: string };
			assert.equal(queued.disposition, "steering");
			assert.deepEqual(pi.steerCalls, ["queued during restart"]);
			await cx.request(PIX_AGENT_CONTROL_METHOD, { sessionId: session.sessionId, action: "pause" });
			assert.equal(pi.pauses, 1, "Pause must still own the restarted SDK run");
			pi.getMessages = getMessages;
			pi.emit({ type: "agent_settled" });
			if (pending) assert.equal((await pending).stopReason, "end_turn");
			await waitFor(() => adapter.getSession(session.sessionId)?.activeRun === undefined);
		});
	});
}

test("restart during a cancelled settlement notification retains the new SDK run", async () => {
	const { adapter, clients } = createTestAdapter();
	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/cancelled-settlement-restart").start();
		const pi = clients[0]!;
		pi.emit({ type: "agent_start" });
		const state = adapter.getSession(session.sessionId)!;
		const owner = state.activeRun!;
		await cx.notify("session/cancel", { sessionId: session.sessionId });
		await waitFor(() => pi.aborts === 1);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		const notify = state.client.notify.bind(state.client);
		state.client.notify = async () => gate;
		pi.emit({ type: "agent_settled" });
		assert.equal(owner.cancelled, true);
		pi.emit({ type: "agent_start" });
		release();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(state.activeRun, owner);
		assert.equal(owner.cancelled, false);
		assert.equal(state.agentControlState, "running");
		state.client.notify = notify;
		pi.emit({ type: "agent_settled" });
		await waitFor(() => state.activeRun === undefined);
	});
});

test("a failed interrupted-queue restore cannot reject a restarted run", async () => {
	const { adapter, clients } = createTestAdapter();
	await connect(adapter, async (cx) => {
		const session = await cx.buildSession("/tmp/queue-restore-restart").start();
		const pi = clients[0]!;
		pi.emit({ type: "agent_start" });
		const state = adapter.getSession(session.sessionId)!;
		const owner = state.activeRun!;
		let rejectRestore!: (error: Error) => void;
		const gate = new Promise<void>((_resolve, reject) => { rejectRestore = reject; });
		pi.steer = async () => gate;
		state.sdkQueueRestoreAfterInterrupt = { steering: ["preserved"], followUp: [] };
		pi.emit({ type: "agent_settled" });
		pi.emit({ type: "agent_start" });
		rejectRestore(new Error("old restore failed"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(state.activeRun, owner);
		pi.emit({ type: "agent_settled" });
		await waitFor(() => state.activeRun === undefined);
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
		assert.equal(clients[0].eventListenerCount, 0);
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

test("session/close leaves a pending questionnaire unanswered and stops RPC without abort", async () => {
	const { adapter, clients } = createTestAdapter();
	try {
		await connect(adapter, async (cx) => {
			await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, ...ELICITATION_CAPS });
			const { sessionId } = await cx.buildSession("/tmp").start();
			const fakePi = clients[0]!;
			fakePi.emit({ type: "extension_ui_request", id: "restorable-question", method: "editor",
				title: PIX_QUESTION_EDITOR_TITLE, prefill: JSON.stringify({ version: 1, questions: [{ id: "scope", label: "Scope",
					prompt: "Which scope?", choices: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }] }] }) });
			const state = adapter.getSession(sessionId);
			await waitFor(() => state?.pendingQuestionIds.size === 1);
			await cx.request("session/close", { sessionId });
			assert.deepEqual(fakePi.uiResponses, []);
			assert.equal(fakePi.aborts, 0);
			assert.equal(fakePi.started, false);
		}, (app) => { app.onRequest("elicitation/create", async () => new Promise<CreateElicitationResponse>(() => {})); });
	} finally { await adapter.dispose(); }
});

test("question interruption metadata and transport errors are not serialized as user Cancel", async () => {
	for (const transportError of [false, true]) {
		const { adapter, clients } = createTestAdapter();
		try {
			await connect(adapter, async (cx) => {
				await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, ...ELICITATION_CAPS });
				const { sessionId } = await cx.buildSession("/tmp").start();
				const fakePi = clients[0]!;
				fakePi.emit({ type: "extension_ui_request", id: "interrupted-question", method: "editor",
					title: PIX_QUESTION_EDITOR_TITLE, prefill: JSON.stringify({ version: 1, questions: [{ id: "scope", label: "Scope",
						prompt: "Which scope?", choices: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }] }] }) });
				const state = adapter.getSession(sessionId);
				await waitFor(() => state?.pendingQuestionIds.size === 1 && state.pendingDialogIds.size === 0);
				assert.deepEqual(fakePi.uiResponses, []);
				await cx.request("session/close", { sessionId });
				assert.deepEqual(fakePi.uiResponses, []);
				assert.equal(fakePi.aborts, 0);
			}, (app) => { app.onRequest("elicitation/create", () => {
				if (transportError) throw new Error("connection lost");
				return { action: "cancel", _meta: { "_pix/question-interrupted": true } };
			}); });
		} finally { await adapter.dispose(); }
	}
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

test("extension slash command notifications are visible as transcript feedback", async () => {
	const { adapter, clients } = createTestAdapter();
	const updates: SessionNotification[] = [];
	await connect(adapter, async (cx) => {
		const created = await cx.request("session/new", { cwd: "/tmp", mcpServers: [] });
		const sessionId = (created as { sessionId: string }).sessionId;
		const pi = clients[0]!;
		pi.promptHandledWithoutRun = true;
		pi.promptHook = (message) => {
			if (message === "/shell-workdir list") {
				pi.emit({ type: "extension_ui_request", id: "list", method: "notify", message: "No extra shell working directories allowed (this session only).", notifyType: "info" });
			} else {
				pi.emit({ type: "extension_ui_request", id: "other", method: "notify", message: "Background notice", notifyType: "info" });
			}
		};
		assert.equal((await cx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/shell-workdir list" }] }) as { stopReason: string }).stopReason, "end_turn");
		await cx.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });
	}, (app) => {
		app.onNotification("session/update", (ctx) => { updates.push(ctx.params); });
	});
	const feedback = updates.filter((item) => item.update.sessionUpdate === "agent_message_chunk")
		.map((item) => (item.update as { content: { text: string } }).content.text);
	assert.deepEqual(feedback, ["No extra shell working directories allowed (this session only)."]);
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

test("Pix Desktop search query/config use the exact private contract without spawning Pi and reject other clients", async t => {
	const artifacts = resolve(".pi/artifacts/search-backend-locked/agent");
	await mkdir(artifacts, { recursive: true });
	const cwd = mkdtempSync(join(artifacts, "run-"));
	const searchService = new DesktopSearchService({ discover: async () => [], preferences: new SearchPreferences(join(cwd, "preferences.jsonc")),
		auth: { available: async () => false, key: async () => undefined, save: async () => {} },
		embed: async () => { throw new Error("No paid requests allowed"); } });
	const harness = createTestAdapter({ searchService, createPiClient: () => { throw new Error("Search must not create Pi"); } });
	t.after(async () => { await harness.adapter.dispose(); await rm(cwd, { recursive: true, force: true }); });
	const request = { cwd, query: "appearance", types: ["settings", "sessions"], limit: 10,
		settings: [{ id: "theme", section: "Appearance", label: "Theme", description: "Select appearance", synonyms: [], value: "SECRET VALUE" }] };
	await connectAs(harness.adapter, "pix-desktop", async cx => {
		await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "pix-desktop", version: "test" } });
		const response = await cx.request(SEARCH_QUERY_METHOD, request) as SearchQueryResponse;
		assert.equal(response.results[0]?.id, "settings:theme");
		assert.equal(response.status.enabled, false);
		assert.doesNotMatch(JSON.stringify(response), /SECRET VALUE/);
		const config = await cx.request(SEARCH_CONFIG_METHOD, { cwd, enabled: false }) as SearchQueryResponse["status"];
		assert.equal(config.enabled, false);
		assert.equal(config.keyAvailable, false);
		assert.equal(typeof config.indexing, "boolean");
		assert.equal(config.tasksSemanticEnabled, false);
		const semanticTaskRequest = { cwd, query: "unfinished work", limit: 20 };
		assert.deepEqual(await cx.request(SEARCH_TASKS_METHOD, semanticTaskRequest), {
			results: [], pendingIndex: false,
		} satisfies SemanticTasksResponse);
		const consent = await cx.request(SEARCH_CONFIG_METHOD, { cwd, tasksSemanticEnabled: true }) as SearchQueryResponse["status"];
		assert.equal(consent.tasksSemanticEnabled, true);
		assert.deepEqual(await cx.request(SEARCH_TASKS_METHOD, semanticTaskRequest), { results: [], pendingIndex: false },
			"consent without a stored provider credential cannot send embeddings");
		for (const bad of [
			{ ...semanticTaskRequest, cwd: "relative" }, { ...semanticTaskRequest, query: "" },
			{ ...semanticTaskRequest, limit: 0 }, { ...semanticTaskRequest, unexpected: true },
		]) await assert.rejects(cx.request(SEARCH_TASKS_METHOD, bad), /Invalid Desktop search request/);
		await assert.rejects(cx.request(SEARCH_CONFIG_METHOD, { cwd, messageFilterEnabled: true }), /Invalid Desktop search request/);
		await assert.rejects(cx.request(SEARCH_CONFIG_METHOD, { cwd, messageFilterEnabled: false }), /Invalid Desktop search request/);
		await assert.rejects(cx.request(SEARCH_CONFIG_METHOD, { cwd, messageFilterEnabled: "true" }), /Invalid Desktop search request/);
		await assert.rejects(cx.request(SEARCH_QUERY_METHOD, { ...request, cwd: "relative" }));
	});
	await connect(harness.adapter, async cx => {
		await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION });
		await assert.rejects(cx.request(SEARCH_QUERY_METHOD, request), /Desktop search unavailable/);
		await assert.rejects(cx.request(SEARCH_CONFIG_METHOD, { cwd }), /Desktop search unavailable/);
		await assert.rejects(cx.request(SEARCH_TASKS_METHOD, { cwd, query: "tasks", limit: 10 }), /Desktop search unavailable/);
	});
	assert.equal(harness.adapter.sessionCount, 0);
});

test("Pix Desktop Jev intent is an isolated, validated, Desktop-only request", async t => {
  const requests: string[] = [];
  const adapter = createTestAdapter({
    searchIntentService: { classify: async (query, signal) => {
      assert.ok(signal instanceof AbortSignal);
      requests.push(query);
      if (query === "failure") throw new Error("Bearer SECRET invalid provider response");
      return { intent: "ask", fallback: false };
    } },
    createPiClient: () => { throw new Error("Intent routing must not create Pi"); },
  });
  t.after(() => adapter.adapter.dispose());
  const request = { cwd: resolve("."), query: "explain the architecture" };
  await connectAs(adapter.adapter, "pix-desktop", async cx => {
    await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "pix-desktop", version: "test" } });
    assert.deepEqual(await cx.request(SEARCH_INTENT_METHOD, { ...request, secret: "private" }), { intent: "ask", fallback: false });
    assert.deepEqual(await cx.request(SEARCH_INTENT_METHOD, { ...request, query: "failure" }), { intent: "search", fallback: true });
    for (const invalid of [{ ...request, cwd: "relative" }, { ...request, query: "" }, { ...request, query: "x".repeat(2049) }]) {
      await assert.rejects(cx.request(SEARCH_INTENT_METHOD, invalid));
    }
  });
  await connect(adapter.adapter, async cx => {
    await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION });
    await assert.rejects(cx.request(SEARCH_INTENT_METHOD, request), /Desktop search unavailable/);
  });
  assert.deepEqual(requests, ["explain the architecture", "failure"]);
  assert.equal(adapter.adapter.sessionCount, 0);
});

test("Pix Desktop task type Jev request is Desktop-only, validated and does not start sessions", async t => {
  const received: string[] = [];
  const harness = createTestAdapter({
    taskTypeClassifier: { classify: async (taskText, signal) => {
      assert.ok(signal instanceof AbortSignal);
      received.push(taskText);
      if (taskText === "unavailable") throw new Error("Bearer SECRET provider error");
      return { type: "idea", fallback: false };
    } },
    createPiClient: () => { throw new Error("Task classification must never create Pi"); },
  });
  t.after(() => harness.adapter.dispose());
  const request = { cwd: resolve("."), text: "Explore alternative UI" };
  await connectAs(harness.adapter, "pix-desktop", async cx => {
    await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "pix-desktop", version: "test" } });
    assert.deepEqual(await cx.request(TASK_TYPE_CLASSIFY_METHOD, { ...request, secret: "not-forwarded" }), { type: "idea", fallback: false });
    assert.deepEqual(await cx.request(TASK_TYPE_CLASSIFY_METHOD, { ...request, text: "unavailable" }), { type: "feature", fallback: true });
    for (const invalid of [{ ...request, cwd: "relative" }, { ...request, text: "" }, { ...request, text: "x".repeat(2049) }]) {
      await assert.rejects(cx.request(TASK_TYPE_CLASSIFY_METHOD, invalid));
    }
  });
  await connect(harness.adapter, async cx => {
    await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION });
    await assert.rejects(cx.request(TASK_TYPE_CLASSIFY_METHOD, request), /Desktop task classification unavailable/);
  });
  assert.deepEqual(received, ["Explore alternative UI", "unavailable"]);
  assert.equal(harness.adapter.sessionCount, 0);
});

test("Desktop RAG streams source identities and answer text without starting a Pi session", async t => {
	const notifications: Array<{ requestId: string; sourceIds?: string[]; text?: string }> = [];
	const runs: string[] = [];
	const harness = createTestAdapter({
		ragService: {
			generate: async (request, progress, signal) => {
				assert.ok(signal instanceof AbortSignal);
				runs.push(request.query);
				await progress({ sourceIds: ["tasks:1"] });
				await progress({ text: "The task is complete [1]." });
				return { answer: "The task is complete [1].", modelRef: "openai/mock", sourceIds: ["tasks:1"] };
			},
		},
		createPiClient: () => { throw new Error("RAG cannot start Pi"); },
	});
	t.after(() => harness.adapter.dispose());
	const request = { cwd: resolve("."), requestId: "rag-owner-123", query: "What was completed?",
		sources: [{ id: "tasks:1", kind: "tasks", title: "Task one", snippet: "Completed" }] };
	await connectAs(harness.adapter, "pix-desktop", async cx => {
		await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "pix-desktop", version: "test" } });
		assert.deepEqual(await cx.request(SEARCH_RAG_METHOD, request),
			{ answer: "The task is complete [1].", modelRef: "openai/mock", sourceIds: ["tasks:1"] });
		await waitFor(() => notifications.length === 2);
		assert.deepEqual(notifications, [
			{ requestId: "rag-owner-123", sourceIds: ["tasks:1"] },
			{ requestId: "rag-owner-123", text: "The task is complete [1]." },
		]);
		for (const invalid of [
			{ ...request, cwd: "relative" },
			{ ...request, sources: [{ ...request.sources[0], path: "../secret" }] },
			{ ...request, sources: Array(13).fill(request.sources[0]) },
		]) await assert.rejects(cx.request(SEARCH_RAG_METHOD, invalid));
	}, app => {
		const custom = app as unknown as { onNotification(method: string,
			parser: (params: unknown) => typeof notifications[number],
			handler: (ctx: { params: typeof notifications[number] }) => void): void };
		custom.onNotification(SEARCH_RAG_DELTA_METHOD, params => params as typeof notifications[number],
			ctx => { notifications.push(ctx.params); });
	});
	await connect(harness.adapter, async cx => {
		await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION });
		await assert.rejects(cx.request(SEARCH_RAG_METHOD, request), /Desktop search unavailable/);
	});
	assert.deepEqual(runs, ["What was completed?"]);
	assert.equal(harness.adapter.sessionCount, 0);
});

test("Pix Desktop commit search uses a separate private contract without starting Pi or leaking backend errors", async t => {
	const requests: CommitSearchRequest[] = [];
	let fail = false;
	let disposed = false;
	const harness = createTestAdapter({
		commitSearchService: {
			query: async (request, signal) => {
				assert.ok(signal instanceof AbortSignal);
				requests.push(request);
				if (fail) throw new Error("Bearer PRIVATE_PROVIDER_ERROR");
				return { results: [], notices: ["local fallback"] };
			},
			dispose: async () => { disposed = true; },
		},
		createPiClient: () => { throw new Error("Commit search must not create Pi"); },
	});
	t.after(async () => { await harness.adapter.dispose(); });
	const request = { cwd: resolve("."), query: "recover backups", limit: 20 };
	await connectAs(harness.adapter, "pix-desktop", async cx => {
		await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "pix-desktop", version: "test" } });
		assert.deepEqual(await cx.request(SEARCH_COMMITS_METHOD, request), { results: [], notices: ["local fallback"] });
		assert.deepEqual(requests, [request]);
		await assert.rejects(cx.request(SEARCH_COMMITS_METHOD, { ...request, cwd: "relative" }));
		await assert.rejects(cx.request(SEARCH_COMMITS_METHOD, { ...request, query: "x".repeat(2049) }));
		await assert.rejects(cx.request(SEARCH_COMMITS_METHOD, { ...request, limit: 0 }));
		assert.equal(requests.length, 1);
		fail = true;
		await assert.rejects(cx.request(SEARCH_COMMITS_METHOD, request), error => {
			assert.ok(error instanceof RequestError);
			assert.equal(error.code, -32000);
			assert.equal(error.message, "Commit search unavailable");
			assert.doesNotMatch(JSON.stringify(error), /PRIVATE|Bearer/);
			return true;
		});
	});
	await connect(harness.adapter, async cx => {
		await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION });
		await assert.rejects(cx.request(SEARCH_COMMITS_METHOD, request), /Desktop search unavailable/);
	});
	assert.equal(harness.adapter.sessionCount, 0);
	await harness.adapter.dispose();
	assert.equal(disposed, true);
});

test("Pix Desktop search preserves controlled source errors across ACP without leaking underlying failures", async t => {
	const artifacts = resolve(".pi/artifacts/search-backend-locked/agent");
	await mkdir(artifacts, { recursive: true });
	const cwd = mkdtempSync(join(artifacts, "run-"));
	let failing = true;
	const sourceSignals: AbortSignal[] = [];
	const harness = createTestAdapter({
		listPiSessions: async (_cwd, signal) => {
			assert.ok(signal, "search forwards its deadline signal to native discovery");
			sourceSignals.push(signal);
			if (failing) throw new Error("private corpus content Bearer SECRET");
			return [];
		},
		createPiClient: () => { throw new Error("Search must not create Pi"); },
	});
	t.after(async () => { await harness.adapter.dispose(); await rm(cwd, { recursive: true, force: true }); });
	await connectAs(harness.adapter, "pix-desktop", async cx => {
		await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "pix-desktop", version: "test" } });
		const request = { cwd, query: "target", types: ["sessions"], settings: [], limit: 10 };
		await assert.rejects(cx.request(SEARCH_QUERY_METHOD, request), error => {
			assert.ok(error instanceof RequestError);
			assert.equal(error.code, -32000);
			assert.equal(error.message, "Session title discovery timed out or failed");
			assert.doesNotMatch(JSON.stringify(error), /SECRET|private corpus/);
			return true;
		});
		assert.equal(sourceSignals.length, 1);
		failing = false;
		const response = await cx.request(SEARCH_QUERY_METHOD, request) as SearchQueryResponse;
		assert.deepEqual(response.results, []);
	});
});

test("Pix Desktop title discovery does not resurrect a session deleted while native listing was in flight", async t => {
  const root = resolve(".pi/artifacts/session-title-search/agent-race");
  await mkdir(root, { recursive: true });
  const cwd = mkdtempSync(join(root, "run-"));
  const path = join(cwd, "session.jsonl");
  await writeFile(path, "session body never read by title search");
  let start!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const released = new Promise<void>(resolve => { finish = resolve; });
  const harness = createTestAdapter({
    listPiSessions: async () => { start(); await released; return [nativeSession("native", { path, cwd, name: "target title" })]; },
    createPiClient: () => { throw new Error("Search must not spawn Pi"); },
  });
  t.after(async () => { finish(); await harness.adapter.dispose(); await rm(cwd, { recursive: true, force: true }); });
  const map = new SessionMapStore(harness.sessionMapPath, TEST_LOGGER);
  await map.put({ sessionId: "stable", piSessionId: "native", piSessionPath: path, cwd, title: "target title", updatedAt: "2025-01-01T00:00:00.000Z" });
  await connectAs(harness.adapter, "pix-desktop", async cx => {
    await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: "pix-desktop", version: "test" } });
    const pending = cx.request(SEARCH_QUERY_METHOD, { cwd, query: "target", types: ["sessions"], settings: [], limit: 10 });
    await started;
    await cx.request("session/delete", { sessionId: "stable" });
    finish();
    assert.deepEqual((await pending as SearchQueryResponse).results, []);
    assert.equal(await map.get("stable"), undefined);
    assert.equal(await map.get("native"), undefined);
  });
});

test("Pix Desktop registry actions call the direct service without a Pi runtime or conversation", async () => {
	const calls: string[] = [];
	const elicitationParams: CreateElicitationRequest[] = [];
	const snapshot = { version: 1 as const, configured: false, branch: "main", items: [], checkedAt: "2026-09-23T12:00:00Z" };
	const harness = createTestAdapter({
		createPiClient: () => { throw new Error("Registry must not create a Pi runtime"); },
		registryService: {
			action: async (request, ctx) => {
				assert.equal(ctx.cwd, "/tmp/registry-gui");
				calls.push(request.action);
				if (request.action === "project-key") {
					assert.equal(await ctx.ui.input("Project registry key", "my-project"), "manual-key");
					return { ...snapshot, projectKey: "manual-key" };
				}
				if (request.action === "tags") {
					assert.equal(await ctx.ui.editor("Tags for skill pdf", "docs"), "docs, review");
				}
				return snapshot;
			},
			diff: async () => { throw new Error("Unexpected diff"); },
		},
	});
	await connectAs(harness.adapter, "pix-desktop", async (cx) => {
		await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, ...ELICITATION_CAPS });
		for (const request of [
			{ action: "refresh" }, { action: "update", type: "skill", name: "pdf" },
			{ action: "pull-project", scope: "todo" }, { action: "tags", type: "skill", name: "pdf" },
		]) assert.deepEqual(await cx.request(PIX_REGISTRY_ACTION_METHOD, { cwd: "/tmp/registry-gui", ...request }), { snapshot });
		assert.deepEqual(await cx.request(PIX_REGISTRY_ACTION_METHOD, { cwd: "/tmp/registry-gui", action: "project-key" }), { snapshot: { ...snapshot, projectKey: "manual-key" } });
	}, (app) => {
		app.onRequest("elicitation/create", (ctx) => {
			elicitationParams.push(ctx.params);
			return { action: "accept", content: { value: ctx.params.message.startsWith("Tags") ? "docs, review" : "manual-key" } } satisfies CreateElicitationResponse;
		});
	});
	assert.equal(harness.adapter.sessionCount, 0);
	assert.deepEqual(calls, ["refresh", "update", "pull-project", "tags", "project-key"]);
	assert.equal(elicitationParams.length, 2);
	for (const params of elicitationParams) {
		assert.equal((params as { sessionId?: string }).sessionId, undefined);
		assert.equal(typeof (params as { requestId?: string }).requestId, "string");
	}
});

test("Pix Desktop registry diff calls the direct service and validates file texts without Pi", async () => {
	let calls = 0;
	const files = [
		{ path: "skills/pdf/SKILL.md", oldText: "remote v1\n", newText: "local v2\n" },
		{ path: "skills/pdf/removed.txt", oldText: "gone\n", newText: null },
		{ path: "skills/pdf/added.bin", oldText: null, newText: null, notice: "Project copy is binary" },
	];
	const harness = createTestAdapter({
		createPiClient: () => { throw new Error("Registry must not create a Pi runtime"); },
		registryService: {
			action: async () => { throw new Error("Unexpected action"); },
			diff: async (request) => {
				assert.deepEqual(request, { cwd: "/tmp/registry-gui", type: "skill", name: "pdf" });
				calls += 1;
				return { version: 1, type: "skill", name: "pdf", files: calls === 3 ? "not-an-array" as unknown as typeof files : calls === 2 ? [] : files, ...(calls === 2 ? { error: 'Project skill "pdf" does not exist.' } : {}) };
			},
		},
	});
	await connectAs(harness.adapter, "pix-desktop", async (cx) => {
		await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, ...ELICITATION_CAPS });
		const request = { cwd: "/tmp/registry-gui", type: "skill", name: "pdf" };
		assert.deepEqual(await cx.request(PIX_REGISTRY_DIFF_METHOD, request), { files });
		await assert.rejects(cx.request(PIX_REGISTRY_DIFF_METHOD, request), /Project skill "pdf" does not exist\./);
		await assert.rejects(cx.request(PIX_REGISTRY_DIFF_METHOD, request), /resource registry published an invalid diff payload/);
		await assert.rejects(cx.request(PIX_REGISTRY_DIFF_METHOD, { ...request, type: "tasks" }), /registry diff request requires cwd, type skill\|agent, and a valid resource name/);
	});
	assert.equal(harness.adapter.sessionCount, 0);
	assert.equal(calls, 3);
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

test("activity attachments rebind a reused runtime and replay cached snapshots with their original timestamp", async () => {
	const harness = createTestAdapter();
	const notifications: Array<{ sessionId: string; channel: string; data: { checkedAt: number }; activityOwner?: string }> = [];
	await connect(harness.adapter, async (cx) => {
		const created = await cx.request("session/new", {
			cwd: "/tmp/proj", mcpServers: [], _meta: { "pix.activityOwner": "attachment-old" },
		}) as { sessionId: string };
		const sessionId = created.sessionId;
		const pi = harness.clients[0]!;
		pi.emit({ type: "extension_ui_request", id: "activity", method: "setWidget",
			widgetKey: "pix.session-state", widgetLines: ["pi-tools-suite:todo:state", JSON.stringify({ version: 1, checkedAt: 17 })] });
		await waitFor(() => notifications.length === 1);
		assert.equal(notifications[0]?.activityOwner, "attachment-old");
		await cx.request("session/load", { sessionId, cwd: "/tmp/proj", mcpServers: [],
			_meta: { "pix.lazyHistory": true, "pix.activityOwner": "attachment-new" } });
		await waitFor(() => notifications.length === 2);
		assert.equal(harness.clients.length, 1);
		assert.deepEqual(notifications[1], { sessionId, channel: "pi-tools-suite:todo:state",
			data: { version: 1, checkedAt: 17 }, activityOwner: "attachment-new" });
	}, (app) => {
		const custom = app as unknown as { onNotification(method: string,
			parser: (params: unknown) => typeof notifications[number],
			handler: (ctx: { params: typeof notifications[number] }) => void): void };
		custom.onNotification(PIX_SESSION_STATE_METHOD, (value) => value as typeof notifications[number],
			(ctx) => notifications.push(ctx.params));
	});
});

test("legacy workspace state cannot change the live session cwd", async () => {
	const harness = createTestAdapter();
	const notifications: Array<{ sessionId: string; channel: string; data: unknown }> = [];
	await connect(harness.adapter, async (cx) => {
		const created = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] }) as { sessionId: string };
		const pi = harness.clients[0]!;
		pi.emit({ type: "extension_ui_request", id: "workspace", method: "setWidget", widgetKey: "pix.session-state",
			widgetLines: ["workspace", JSON.stringify({ cwd: "/tmp/proj/committed", stack: ["/tmp/proj"] })] });
		await waitFor(() => notifications.length === 1);
		assert.deepEqual(notifications[0], { sessionId: created.sessionId, channel: "workspace",
			data: { cwd: "/tmp/proj/committed", stack: ["/tmp/proj"] } });
		const store = new SessionMapStore(harness.sessionMapPath, TEST_LOGGER);
		assert.equal((await store.get(created.sessionId))?.cwd, "/tmp/proj");
		assert.equal((await store.list("/tmp/proj"))[0]?.sessionId, created.sessionId);
		assert.deepEqual(await store.list("/tmp/proj/committed"), []);
	}, (app) => {
		const custom = app as unknown as { onNotification(method: string,
			parser: (params: unknown) => typeof notifications[number],
			handler: (ctx: { params: typeof notifications[number] }) => void): void };
		custom.onNotification(PIX_SESSION_STATE_METHOD, (value) => value as typeof notifications[number],
			(ctx) => notifications.push(ctx.params));
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
			messageId: "replay-entry:u1",
			content: { type: "text", text: "direct history" },
		}]);
		assert.equal(harness.clients.length, 1, "reading history must not spawn pi");
	});
});

test("desktop full live history preserves user entry identities on the active branch", async () => {
	const harness = createTestAdapter();
	await connect(harness.adapter, async (cx) => {
		const { sessionId } = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] });
		const pi = harness.clients[0]!;
		pi.entriesState = {
			leafId: "u2",
			entries: [
				{ type: "message", id: "u1", parentId: null, message: { role: "user", content: "repeat" } },
				{ type: "message", id: "abandoned", parentId: "u1", message: { role: "user", content: "repeat" } },
				{ type: "message", id: "u2", parentId: "u1", message: { role: "user", content: "repeat" } },
			],
		};
		const history = await cx.request(PIX_SESSION_HISTORY_METHOD, { sessionId, full: true }) as {
			updates: Array<{ sessionUpdate: string; messageId?: string }>;
		};
		assert.deepEqual(history.updates.map((update) => update.messageId), ["replay-entry:u1", "replay-entry:u2"]);
	});
});

test("desktop history cursor reads older persisted pages without starting a pi runtime", async () => {
	const harness = createTestAdapter();
	await connect(harness.adapter, async (cx) => {
		const created = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] });
		const sessionId = (created as { sessionId: string }).sessionId;
		const store = new SessionMapStore(harness.sessionMapPath, TEST_LOGGER);
		const record = await store.get(sessionId);
		assert.ok(record);
		const sessionPath = join(dirname(harness.sessionMapPath), "cursor-history.jsonl");
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "pi-cursor", timestamp: "2026-09-06T00:00:00.000Z", cwd: "/tmp/proj" }),
			...Array.from({ length: 185 }, (_, index) => JSON.stringify({
				type: "message",
				id: `u${index}`,
				parentId: index === 0 ? null : `u${index - 1}`,
				timestamp: "2026-09-06T00:00:01.000Z",
				message: { role: "user", content: `message ${index}` },
			})),
		];
		await writeFile(sessionPath, `${lines.join("\n")}\n`, "utf8");
		await store.put({ ...record, piSessionPath: sessionPath, piSessionId: "pi-cursor" });
		await cx.request("session/close", { sessionId });
		assert.equal(harness.adapter.getSession(sessionId), undefined);

		const tail = await cx.request(PIX_SESSION_HISTORY_METHOD, { sessionId }) as {
			updates: Array<Record<string, unknown>>;
			cursor?: string;
		};
		assert.equal(tail.updates.length, 180);
		assert.ok(tail.cursor);
		assert.equal(tail.updates[0]?.messageId, "replay-entry:u5");

		const older = await cx.request(PIX_SESSION_HISTORY_METHOD, { sessionId, cursor: tail.cursor }) as {
			updates: Array<Record<string, unknown>>;
			cursor?: string;
		};
		assert.equal(older.updates.length, 5);
		assert.equal(older.cursor, undefined);
		assert.equal(older.updates[0]?.messageId, "replay-entry:u0");
		assert.equal((older.updates[0]?.content as { text?: string } | undefined)?.text, "message 0");
		assert.equal(harness.clients.length, 1, "cursor history reads must stay on the persisted JSONL path");
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

test("session/fork tags startup activity before its response with the requested attachment", async () => {
	let spawned = 0;
	const harness = createTestAdapter({ createPiClient: () => {
		const fake = new FakePiClient();
		if (++spawned === 2) fake.eventsOnStart.push({ type: "extension_ui_request", id: "fork-startup",
			method: "setWidget", widgetKey: "pix.session-state",
			widgetLines: ["pi-tools-suite:todo:state", JSON.stringify({ version: 1, checkedAt: 9 })] });
		return fake;
	} });
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] })) as { sessionId: string };
	const notifications: Array<{ sessionId: string; activityOwner: string; data: unknown }> = [];
	await connect(harness.adapter, async (cx) => {
		const forked = await cx.request("session/fork", { sessionId: created.sessionId, cwd: "/tmp/proj",
			mcpServers: [], _meta: { "pix.activityOwner": "fork-attachment" } }) as { sessionId: string };
		await waitFor(() => notifications.length === 1);
		assert.deepEqual(notifications[0], { sessionId: forked.sessionId, activityOwner: "fork-attachment",
			channel: "pi-tools-suite:todo:state", data: { version: 1, checkedAt: 9 } });
	}, (app) => {
		const custom = app as unknown as { onNotification(method: string,
			parser: (params: unknown) => typeof notifications[number],
			handler: (ctx: { params: typeof notifications[number] }) => void): void };
		custom.onNotification(PIX_SESSION_STATE_METHOD, (value) => value as typeof notifications[number],
			(ctx) => notifications.push(ctx.params));
	});
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
		pi.entriesState = {
			leafId: "assistant-2",
			entries: [
				{ id: "user-1", parentId: null, type: "message", message: { role: "user", content: "same prompt" } },
				{ id: "assistant-1", parentId: "user-1", type: "message", message: { role: "assistant", content: [] } },
				{ id: "user-2", parentId: "assistant-1", type: "message", message: { role: "user", content: [{ type: "text", text: "same prompt" }] } },
				{ id: "assistant-2", parentId: "user-2", type: "message", message: { role: "assistant", content: [] } },
				{ id: "abandoned-user", parentId: "user-2", type: "message", message: { role: "user", content: "old branch" } },
			],
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
		pi.entriesState = {
			leafId: "user-2",
			entries: [
				{ id: "user-1", parentId: null, type: "message", message: { role: "user", content: "first" } },
				{ id: "user-2", parentId: "user-1", type: "message", message: { role: "user", content: "second" } },
			],
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

test("Pix Desktop bash bridge forwards context flags even while an agent turn is running", async () => {
	const harness = createTestAdapter();
	const notifications: SessionNotification[] = [];

	await connectAs(
		harness.adapter,
		"pix-desktop",
		async (cx) => {
			const created = await cx.request("session/new", { cwd: "/tmp/bash-mode", mcpServers: [] }) as { sessionId: string };
			const pi = harness.clients[0]!;
			const running = cx.request("session/prompt", {
				sessionId: created.sessionId,
				prompt: [{ type: "text", text: "keep working" }],
			});
			await waitFor(() => pi.promptCalls.length === 1);
			pi.emit({ type: "agent_start" });

			await cx.request(PIX_BASH_METHOD, {
				sessionId: created.sessionId,
				command: "pwd",
				excludeFromContext: false,
				displayText: "!pwd",
			});
			await cx.request(PIX_BASH_METHOD, {
				sessionId: created.sessionId,
				command: "git status",
				excludeFromContext: true,
				displayText: "!!git status",
			});

			assert.deepEqual(pi.bashCalls, [
				{ command: "pwd", excludeFromContext: false },
				{ command: "git status", excludeFromContext: true },
			]);

			pi.emit({
				type: "agent_end",
				messages: [{ role: "assistant", content: [], stopReason: "stop" }],
				willRetry: false,
			} as unknown as JsonAgentSessionEvent);
			pi.emit({ type: "agent_settled" });
			await running;
		},
		(app) => {
			app.onNotification("session/update", (ctx) => { notifications.push(ctx.params); });
		},
	);

	const bashStarts = notifications
		.map((notification) => notification.update)
		.filter((update) => update.sessionUpdate === "tool_call" && update.name === "bash") as Array<SessionNotification["update"] & {
			title: string;
			rawInput?: unknown;
		}>;
	assert.equal(bashStarts.length, 2);
	assert.equal(bashStarts[0]?.title, "Bash: pwd");
	assert.equal(bashStarts[1]?.title, "Bash (no context): git status");
	assert.deepEqual(bashStarts[1]?.rawInput, { command: "git status", excludeFromContext: true });

	const bashResults = notifications
		.map((notification) => notification.update)
		.filter((update) => update.sessionUpdate === "tool_call_update" && update.toolCallId?.startsWith("pix-bash:")) as Array<SessionNotification["update"] & {
			status: string;
		}>;
	assert.equal(bashResults.length, 2);
	assert.equal(bashResults.every((update) => update.status === "completed"), true);
});

test("Pix Desktop clears a session plan through the private action without a prompt or transcript entry", async (t) => {
	const harness = createTestAdapter();
	await connectAs(
		harness.adapter,
		"pix-desktop",
		async (cx) => {
			const created = await cx.request("session/new", { cwd: "/tmp/todo-clear", mcpServers: [] }) as { sessionId: string };
			const pi = harness.clients[0]!;
			const touch = t.mock.method(SessionMapStore.prototype, "touch", async () => {
				throw new Error("session list metadata is unavailable");
			});

			await cx.request(PIX_CLEAR_TODOS_METHOD, { sessionId: created.sessionId });

			assert.equal(pi.clearTodosCalls, 1);
			assert.equal(touch.mock.callCount(), 0, "successful clear must not depend on a session-list write");
			t.mock.restoreAll();
			assert.deepEqual(pi.promptCalls, [], "todo clear must not use the chat prompt path");
			assert.deepEqual(await pi.getMessages(), [], "todo clear must not create a user transcript entry");
		},
	);
});

test("Pix Desktop LSP control is session-scoped and allows status/stop while the agent runs", async () => {
	const harness = createTestAdapter();
	await connectAs(harness.adapter, "pix-desktop", async (cx) => {
		const created = await cx.request("session/new", { cwd: "/tmp/lsp-control", mcpServers: [] }) as { sessionId: string };
		const pi = harness.clients[0]!;
		Object.assign(pi.state, { isStreaming: true });
		const status = await cx.request(PIX_LSP_CONTROL_METHOD, { sessionId: created.sessionId, action: "status" }) as {
			servers: Array<{ id: string; state: string }>;
			warnings: string[];
		};
		assert.deepEqual(status, { servers: [{ id: "ts", root: "/tmp", state: "running" }], warnings: [] });
		await assert.rejects(cx.request(PIX_LSP_CONTROL_METHOD, { sessionId: created.sessionId, action: "stop", id: "ts", root: "/workspace" }), /only supports status/);
		assert.deepEqual(pi.lspControlCalls, [{ action: "status" }]);
		assert.deepEqual(pi.promptCalls, [], "control must not create a user prompt");
	});
});

test("Pix Desktop todo clear serializes duplicate requests and releases its idle guard after failure", async () => {
	const harness = createTestAdapter();
	await connectAs(
		harness.adapter,
		"pix-desktop",
		async (cx) => {
			const created = await cx.request("session/new", { cwd: "/tmp/todo-clear-guard", mcpServers: [] }) as { sessionId: string };
			const pi = harness.clients[0]!;
			const gate = Promise.withResolvers<void>();
			pi.clearTodosGate = gate.promise;

			const first = cx.request(PIX_CLEAR_TODOS_METHOD, { sessionId: created.sessionId });
			await waitFor(() => pi.clearTodosCalls === 1);
			await assert.rejects(
				cx.request(PIX_CLEAR_TODOS_METHOD, { sessionId: created.sessionId }),
				/session plan clear is unavailable while the agent is running/u,
			);
			gate.resolve();
			await first;

			pi.clearTodosError = new Error("clear failed");
			await assert.rejects(
				cx.request(PIX_CLEAR_TODOS_METHOD, { sessionId: created.sessionId }),
				/session plan clear failed: Error: clear failed/u,
			);
			pi.clearTodosError = undefined;
			await cx.request(PIX_CLEAR_TODOS_METHOD, { sessionId: created.sessionId });
			assert.equal(pi.clearTodosCalls, 3, "a failure must release the session guard");
		},
	);
});

test("Pix Desktop todo clear validates its target and rejects busy state without affecting other sessions", async () => {
	const harness = createTestAdapter();
	await connectAs(harness.adapter, "pix-desktop", async (cx) => {
		const first = await cx.request("session/new", { cwd: "/tmp/clear-first", mcpServers: [] }) as { sessionId: string };
		const second = await cx.request("session/new", { cwd: "/tmp/clear-second", mcpServers: [] }) as { sessionId: string };
		const pi = harness.clients[1]!;
		await assert.rejects(cx.request(PIX_CLEAR_TODOS_METHOD, {}));
		await assert.rejects(cx.request(PIX_CLEAR_TODOS_METHOD, { sessionId: "unknown" }), /unknown session/u);
		for (const busy of [{ isStreaming: true, isCompacting: false }, { isStreaming: false, isCompacting: true }]) {
			Object.assign(pi.state, busy);
			await assert.rejects(cx.request(PIX_CLEAR_TODOS_METHOD, { sessionId: second.sessionId }), /session is busy/u);
		}
		assert.equal(pi.clearTodosCalls, 0);
		Object.assign(pi.state, { isStreaming: false, isCompacting: false });
		await cx.request(PIX_CLEAR_TODOS_METHOD, { sessionId: second.sessionId });
		assert.equal(pi.clearTodosCalls, 1);
		assert.equal(harness.clients[0]!.clearTodosCalls, 0);
		assert.notEqual(first.sessionId, second.sessionId);
	});
});

test("Desktop fork_message persists child auto payload and opens only through fork_ready, never prompts the source", async () => {
	const saved = new Map<string, PersistedDesktopQueues>();
	let failNextWrite = false;
	const snapshots: DesktopForkSnapshot[] = [];
	const ready: Array<{ sourceSessionId: string; sessionId: string; cwd: string }> = [];
	const childPath = resolve(".pi/artifacts/desktop-fork-backend-20260723/transport-child.jsonl");
	const h = createTestAdapter({
		loadDesktopQueues: async (_cwd, path) => saved.get(path ?? "") ?? { auto: [], deferred: [] },
		saveDesktopQueues: async (_cwd, path, queues) => {
			if (failNextWrite) { failNextWrite = false; throw new Error("dequeue disk full"); }
			saved.set(path ?? "", structuredClone(queues));
		},
		createDesktopForkSnapshot: async (snapshot) => { snapshots.push(snapshot); return { sessionPath: childPath, piSessionId: "fork-child" }; },
	});
	await connectAs(h.adapter, "pix-desktop", async (cx) => {
		const source = await cx.request("session/new", { cwd: "/tmp/fork-transport", mcpServers: [] }) as { sessionId: string };
		const pi = h.clients[0]!;
		pi.entriesState.leafId = "idle-leaf";
		const response = await cx.request(PIX_FORK_MESSAGE_METHOD, { sessionId: source.sessionId,
			prompt: [{ type: "text", text: "child task" }, { type: "image", data: "abc", mimeType: "image/png" }], displayText: "child task" }) as { disposition: string; itemId: string };
		assert.equal(response.disposition, "fork");
		await waitFor(() => ready.length === 1);
		assert.equal(snapshots[0]?.leafId, "idle-leaf");
		assert.deepEqual(ready[0], { sourceSessionId: source.sessionId, sessionId: ready[0]!.sessionId, cwd: "/tmp/fork-transport" });
		assert.equal(h.clients.length, 1, "Desktop will load the child runtime; ACP must not spawn/prompt it");
		assert.equal(h.adapter.getSession(ready[0]!.sessionId), undefined);
		assert.deepEqual(pi.promptCalls, []); assert.deepEqual(pi.steerCalls, []);
		assert.equal(pi.aborts, 0); assert.equal(pi.pauses, 0);
		assert.equal(saved.get(childPath)?.auto[0]?.id, response.itemId);
		assert.deepEqual(saved.get(childPath)?.auto[0]?.images, [{ type: "image", data: "abc", mimeType: "image/png" }]);
		assert.deepEqual(saved.get(pi.state.sessionFile!)?.fork, []);
		const record = await new SessionMapStore(h.sessionMapPath, TEST_LOGGER).get(ready[0]!.sessionId);
		assert.equal(record?.piSessionPath, childPath);
		await cx.request("session/load", { sessionId: ready[0]!.sessionId, cwd: "/tmp/fork-transport", mcpServers: [], _meta: { "pix.lazyHistory": true } });
		failNextWrite = true;
		await assert.rejects(cx.request(PIX_TAKE_AUTO_MESSAGE_METHOD, { sessionId: ready[0]!.sessionId }), /Internal error/u);
		assert.equal(h.adapter.getSession(ready[0]!.sessionId)!.autoUserMessages[0]?.id, response.itemId);
		assert.equal(saved.get(childPath)?.auto[0]?.id, response.itemId, "failed dequeue keeps the child payload durable");
		const taken = await cx.request(PIX_TAKE_AUTO_MESSAGE_METHOD, { sessionId: ready[0]!.sessionId }) as { message?: DesktopQueuedUserMessage };
		assert.equal(taken.message?.id, response.itemId);
		assert.equal(h.clients[1]!.promptCalls.length, 0, "taking payload is separate from ordinary Desktop prompt flow");
	}, (app) => {
		(app as unknown as { onNotification(method: string, parser: (value: unknown) => unknown,
			handler: (ctx: { params: typeof ready[number] }) => void): void }).onNotification(
			PIX_FORK_READY_METHOD, (value) => value, (ctx) => { ready.push(ctx.params); });
	});
	await h.adapter.dispose();
});

test("Desktop running fork uses first turn_end including tool results before agent_settled", async () => {
	const snapshots: DesktopForkSnapshot[] = [];
	let release!: (child: DesktopForkChild) => void;
	const gate = new Promise<DesktopForkChild>((resolve) => { release = resolve; });
	const h = createTestAdapter({ loadDesktopQueues: async () => ({ auto: [], deferred: [] }), saveDesktopQueues: async () => {},
		createDesktopForkSnapshot: async (snapshot) => { snapshots.push(snapshot); return gate; } });
	await connectAs(h.adapter, "pix-desktop", async (cx) => {
		const source = await cx.request("session/new", { cwd: "/tmp/fork-turn-end", mcpServers: [] }) as { sessionId: string };
		const pi = h.clients[0]!; pi.state.isStreaming = true;
		await cx.request(PIX_FORK_MESSAGE_METHOD, { sessionId: source.sessionId, prompt: [{ type: "text", text: "parallel" }], displayText: "parallel" });
		assert.equal(snapshots.length, 0);
		pi.emit({ type: "turn_end", turnIndex: 0, message: { role: "assistant" }, toolResults: [],
			pixForkLeafId: "captured-tool-result", pixForkSessionPath: pi.state.sessionFile } as PiEvent);
		assert.equal(snapshots[0]?.leafId, "captured-tool-result", "starts synchronously at turn_end despite streaming source");
		pi.entriesState.leafId = "later-user";
		pi.emit({ type: "agent_settled", pixForkLeafId: "later-leaf", pixForkSessionPath: pi.state.sessionFile } as PiEvent);
		assert.equal(snapshots.length, 1);
		assert.equal(pi.promptCalls.length, 0); assert.equal(pi.steerCalls.length, 0); assert.equal(pi.aborts, 0); assert.equal(pi.pauses, 0);
		await cx.request("session/close", { sessionId: source.sessionId });
		release({ sessionPath: resolve(".pi/artifacts/desktop-fork-backend-20260723/stale-child.jsonl"), piSessionId: "stale-child" });
	});
	await h.adapter.dispose();
	assert.equal((await new SessionMapStore(h.sessionMapPath, TEST_LOGGER).list()).length, 1, "stale child is not registered");
});

test("Desktop fork rows reject send-now without injection; edit/cancel return and remove their persisted payload", async () => {
	const h = createTestAdapter({ loadDesktopQueues: async () => ({ auto: [], deferred: [] }), saveDesktopQueues: async () => {} });
	await connectAs(h.adapter, "pix-desktop", async (cx) => {
		const source = await cx.request("session/new", { cwd: "/tmp/fork-actions", mcpServers: [] }) as { sessionId: string };
		const pi = h.clients[0]!; pi.state.isStreaming = true;
		for (const action of ["edit", "cancel"] as const) {
			await cx.request(PIX_FORK_MESSAGE_METHOD, { sessionId: source.sessionId, prompt: [{ type: "text", text: "queued" }], displayText: "queued" });
			await assert.rejects(cx.request(PIX_QUEUE_ACTION_METHOD, { sessionId: source.sessionId, source: "fork", index: 0, text: "queued", action: "send-now" }), /send-now is not supported/u);
			const response = await cx.request(PIX_QUEUE_ACTION_METHOD, { sessionId: source.sessionId, source: "fork", index: 0, text: "queued", action }) as { message?: DesktopQueuedUserMessage };
			assert.equal(response.message?.promptText, action === "edit" ? "queued" : undefined);
			const state = await cx.request(PIX_QUEUE_STATE_METHOD, { sessionId: source.sessionId }) as DesktopQueueStateResponse;
			assert.deepEqual(state.items, []);
		}
		assert.equal(pi.aborts, 0); assert.equal(pi.steerCalls.length, 0); assert.equal(pi.promptCalls.length, 0);
	});
	await h.adapter.dispose();
});

test("Desktop reopening a source waits for its retired fork restoration before loading queues", async () => {
	const saved = new Map<string, PersistedDesktopQueues>();
	let restored = false;
	let sourcePath = "";
	let consuming!: () => void;
	const consumeStarted = new Promise<void>((done) => { consuming = done; });
	let release!: () => void;
	const consumeGate = new Promise<void>((done) => { release = done; });
	let gated = false;
	let creations = 0;
	const h = createTestAdapter({
		loadDesktopQueues: async (_cwd, path) => {
			if (path === sourcePath && gated) assert.equal(restored, true, "replacement cannot read before retired source restoration");
			return structuredClone(saved.get(path ?? "") ?? { auto: [], deferred: [], fork: [] });
		},
		saveDesktopQueues: async (_cwd, path, queues) => {
			const snapshot = structuredClone(queues);
			if (path === sourcePath && queues.fork?.length === 0 && !gated) {
				gated = true; consuming(); await consumeGate;
			}
			saved.set(path ?? "", snapshot);
			if (path === sourcePath && gated && queues.fork?.length === 1) restored = true;
		},
		createDesktopForkSnapshot: async () => {
			if (++creations > 1) throw new Error("reopened queue retained");
			return { sessionPath: resolve(".pi/artifacts/desktop-fork-backend-20260723/reopen-child.jsonl"), piSessionId: "reopen-child" };
		},
	});
	try {
		await connectAs(h.adapter, "pix-desktop", async (cx) => {
			const source = await cx.request("session/new", { cwd: "/tmp/fork-reopen", mcpServers: [] }) as { sessionId: string };
			const pi = h.clients[0]!;
			sourcePath = pi.state.sessionFile!;
			await cx.request(PIX_FORK_MESSAGE_METHOD, { sessionId: source.sessionId, prompt: [{ type: "text", text: "retain after reopen" }], displayText: "retain after reopen" });
			await consumeStarted;
			await cx.request("session/close", { sessionId: source.sessionId });
			await cx.request("session/load", { sessionId: source.sessionId, cwd: "/tmp/fork-reopen", mcpServers: [], _meta: { "pix.lazyHistory": true } });
			let hydrated = false;
			const hydration = cx.request(PIX_QUEUE_STATE_METHOD, { sessionId: source.sessionId }).then(() => { hydrated = true; });
			await Promise.resolve(); await Promise.resolve();
			assert.equal(hydrated, false, "queue hydration cannot publish an interim consumed queue");
			release();
			await hydration;
			await h.adapter.getSession(source.sessionId)!.forks.settled();
			const state = await cx.request(PIX_QUEUE_STATE_METHOD, { sessionId: source.sessionId }) as DesktopQueueStateResponse;
			assert.equal(state.items[0]?.text, "retain after reopen");
			assert.equal(saved.get(sourcePath)?.fork?.length, 1);
			assert.equal((await new SessionMapStore(h.sessionMapPath, TEST_LOGGER).list()).length, 1, "unpublished old child was removed");
		});
	} finally {
		release();
		await h.adapter.dispose();
	}
});

test("Desktop failed fork reports an editable/cancelable queue error and does not retry on settlement", async () => {
	let calls = 0;
	const h = createTestAdapter({ loadDesktopQueues: async () => ({ auto: [], deferred: [] }), saveDesktopQueues: async () => {},
		createDesktopForkSnapshot: async () => { calls++; throw new Error("snapshot disk full"); } });
	await connectAs(h.adapter, "pix-desktop", async (cx) => {
		const source = await cx.request("session/new", { cwd: "/tmp/fork-failure", mcpServers: [] }) as { sessionId: string };
		await cx.request(PIX_FORK_MESSAGE_METHOD, { sessionId: source.sessionId, prompt: [{ type: "text", text: "retain" }], displayText: "retain" });
		await h.adapter.getSession(source.sessionId)!.forks.settled();
		const state = await cx.request(PIX_QUEUE_STATE_METHOD, { sessionId: source.sessionId }) as DesktopQueueStateResponse;
		assert.equal(state.items[0]?.source, "fork"); assert.equal(state.items[0]?.error, "snapshot disk full");
		const pi = h.clients[0]!;
		pi.emit({ type: "agent_settled", pixForkLeafId: "later", pixForkSessionPath: pi.state.sessionFile } as PiEvent);
		assert.equal(calls, 1);
		const edit = await cx.request(PIX_QUEUE_ACTION_METHOD, { sessionId: source.sessionId, source: "fork", index: 0, text: "retain", action: "edit" }) as { message?: DesktopQueuedUserMessage };
		assert.equal(edit.message?.promptText, "retain");
	});
	await h.adapter.dispose();
});

test("Desktop source process exit invalidates a gated fork completion and never registers the child", async () => {
	let release!: (child: DesktopForkChild) => void;
	const gate = new Promise<DesktopForkChild>((resolve) => { release = resolve; });
	const h = createTestAdapter({ loadDesktopQueues: async () => ({ auto: [], deferred: [] }), saveDesktopQueues: async () => {},
		createDesktopForkSnapshot: async () => gate });
	await connectAs(h.adapter, "pix-desktop", async (cx) => {
		const source = await cx.request("session/new", { cwd: "/tmp/fork-exit", mcpServers: [] }) as { sessionId: string };
		await cx.request(PIX_FORK_MESSAGE_METHOD, { sessionId: source.sessionId, prompt: [{ type: "text", text: "pending" }], displayText: "pending" });
		await h.adapter.getSession(source.sessionId)!.forks.tryIdle();
		h.clients[0]!.emitExit(new Error("pi process exited"));
		release({ sessionPath: resolve(".pi/artifacts/desktop-fork-backend-20260723/exit-child.jsonl"), piSessionId: "exit-child" });
	});
	await h.adapter.dispose();
	assert.equal((await new SessionMapStore(h.sessionMapPath, TEST_LOGGER).list()).length, 1);
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
	assert.match(text, /Tools \(active\): repo\\_search, read, subagents/);
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

test("DCP compression stays extension-owned instead of invoking native Pi compaction", async () => {
	const harness = createTestAdapter();
	const created = await connect(harness.adapter, (cx) => cx.request("session/new", { cwd: "/tmp", mcpServers: [] }));
	const sessionId = (created as { sessionId: string }).sessionId;
	const pi = harness.clients[0]!;
	pi.promptHandledWithoutRun = true;

	const response = await connect(harness.adapter, (cx) => cx.request("session/prompt", {
		sessionId,
		prompt: [{ type: "text", text: "/dcp compress" }],
	})) as { stopReason: string };

	assert.equal(response.stopReason, "end_turn");
	assert.deepEqual(pi.promptCalls, [{ message: "/dcp compress", images: undefined }]);
	assert.deepEqual(pi.compactCalls, []);
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

test("thinking_level_changed pushes a config_option_update to the client", async () => {
	const notifications: SessionNotification[] = [];
	const harness = createTestAdapter();
	let sessionId = "";

	await connect(
		harness.adapter,
		async (cx) => {
			const created = await cx.request("session/new", { cwd: "/tmp", mcpServers: [] }) as { sessionId: string };
			sessionId = created.sessionId;
			const pi = harness.clients[0]!;
			// Simulate a server-side thinking change (todo-thinking override,
			// builtin /thinking, ...) that pi reports as a session event.
			await pi.setThinkingLevel("high");
			pi.emit({ type: "thinking_level_changed", level: "high" });
			await waitFor(() => notifications.some((item) => item.update.sessionUpdate === "config_option_update"));
		},
		(app) => {
			app.onNotification("session/update", (ctx) => { notifications.push(ctx.params); });
		},
	);

	const notification = notifications.find((item) => item.update.sessionUpdate === "config_option_update")!;
	assert.equal(notification.sessionId, sessionId);
	const configOptions = (notification.update as {
		configOptions: Array<{ id: string; currentValue: string }>;
	}).configOptions;
	const thoughtLevel = configOptions.find((option) => option.id === "thought_level");
	assert.equal(thoughtLevel?.currentValue, "high");
});

test("rapid thinking_level_changed events coalesce into one config_option_update push", async () => {
	const notifications: SessionNotification[] = [];
	const harness = createTestAdapter();

	await connect(
		harness.adapter,
		async (cx) => {
			await cx.request("session/new", { cwd: "/tmp", mcpServers: [] });
			const pi = harness.clients[0]!;
			await pi.setThinkingLevel("low");
			pi.emit({ type: "thinking_level_changed", level: "low" });
			await pi.setThinkingLevel("high");
			pi.emit({ type: "thinking_level_changed", level: "high" });
			await waitFor(() => notifications.some((item) => item.update.sessionUpdate === "config_option_update"));
			// Any superseded push that raced past its generation guard would
			// land here.
			await new Promise((resolve) => setTimeout(resolve, 20));
		},
		(app) => {
			app.onNotification("session/update", (ctx) => { notifications.push(ctx.params); });
		},
	);

	const pushes = notifications.filter((item) => item.update.sessionUpdate === "config_option_update");
	assert.equal(pushes.length, 1);
	const configOptions = (pushes[0]!.update as {
		configOptions: Array<{ id: string; currentValue: string }>;
	}).configOptions;
	const thoughtLevel = configOptions.find((option) => option.id === "thought_level");
	assert.equal(thoughtLevel?.currentValue, "high");
});

test("thinking_level_changed with unavailable pi state logs and skips the push", async () => {
	const notifications: SessionNotification[] = [];
	const harness = createTestAdapter();

	await connect(
		harness.adapter,
		async (cx) => {
			await cx.request("session/new", { cwd: "/tmp", mcpServers: [] });
			const pi = harness.clients[0]!;
			pi.stateError = new Error("state unavailable");
			pi.emit({ type: "thinking_level_changed", level: "high" });
			await new Promise((resolve) => setTimeout(resolve, 20));
		},
		(app) => {
			app.onNotification("session/update", (ctx) => { notifications.push(ctx.params); });
		},
	);

	assert.equal(notifications.some((item) => item.update.sessionUpdate === "config_option_update"), false);
});

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("waitFor timeout");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

test("Desktop brainstorm native load attaches the same owned runtime and blocks every direct writer", async () => {
	const spawned: PiRpcClientOptions[] = [];
	const pis: FakePiClient[] = [];
	const harness = createTestAdapter({
		toolsSuiteExtensionPath: fileURLToPath(new URL("../../external/pi-tools-suite/src/index.ts", import.meta.url)),
		createPiClient: (options) => {
			spawned.push(options);
			const pi = new FakePiClient({ model: { provider: options.provider ?? "zai", id: options.model ?? "exact" } });
			pis.push(pi);
			if (options.env?.PIX_BRAINSTORM_PARTICIPANT === "1") {
				pi.promptHandledWithoutRun = true;
				pi.promptHook = (text) => {
					pi.emit({ type: "agent_start" });
					const n = pi.promptCalls.length;
					pi.entriesState.entries.push({ id: `u-${n}`, type: "message", message: { role: "user", content: text } },
						{ id: `a-${n}`, type: "message", message: { role: "assistant", content: [{ type: "text", text: `answer ${n}` }], stopReason: "stop" } });
					pi.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }], willRetry: false } as PiEvent);
					pi.emit({ type: "agent_settled" });
				};
			}
			return pi;
		},
	});
	try {
		await connectAs(harness.adapter, "pix-desktop", async (cx) => {
			await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "pix-desktop", version: "test" } });
			const parent = await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [], _meta: { "pix.activityOwner": "parent-owner" } });
			const env = spawned[0]!.env!;
			assert.ok(env.PIX_BRAINSTORM_HOST_URL); assert.ok(env.PIX_BRAINSTORM_HOST_TOKEN);
			const send = (body: unknown) => fetch(env.PIX_BRAINSTORM_HOST_URL!, { method: "POST", headers: { Authorization: `Bearer ${env.PIX_BRAINSTORM_HOST_TOKEN}` }, body: JSON.stringify(body) });
			const body = (round: number) => ({ action: "round", runId: "native-test", runDir: "/tmp/brainstorm-test", topic: "topic", round,
				tasks: [{ id: `round-${round}-participant-1`, model: "zai/exact", task: `research ${round}`, thinking: "high", timeoutSeconds: 30 }] });
			const first = await (await send(body(1))).json() as { responses: { source: string; text: string }[]; missing: unknown[] };
			assert.deepEqual(first.missing, []); assert.equal(first.responses[0]?.text, "answer 1");
			const id = first.responses[0]!.source;
			const snapshot = harness.adapter.getSession(parent.sessionId)!.activitySnapshots.get("pi-tools-suite:brainstorm:state")!;
			assert.equal(snapshot.activityOwner, "parent-owner");
			assert.equal(spawned[1]!.env?.PIX_BRAINSTORM_HOST_TOKEN, "");
			await cx.request("session/load", { sessionId: parent.sessionId, cwd: "/tmp/proj", mcpServers: [], _meta: { "pix.activityOwner": "reattached-parent" } });
			assert.equal(spawned.length, 2); assert.equal(pis[1]!.started, true);
			assert.equal(harness.adapter.getSession(parent.sessionId)!.activityOwner, "reattached-parent");
			for (const lazy of [false, true]) {
				const loaded = await cx.request("session/load", { sessionId: id, cwd: "/tmp/proj", mcpServers: [], _meta: { "pix.lazyHistory": lazy } });
				assert.equal((loaded._meta?.["pix.brainstorm"] as { owned: boolean }).owned, true);
				assert.equal(spawned.length, 2); assert.equal(pis[1]!.started, true);
			}
			const listed = await cx.request("session/list", { cwd: "/tmp/proj" });
			assert.deepEqual(listed.sessions.find((s) => s.sessionId === id)?._meta?.["pix.brainstorm"], { runId: "native-test", parentSessionId: parent.sessionId, slot: 1, owned: true });
			await assert.rejects(cx.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "direct paid write" }] }), /owned/);
			await assert.rejects(cx.request("session/set_config_option", { sessionId: id, configId: "model", value: "zai/other" }), /owned/);
			await assert.rejects(cx.request("session/fork", { sessionId: id, cwd: "/tmp/proj", mcpServers: [] }), /owned/);
			await assert.rejects(cx.request("session/delete", { sessionId: id }), /owned/);
			await assert.rejects(cx.request("session/close", { sessionId: id }), /owned/);
			await assert.rejects(cx.request(PIX_QUEUE_MESSAGE_METHOD, { sessionId: id, prompt: [{ type: "text", text: "queued write" }], displayText: "queued write" }), /owned/);
			await assert.rejects(cx.request(PIX_AGENT_CONTROL_METHOD, { sessionId: id, action: "continue" }), /owned/);
			for (let n = 2; n <= 5; n++) {
				const result = await (await send(body(n))).json() as { responses: { source: string; text: string }[] };
				assert.equal(result.responses[0]?.source, id); assert.equal(result.responses[0]?.text, `answer ${n}`);
			}
			assert.equal(pis[1]!.promptCalls.length, 5); assert.equal(spawned.length, 2);
			assert.equal((await send({ action: "finish", runId: "native-test", status: "complete" })).status, 200);
			assert.equal(pis[1]!.started, false);
			const record = await new SessionMapStore(harness.sessionMapPath, TEST_LOGGER).get(id);
			assert.equal(record?.brainstorm?.owned, false);
		});
	} finally { await harness.adapter.dispose(); }
});

test("owned brainstorm records never resume or acquire a second writer after host session loss", async () => {
	const { adapter, clients, sessionMapPath } = createTestAdapter();
	try {
		await new SessionMapStore(sessionMapPath, TEST_LOGGER).put({ sessionId: "lost-participant", piSessionId: "pi-lost", piSessionPath: "/tmp/lost.jsonl", cwd: "/tmp/proj", updatedAt: new Date().toISOString(),
			brainstorm: { runId: "lost-run", parentSessionId: "lost-parent", slot: 1, owned: true } });
		await connect(adapter, async (cx) => {
			await assert.rejects(cx.request("session/load", { sessionId: "lost-participant", cwd: "/tmp/proj", mcpServers: [] }), /lost/);
			await assert.rejects(cx.request("session/prompt", { sessionId: "lost-participant", prompt: [{ type: "text", text: "write" }] }), /owned/);
		});
		assert.equal(clients.length, 0);
	} finally { await adapter.dispose(); }
});

for (const failure of ["substituted model", "missing persistence"] as const) test(`brainstorm rejects ${failure} before any participant prompt`, async () => {
	const spawned: PiRpcClientOptions[] = [], pis: FakePiClient[] = [];
	const { adapter } = createTestAdapter({
		toolsSuiteExtensionPath: fileURLToPath(new URL("../../external/pi-tools-suite/src/index.ts", import.meta.url)),
		createPiClient: (options) => {
			spawned.push(options);
			const pi = new FakePiClient({ model: { provider: "zai", id: failure === "substituted model" ? "substituted" : "exact" } });
			if (failure === "missing persistence" && options.env?.PIX_BRAINSTORM_PARTICIPANT === "1") {
				const { sessionFile: _file, ...state } = pi.state;
				pi.state = state;
			}
			pis.push(pi); return pi;
		},
	});
	try {
		await connectAs(adapter, "pix-desktop", async (cx) => {
			await cx.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: "pix-desktop", version: "test" } });
			await cx.request("session/new", { cwd: "/tmp/proj", mcpServers: [] });
			const env = spawned[0]!.env!;
			const response = await fetch(env.PIX_BRAINSTORM_HOST_URL!, { method: "POST", headers: { Authorization: `Bearer ${env.PIX_BRAINSTORM_HOST_TOKEN}` }, body: JSON.stringify({
				action: "round", runId: "exact-model-test", runDir: "/tmp/brainstorm-test", topic: "topic", round: 1,
				tasks: [{ id: "round-1-participant-1", model: "zai/exact", task: "research", thinking: "high", timeoutSeconds: 30 }],
			}) });
			const result = await response.json() as { responses: unknown[]; missing: { reason: string }[] };
			assert.equal(result.responses.length, 0); assert.match(result.missing[0]!.reason, failure === "substituted model" ? /no fallback/ : /no persisted session file/);
			assert.equal(pis[1]!.promptCalls.length, 0); assert.equal(pis[1]!.started, false); assert.equal(spawned.length, 2);
		});
	} finally { await adapter.dispose(); }
});
