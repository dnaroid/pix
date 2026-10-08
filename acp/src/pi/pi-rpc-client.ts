/**
 * Thin wrapper around the pi coding agent JSONL RPC client.
 *
 * The adapter spawns pi's Node-readable RPC entry (one process per ACP
 * session) and talks JSON-RPC over its stdio. This wrapper keeps the rest of the adapter decoupled
 * from the SDK surface so the event mapping can evolve independently.
 */

import type { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { parseBtwState, type BtwCommand, type BtwEvent, type BtwState } from "../btw/contract.js";
import {
	RpcClient,
	type JsonAgentSessionEvent,
	type RpcClientOptions,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";

const PIX_PAUSE_MESSAGE = "\u0000pix:agent-control:pause";
const PIX_CANCEL_PAUSE_MESSAGE = "\u0000pix:agent-control:cancel-pause";
const PIX_CONTINUE_MESSAGE = "\u0000pix:agent-control:continue";
const PIX_LSP_CONTROL_PREFIX = "\u0000pix:lsp-control:";
const PIX_BTW_RPC_PREFIX = "\u0000pix:btw:";

export interface PiLspControlSnapshot {
	readonly servers: Array<{ id: string; root: string; state: "stopped" | "starting" | "running" | "stopping" | "failed"; pid?: number; error?: string }>;
	readonly warnings: string[];
	readonly trustRequired?: boolean;
}

/**
 * Image attachment passed through to `pi` RPC prompt/steer/follow_up.
 *
 * Structurally identical to `ImageContent` from `@earendil-works/pi-ai`
 * (which `RpcClient.prompt()` accepts); declared locally because the pi
 * package does not re-export that type from its root.
 */
export interface PiImageContent {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

/**
 * Events a pi RPC process can emit: agent session events plus extension UI
 * requests (`ctx.ui.*` dialogs from extensions, delivered over stdout).
 */
export type PiEvent = ((JsonAgentSessionEvent | RpcExtensionUIRequest) & {
	readonly pixForkLeafId?: string | null;
	readonly pixForkSessionPath?: string;
}) | { readonly type: "pix_btw_event"; readonly data: BtwEvent };

export type PiEventListener = (event: PiEvent) => void;

/** Type guard for extension UI requests arriving in the pi event stream. */
export function isExtensionUiRequest(event: PiEvent): event is RpcExtensionUIRequest {
	return (event as { type?: unknown }).type === "extension_ui_request";
}

export interface PiRpcClientOptions {
	/** Path to pi's JavaScript RPC entry (from AdapterConfig.piEntry). */
	readonly piEntry: string;
	/** Working directory for the agent session (ACP session cwd). */
	readonly cwd: string;
	/** Explicit startup model for a brand-new Pix session. */
	readonly provider?: string | undefined;
	readonly model?: string | undefined;
	readonly args?: readonly string[] | undefined;
	readonly env?: Record<string, string> | undefined;
}

/**
 * Minimal structural view of a pi model (subset of `Model` from pi-ai).
 */
export interface PiModel {
	readonly provider: string;
	readonly id: string;
	readonly name?: string | undefined;
	readonly reasoning?: boolean | undefined;
	readonly thinkingLevelMap?: Partial<Record<string, string | null>> | undefined;
}

/**
 * Minimal structural view of `RpcSessionState` returned by `get_state`.
 */
export interface PiSessionState {
	readonly model?: PiModel | undefined;
	readonly thinkingLevel: string;
	readonly sessionFile?: string | undefined;
	readonly sessionId: string;
	readonly sessionName?: string | undefined;
	readonly isStreaming: boolean;
	readonly isCompacting?: boolean | undefined;
	readonly autoCompactionEnabled?: boolean | undefined;
	readonly steeringMode?: "all" | "one-at-a-time" | undefined;
	readonly followUpMode?: "all" | "one-at-a-time" | undefined;
	readonly messageCount?: number | undefined;
	readonly pendingMessageCount?: number | undefined;
}

/**
 * Minimal structural view of `CompactionResult` returned by `compact`.
 */
export interface PiCompactionResult {
	readonly summary: string;
	readonly tokensBefore: number;
	readonly estimatedTokensAfter?: number | undefined;
}

/** Result of a user `!` / `!!` shell execution through pi RPC. */
export type PiBashResult = Awaited<ReturnType<RpcClient["bash"]>>;

/** Runtime slash command discovered by pi (extension, prompt, or skill). */
export interface PiSlashCommand {
	readonly name: string;
	readonly description?: string | undefined;
	readonly source: "extension" | "prompt" | "skill";
	readonly sourceInfo: unknown;
}

/**
 * Structural view of a persisted session entry.
 *
 * Kept loose on purpose: pi's entry union evolves between versions, and the
 * ACP agent only reads well-known optional fields (`id`, `parentId`, `type`).
 */
export type PiSessionEntry = Record<string, unknown> & {
	readonly id?: string | undefined;
	readonly type?: string | undefined;
	readonly parentId?: string | null | undefined;
};

/** Session statistics exposed by pi's public RPC client. */
export type PiSessionStats = Awaited<ReturnType<RpcClient["getSessionStats"]>> & {
	/** Proven current tree identity; injected by Pix's bridge, never a message offset. */
	readonly pixSearchLeafId?: string | null;
	readonly pixSearchSessionPath?: string;
	/** Live DCP estimate injected by Pix's RPC entry when the DCP extension is active. */
	readonly pixDcpTokensSaved?: number | undefined;
	/** Live DCP context-map snapshot injected by Pix's RPC entry. */
	readonly pixDcpContextMap?: PiDcpContextMap | undefined;
	/**
	 * Latest Anthropic API-key response rate-limit headers observed by Pix's
	 * RPC entry for this session's current model. Absent when the provider is
	 * not Anthropic, uses subscription auth, or no response has been seen yet.
	 */
	readonly pixAnthropicUsage?: PiAnthropicUsageRecord | undefined;
};

/**
 * Raw provider response-header observation for Anthropic API-key usage.
 *
 * Transported unparsed so header→window mapping stays owned by the shared
 * Pix model-usage module; the ACP agent parses and caches per session.
 */
export interface PiAnthropicUsageRecord {
	/** `${provider}/${modelId}` of the model whose response carried the headers. */
	readonly modelKey: string;
	/** HTTP status of the observed provider response. */
	readonly status: number;
	/** Bounded `anthropic-ratelimit-*` response headers (lowercase names). */
	readonly headers: Record<string, string>;
	/** Epoch milliseconds when the response was received. */
	readonly receivedAt: number;
}

export interface PiDcpContextMap {
	readonly revision: number;
	readonly sessionEpoch: number;
	readonly generatedAt: number;
	readonly tokenEstimates: {
		readonly candidate: number;
		readonly protected: number;
		readonly compressed: number;
		readonly retained: number;
	};
}

/**
 * Structural subset of pi `AgentMessage` used for session history replay.
 *
 * `role` is kept loose because pi's `AgentMessage` union also contains
 * extension-declared custom messages; anything we do not understand is
 * ignored by the replay translator.
 */
type PiAgentMessageTiming = {
	/** Provider/message creation timestamp persisted by pi, when present. */
	readonly timestamp?: number | undefined;
	/** Internal replay annotation: when the enclosing session entry was persisted. */
	readonly persistedAtMs?: number | undefined;
};

export type PiAgentMessage = (
	| { readonly role: "user"; readonly content: string | readonly PiMessagePart[] }
	| { readonly role: "assistant"; readonly content: readonly PiMessagePart[] }
	| { readonly role: string; readonly content?: unknown }
) & PiAgentMessageTiming;

/** One content part of a pi message used for session-history replay. */
export interface PiMessagePart {
	readonly type: string;
	readonly text?: string | undefined;
	readonly thinking?: string | undefined;
	readonly data?: string | undefined;
	readonly mimeType?: string | undefined;
	readonly id?: string | undefined;
	readonly name?: string | undefined;
	readonly arguments?: Record<string, unknown> | undefined;
}

/**
 * The subset of the pi RPC surface the ACP agent depends on.
 *
 * `PiRpcClient` is the production implementation; tests inject fakes that
 * satisfy this interface, so no `pi` process is ever spawned in tests.
 */
export interface PiClient {
	start(): Promise<void>;
	stop(): Promise<void>;
	onEvent(listener: PiEventListener): () => void;
	/**
	 * Observe the pi process dying (crash or graceful exit). The listener is
	 * invoked at most once, after which no further events can arrive; it lets
	 * the agent fail in-flight prompts instead of waiting for `agent_settled`
	 * events that will never come.
	 */
	onExit(listener: (error: Error) => void): () => void;
	prompt(message: string, images?: PiImageContent[]): Promise<void>;
	/** Execute the supported todo clear extension command without creating a user message. */
	clearTodos(): Promise<void>;
	/** Run the LSP control extension command without adding a user message. */
	lspControl?(action: "status", id?: string, root?: string): Promise<PiLspControlSnapshot>;
	/** Desktop-only temporary, tool-less side chat; never enters the parent prompt queue. */
	btw?(command: BtwCommand): Promise<BtwState>;
	bash(command: string, excludeFromContext?: boolean): Promise<PiBashResult>;
	/** Request a graceful stop at the next agent turn boundary. */
	pause(): Promise<void>;
	/** Withdraw a pending pause; never resume a boundary that has already stopped. */
	cancelPause(): Promise<void>;
	/** Continue an idle agent whose transcript ends at a resumable boundary. */
	continue(): Promise<void>;
	steer(message: string, images?: PiImageContent[]): Promise<void>;
	followUp(message: string, images?: PiImageContent[]): Promise<void>;
	clearQueue(): Promise<{ steering: string[]; followUp: string[] }>;
	abort(): Promise<void>;
	/** Answer a dialog `extension_ui_request` (select/confirm/input/editor). */
	respondToExtensionUi(response: RpcExtensionUIResponse): void;

	// Session lifecycle -----------------------------------------------------
	/** Current session state (model, thinking level, session file). */
	getState(): Promise<PiSessionState>;
	/** Switch the pi process to another session file. */
	switchSession(sessionPath: string): Promise<{ cancelled: boolean }>;
	/** Clone the current active branch into a new session. */
	clone(): Promise<{ cancelled: boolean }>;
	/** Fork into a new session before a specific user-message entry. */
	fork(entryId: string): Promise<{ text: string; cancelled: boolean }>;
	/** User messages that may be used as fork points. */
	getForkMessages(): Promise<Array<{ entryId: string; text: string }>>;
	/**
	 * Persisted session entries in append order, plus the active leaf.
	 *
	 * Preferred over the SDK's nested `getTree()`: deeply chained sessions
	 * (multi-thousand linear entries) make the tree response recurse past
	 * V8's default stack during serialization and fail with `Maximum call
	 * stack size exceeded`, while the flat entries response stays safe.
	 */
	getEntries(): Promise<{ entries: readonly PiSessionEntry[]; leafId: string | null }>;
	/** Plain text of the latest assistant message, if one exists. */
	getLastAssistantText(): Promise<string | null>;
	/** Messages of the active branch, oldest first. */
	getMessages(): Promise<PiAgentMessage[]>;
	/** Aggregate message, token, and cost statistics for the active session. */
	getSessionStats(): Promise<PiSessionStats>;
	/** Extension commands, prompt templates, and skills available to this process. */
	getCommands(): Promise<PiSlashCommand[]>;
	/** Set the session display name. */
	setSessionName(name: string): Promise<void>;

	// Configuration ---------------------------------------------------------
	getAvailableModels(): Promise<PiModel[]>;
	getAvailableThinkingLevels(): Promise<string[]>;
	setModel(provider: string, modelId: string): Promise<PiModel>;
	cycleModel(): Promise<{ model: PiModel; thinkingLevel: string } | null>;
	setThinkingLevel(level: string): Promise<void>;
	setAutoCompaction(enabled: boolean): Promise<void>;
	setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void>;
	setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void>;
	compact(customInstructions?: string): Promise<PiCompactionResult>;
	exportHtml(outputPath?: string): Promise<{ path: string }>;
}

export class PiRpcClient implements PiClient {
	private lspRequestId = 0;
	private btwRequestId = 0;
	private client: RpcClient | undefined;
	private readonly options: RpcClientOptions;
	private readonly eventListeners = new Set<PiEventListener>();
	private unsubscribeClientEvents: (() => void) | undefined;
	private readonly exitListeners = new Set<(error: Error) => void>();
	private exitError: Error | undefined;

	constructor(options: PiRpcClientOptions) {
		this.options = toSdkOptions(options);
	}

	get running(): boolean {
		return this.client !== undefined;
	}

	async start(): Promise<void> {
		if (this.client) return;
		const client = new RpcClient(this.options);
		this.client = client;
		// Subscribe before spawning: extensions can emit session_start UI events
		// during RpcClient.start(), before the ACP session/new response exists.
		this.unsubscribeClientEvents = client.onEvent((event) => {
			const type = (event as { type?: unknown }).type;
			// Control responses are correlated by their caller and must not leak
			// into ACP's general event-to-transcript translation.
			if (type === "pix_lsp_response" || type === "pix_btw_response") return;
			for (const listener of this.eventListeners) listener(event as PiEvent);
		});
		try {
			await client.start();
		} catch (error) {
			this.unsubscribeClientEvents?.();
			this.unsubscribeClientEvents = undefined;
			this.client = undefined;
			throw error;
		}
		this.watchExit(client);
	}

	async stop(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		this.unsubscribeClientEvents?.();
		this.unsubscribeClientEvents = undefined;
		if (client) await client.stop();
	}

	onEvent(listener: PiEventListener): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onExit(listener: (error: Error) => void): () => void {
		if (this.exitError) {
			// The process is already gone; replay the exit instead of
			// silently dropping the subscription.
			const error = this.exitError;
			queueMicrotask(() => listener(error));
			return () => {};
		}
		this.exitListeners.add(listener);
		return () => {
			this.exitListeners.delete(listener);
		};
	}

	/**
	 * Fail in-flight work when the pi child process dies.
	 *
	 * The SDK `RpcClient` rejects pending requests on exit
	 * but exposes no disconnect event, so the exit is observed on the private
	 * child process handle — the same handle `respondToExtensionUi` uses.
	 */
	private watchExit(client: RpcClient): void {
		// Double cast: `process` is private on RpcClient, and
		// an intersection with a private property collapses to `never`.
		const child = (client as unknown as { process?: ChildProcess | null }).process;
		if (!child) return;
		child.once("exit", (code: number | null, signal: string | null) => {
			const tail = tailForLog(client.getStderr());
			const detail = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
			const error = new Error(`pi process exited unexpectedly (${detail})${tail}`);
			this.exitError = error;
			for (const listener of this.exitListeners) listener(error);
			this.exitListeners.clear();
		});
	}

	async prompt(message: string, images?: PiImageContent[]): Promise<void> {
		await this.requireClient().prompt(message, images);
	}

	async clearTodos(): Promise<void> {
		const rawClient = this.requireClient() as unknown as {
			send(command: { type: "prompt"; message: string }): Promise<unknown>;
			getData<T>(response: unknown): T;
		};
		const response = await rawClient.send({ type: "prompt", message: "\u0000pix:clear-todos" });
		rawClient.getData<Record<string, never>>(response);
	}

	async lspControl(action: "status", id?: string, root?: string): Promise<PiLspControlSnapshot> {
		if (action !== "status") throw new Error("LSP monitoring only supports status");
		const rawClient = this.requireClient() as unknown as {
			send(command: { type: "prompt"; message: string }): Promise<unknown>;
			getData<T>(response: unknown): T;
			onEvent(listener: (event: unknown) => void): () => void;
		};
		const requestId = `${Date.now().toString(36)}-${(++this.lspRequestId).toString(36)}`;
		let snapshot: PiLspControlSnapshot | undefined;
		const unsubscribe = rawClient.onEvent((event) => {
			if (!event || typeof event !== "object") return;
			const value = event as { type?: unknown; requestId?: unknown; snapshot?: unknown };
			if (value.type === "pix_lsp_response" && value.requestId === requestId && value.snapshot && typeof value.snapshot === "object") {
				snapshot = value.snapshot as PiLspControlSnapshot;
			}
		});
		try {
			const response = await rawClient.send({ type: "prompt", message: `${PIX_LSP_CONTROL_PREFIX}${JSON.stringify({ requestId, action, ...(id === undefined ? {} : { id }), ...(root === undefined ? {} : { root }) })}` });
			rawClient.getData<Record<string, never>>(response);
			if (!snapshot) throw new Error("LSP control command returned no correlated snapshot");
			return snapshot;
		} finally {
			unsubscribe();
		}
	}

	async btw(command: BtwCommand): Promise<BtwState> {
		const rawClient = this.requireClient() as unknown as {
			send(command: { type: "prompt"; message: string }): Promise<unknown>;
			getData<T>(response: unknown): T;
			onEvent(listener: (event: unknown) => void): () => void;
		};
		const rpcId = `${Date.now().toString(36)}-${(++this.btwRequestId).toString(36)}`;
		let state: BtwState | undefined;
		const unsubscribe = rawClient.onEvent((event) => {
			if (!event || typeof event !== "object") return;
			const response = event as { type?: unknown; rpcId?: unknown; state?: unknown };
			if (response.type !== "pix_btw_response" || response.rpcId !== rpcId) return;
			try { state = parseBtwState(response.state); } catch { /* prompt response reports the malformed host result */ }
		});
		try {
			const response = await rawClient.send({ type: "prompt", message: `${PIX_BTW_RPC_PREFIX}${JSON.stringify({ rpcId, command })}` });
			rawClient.getData<Record<string, never>>(response);
			if (!state) throw new Error("BTW control returned no correlated state");
			return state;
		} finally {
			unsubscribe();
		}
	}

	async bash(command: string, excludeFromContext = false): Promise<PiBashResult> {
		const client = this.requireClient();
		if (!excludeFromContext) return client.bash(command);

		// The raw pi RPC protocol already supports excludeFromContext on bash,
		// matching the TUI's `!!` behavior, but the pinned RpcClient.bash()
		// wrapper does not expose that option yet.
		const rawClient = client as unknown as {
			send(command: { type: "bash"; command: string; excludeFromContext: boolean }): Promise<unknown>;
			getData<T>(response: unknown): T;
		};
		const response = await rawClient.send({ type: "bash", command, excludeFromContext: true });
		return rawClient.getData<PiBashResult>(response);
	}

	async pause(): Promise<void> {
		await this.requireClient().prompt(PIX_PAUSE_MESSAGE);
	}

	async cancelPause(): Promise<void> {
		await this.requireClient().prompt(PIX_CANCEL_PAUSE_MESSAGE);
	}

	async continue(): Promise<void> {
		await this.requireClient().prompt(PIX_CONTINUE_MESSAGE);
	}

	async steer(message: string, images?: PiImageContent[]): Promise<void> {
		await this.requireClient().steer(message, images);
	}

	async followUp(message: string, images?: PiImageContent[]): Promise<void> {
		await this.requireClient().followUp(message, images);
	}

	clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		return this.requireClient().clearQueue();
	}

	abort(): Promise<void> {
		return this.requireClient().abort();
	}

	/**
	 * Answer a dialog `extension_ui_request`.
	 *
	 * The pi RPC protocol accepts `extension_ui_response` lines on stdin, but
	 * `RpcClient` has no public API for them, so this writes
	 * directly to the child process stdin. Unknown ids are ignored by pi.
	 */
	respondToExtensionUi(response: RpcExtensionUIResponse): void {
		// Double cast: `process` is private on RpcClient, and
		// an intersection with a private property collapses to `never`.
		const client = this.requireClient() as unknown as {
			process?: { stdin?: Writable | null } | null;
		};
		const stdin = client.process?.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) {
			throw new Error("pi process stdin is not writable; cannot answer extension UI request");
		}
		stdin.write(`${JSON.stringify(response)}\n`);
	}

	getState(): Promise<PiSessionState> {
		return this.requireClient().getState();
	}

	switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		return this.requireClient().switchSession(sessionPath);
	}

	clone(): Promise<{ cancelled: boolean }> {
		return this.requireClient().clone();
	}

	fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		return this.requireClient().fork(entryId);
	}

	getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		return this.requireClient().getForkMessages();
	}

	async getEntries(): Promise<{ entries: readonly PiSessionEntry[]; leafId: string | null }> {
		return await this.requireClient().getEntries() as unknown as {
			entries: readonly PiSessionEntry[];
			leafId: string | null;
		};
	}

	getLastAssistantText(): Promise<string | null> {
		return this.requireClient().getLastAssistantText();
	}

	async getMessages(): Promise<PiAgentMessage[]> {
		// Cast through unknown: pi's AgentMessage union includes custom
		// message types this adapter intentionally models loosely.
		return (await this.requireClient().getMessages()) as unknown as PiAgentMessage[];
	}

	getSessionStats(): Promise<PiSessionStats> {
		return this.requireClient().getSessionStats();
	}

	async getCommands(): Promise<PiSlashCommand[]> {
		return this.requireClient().getCommands();
	}

	setSessionName(name: string): Promise<void> {
		return this.requireClient().setSessionName(name);
	}

	async getAvailableModels(): Promise<PiModel[]> {
		return this.requireClient().getAvailableModels();
	}

	async getAvailableThinkingLevels(): Promise<string[]> {
		return this.requireClient().getAvailableThinkingLevels();
	}

	async setModel(provider: string, modelId: string): Promise<PiModel> {
		return this.requireClient().setModel(provider, modelId);
	}

	async cycleModel(): Promise<{ model: PiModel; thinkingLevel: string } | null> {
		return this.requireClient().cycleModel();
	}

	async setThinkingLevel(level: string): Promise<void> {
		// pi types the parameter as a closed literal union; the literal
		// union below is structurally identical and safe to cast through.
		type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
		return this.requireClient().setThinkingLevel(level as PiThinkingLevel);
	}

	setAutoCompaction(enabled: boolean): Promise<void> {
		return this.requireClient().setAutoCompaction(enabled);
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		return this.requireClient().setSteeringMode(mode);
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		return this.requireClient().setFollowUpMode(mode);
	}

	async compact(customInstructions?: string): Promise<PiCompactionResult> {
		return this.requireClient().compact(customInstructions);
	}

	exportHtml(outputPath?: string): Promise<{ path: string }> {
		return this.requireClient().exportHtml(outputPath);
	}

	private requireClient(): RpcClient {
		const client = this.client;
		if (!client) throw new Error("PiRpcClient method called before start()");
		return client;
	}
}

function toSdkOptions(options: PiRpcClientOptions): RpcClientOptions {
	// exactOptionalPropertyTypes: never assign explicit undefined.
	const sdkOptions: RpcClientOptions = {
		cliPath: options.piEntry,
		cwd: options.cwd,
	};
	if (options.provider) sdkOptions.provider = options.provider;
	if (options.model) sdkOptions.model = options.model;
	if (options.args) sdkOptions.args = [...options.args];
	// RpcClient overlays env on process.env: a new session must not accidentally
	// inherit another ACP session's brainstorm capability.
	sdkOptions.env = { PIX_BRAINSTORM_HOST_URL: "", PIX_BRAINSTORM_HOST_TOKEN: "", ...options.env };
	return sdkOptions;
}

/** Last lines of collected stderr, formatted for an error message. */
function tailForLog(stderr: string): string {
	const trimmed = stderr.trim();
	if (!trimmed) return "";
	const tail = trimmed.split("\n").slice(-3).join("\n");
	return `\npi stderr tail:\n${tail}`;
}
