/**
 * Thin wrapper around the pi coding agent JSONL RPC client.
 *
 * The adapter spawns pi's Node-readable RPC entry (one process per ACP
 * session) and talks JSON-RPC over its stdio. This wrapper keeps the rest of the adapter decoupled
 * from the SDK surface so the event mapping can evolve independently.
 */

import type { Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
	RpcClient,
	type JsonAgentSessionEvent,
	type RpcClientOptions,
	type RpcEventListener,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";

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
export type PiEvent = JsonAgentSessionEvent | RpcExtensionUIRequest;

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
}

/**
 * Minimal structural view of `CompactionResult` returned by `compact`.
 */
export interface PiCompactionResult {
	readonly summary: string;
	readonly tokensBefore: number;
	readonly estimatedTokensAfter?: number | undefined;
}

/**
 * Structural subset of pi `AgentMessage` used for session history replay.
 *
 * `role` is kept loose because pi's `AgentMessage` union also contains
 * extension-declared custom messages; anything we do not understand is
 * ignored by the replay translator.
 */
export type PiAgentMessage =
	| { readonly role: "user"; readonly content: string | readonly PiMessagePart[] }
	| { readonly role: "assistant"; readonly content: readonly PiMessagePart[] }
	| { readonly role: string; readonly content?: unknown };

/** One content part of a pi message: `text` parts replay as message chunks,
 * `toolCall` parts as tool calls; other part types are skipped. */
export interface PiMessagePart {
	readonly type: string;
	readonly text?: string | undefined;
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
	steer(message: string, images?: PiImageContent[]): Promise<void>;
	followUp(message: string, images?: PiImageContent[]): Promise<void>;
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
	/** Messages of the active branch, oldest first. */
	getMessages(): Promise<PiAgentMessage[]>;
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
	private client: RpcClient | undefined;
	private readonly options: RpcClientOptions;
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
		await client.start();
		this.watchExit(client);
	}

	async stop(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		if (client) await client.stop();
	}

	onEvent(listener: PiEventListener): () => void {
		const client = this.client;
		if (!client) throw new Error("PiRpcClient.onEvent called before start()");
		// A listener accepting the wider PiEvent satisfies RpcEventListener
		// because JsonAgentSessionEvent is a subset of PiEvent; extension UI
		// requests arrive through the same stdout line stream.
		return client.onEvent(listener as RpcEventListener);
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
	 * The SDK `RpcClient` (pinned 0.84.4) rejects pending requests on exit
	 * but exposes no disconnect event, so the exit is observed on the private
	 * child process handle — the same handle `respondToExtensionUi` uses.
	 */
	private watchExit(client: RpcClient): void {
		// Double cast: `process` is private on RpcClient (pinned 0.84.4), and
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

	prompt(message: string, images?: PiImageContent[]): Promise<void> {
		return this.requireClient().prompt(message, images);
	}

	steer(message: string, images?: PiImageContent[]): Promise<void> {
		return this.requireClient().steer(message, images);
	}

	followUp(message: string, images?: PiImageContent[]): Promise<void> {
		return this.requireClient().followUp(message, images);
	}

	abort(): Promise<void> {
		return this.requireClient().abort();
	}

	/**
	 * Answer a dialog `extension_ui_request`.
	 *
	 * The pi RPC protocol accepts `extension_ui_response` lines on stdin, but
	 * `RpcClient` (pinned 0.84.4) has no public API for them, so this writes
	 * directly to the child process stdin. Unknown ids are ignored by pi.
	 */
	respondToExtensionUi(response: RpcExtensionUIResponse): void {
		// Double cast: `process` is private on RpcClient (pinned 0.84.4), and
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

	async getMessages(): Promise<PiAgentMessage[]> {
		// Cast through unknown: pi's AgentMessage union includes custom
		// message types this adapter intentionally models loosely.
		return (await this.requireClient().getMessages()) as unknown as PiAgentMessage[];
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
	if (options.env) sdkOptions.env = options.env;
	return sdkOptions;
}

/** Last lines of collected stderr, formatted for an error message. */
function tailForLog(stderr: string): string {
	const trimmed = stderr.trim();
	if (!trimmed) return "";
	const tail = trimmed.split("\n").slice(-3).join("\n");
	return `\npi stderr tail:\n${tail}`;
}
