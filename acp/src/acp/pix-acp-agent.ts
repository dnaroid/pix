/**
 * The ACP agent: wires ACP protocol methods (Zed Agent Panel and other ACP
 * clients) to pi sessions.
 *
 * Implemented roadmap steps:
 * - step 1 (prompt pipeline): each `session/new` spawns a `pi --mode rpc`
 *   process; `session/prompt` forwards text/image content and resolves when
 *   the pi run settles; `session/cancel` aborts the run.
 * - step 2 (event translation): `event-translator.ts` streams `session/update`
 *   notifications for messages, thoughts and tool calls.
 * - step 3 (extension UI bridge): `ui-request-bridge.ts` maps pi extension
 *   dialogs onto ACP elicitations.
 * - step 4 (sessions & config): `session-map.ts` persists ACP↔pi session ids
 *   for `session/list`/`load`/`resume`/`fork`/`delete`; `config-options.ts`
 *   exposes model/thought-level selectors via `session/set_config_option`;
 *   `slash-commands.ts` intercepts pi TUI built-ins (/compact, /name, ...)
 *   inside `session/prompt`.
 */

import { randomUUID } from "node:crypto";
import {
	PROTOCOL_VERSION,
	RequestError,
	agent,
	type AgentApp,
	type AgentConnection,
	type ClientCapabilities,
	type ContentBlock,
	type CreateElicitationRequest,
	type CreateElicitationResponse,
	type ForkSessionRequest,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type NewSessionResponse,
	type PromptRequest,
	type PromptResponse,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SessionConfigOption,
	type SessionInfo,
	type SessionNotification,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type StopReason,
	type Stream,
} from "@agentclientprotocol/sdk";
import type { JsonAgentSessionEvent, RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
import type { Logger } from "../logging.js";
import { stringifyUnknown } from "../stringify-unknown.js";
import {
	isExtensionUiRequest,
	type PiClient,
	type PiEvent,
	type PiImageContent,
	type PiRpcClientOptions,
} from "../pi/pi-rpc-client.js";
import { applyConfigOption, buildConfigOptions, parseModelValue } from "./config-options.js";
import { EventTranslator } from "./event-translator.js";
import {
	builtinFeedback,
	builtinUsageError,
	parseBuiltinCommand,
	type BuiltinCommand,
} from "./slash-commands.js";
import { SessionMapStore } from "./session-map.js";
import { replaySessionHistory } from "./session-replay.js";
import { cancelledResponse, fromElicitationResponse, toElicitationRequest } from "./ui-request-bridge.js";

/** Minimal shape of the handler `client` context used for notifications and elicitations. */
type ClientCaller = {
	notify(method: "session/update", params: SessionNotification): Promise<void>;
	request(method: "elicitation/create", params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
};

// JSON-RPC server-error range; plain `throw new Error(...)` would surface
// to the client as an opaque "Internal error".
const ERROR_SERVER = -32000;

interface ActiveRun {
	/** Whether an `agent_start` was observed for this run. */
	started: boolean;
	/** Stop reason captured from `agent_end`, pending `agent_settled`. */
	stopReason: StopReason | undefined;
	resolve: (stopReason: StopReason) => void;
	reject: (error: Error) => void;
}

interface AgentSessionState {
	readonly acpSessionId: string;
	readonly cwd: string;
	readonly pi: PiClient;
	readonly client: ClientCaller;
	readonly translator: EventTranslator;
	activeRun: ActiveRun | undefined;
	/** Dialog extension UI requests awaiting an ACP elicitation answer. */
	readonly pendingDialogIds: Set<string>;
}

export interface PixAcpAgentOptions {
	/** Factory for per-session pi RPC clients (injected for tests). */
	readonly createPiClient: (options: PiRpcClientOptions) => PiClient;
	readonly piBinary: string;
	readonly logger: Logger;
	/** Path of the persistent ACP↔pi session map file. */
	readonly sessionMapPath: string;
}

export class PixAcpAgent {
	private readonly sessions = new Map<string, AgentSessionState>();
	private readonly app: AgentApp;
	private readonly options: PixAcpAgentOptions;
	private readonly sessionMap: SessionMapStore;
	/** Advertised by the client during `initialize`; gates dialog bridging. */
	private clientCapabilities: ClientCapabilities | null | undefined;

	constructor(options: PixAcpAgentOptions) {
		this.options = options;
		this.sessionMap = new SessionMapStore(options.sessionMapPath, options.logger);
		this.app = agent({ name: "pix-acp" })
			.onRequest("initialize", (ctx) => {
				this.clientCapabilities = ctx.params.clientCapabilities;
				return {
					protocolVersion: PROTOCOL_VERSION,
					agentCapabilities: {
						loadSession: true,
						promptCapabilities: {
							image: true,
						},
						sessionCapabilities: {
							list: {},
							delete: {},
							resume: {},
							fork: {},
							close: {},
						},
					},
				};
			})
			.onRequest("authenticate", () => ({}))
			.onRequest("session/new", (ctx) => this.newSession(ctx.params.cwd, ctx.client))
			.onRequest("session/load", (ctx) => this.loadSession(ctx.params, ctx.client))
			.onRequest("session/resume", (ctx) => this.resumeSession(ctx.params, ctx.client))
			.onRequest("session/list", (ctx) => this.listSessions(ctx.params))
			.onRequest("session/delete", (ctx) => this.deleteSession(ctx.params.sessionId))
			.onRequest("session/fork", (ctx) => this.forkSession(ctx.params, ctx.client))
			.onRequest("session/set_config_option", (ctx) => this.setConfigOption(ctx.params))
			.onRequest("session/set_mode", () => ({}))
			.onRequest("session/prompt", (ctx) => this.prompt(ctx.params))
			.onRequest("session/close", (ctx) => this.closeSession(ctx.params.sessionId))
			.onNotification("session/cancel", (ctx) => this.cancel(ctx.params.sessionId));
	}

	/** Underlying ACP app; used by tests for in-process client connections. */
	get acpApp(): AgentApp {
		return this.app;
	}

	connect(stream: Stream): AgentConnection {
		return this.app.connect(stream);
	}

	/**
	 * Stop every live pi subprocess. Called when the ACP connection closes so
	 * orphaned child processes cannot keep the adapter process alive.
	 */
	async dispose(): Promise<void> {
		await Promise.all([...this.sessions.values()].map((session) => this.teardownSession(session)));
	}

	getSession(sessionId: string): AgentSessionState | undefined {
		return this.sessions.get(sessionId);
	}

	/** Number of registered sessions (used by tests). */
	get sessionCount(): number {
		return this.sessions.size;
	}

	private async newSession(cwd: string, client: ClientCaller): Promise<NewSessionResponse> {
		const acpSessionId = randomUUID();
		const session = await this.spawnSession(acpSessionId, cwd, client);
		this.options.logger.info(`session/new: ${acpSessionId} (cwd: ${cwd})`);
		await this.registerSessionRecord(acpSessionId, cwd, session.pi);
		const configOptions = await this.safeConfigOptions(session.pi);
		return configOptions ? { sessionId: acpSessionId, configOptions } : { sessionId: acpSessionId };
	}

	private async loadSession(params: LoadSessionRequest, client: ClientCaller): Promise<LoadSessionResponse> {
		return this.loadOrResumeSession(params, client, { replay: true });
	}

	private async resumeSession(params: ResumeSessionRequest, client: ClientCaller): Promise<ResumeSessionResponse> {
		return this.loadOrResumeSession(params, client, { replay: false });
	}

	/** Shared implementation of `session/load` (with replay) and `session/resume`. */
	private async loadOrResumeSession(
		params: { sessionId: string; cwd: string },
		client: ClientCaller,
		options: { replay: boolean },
	): Promise<{ configOptions?: SessionConfigOption[] }> {
		const record = await this.sessionMap.get(params.sessionId);
		if (!record?.piSessionPath) {
			throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		}
		// Reloading a live session reloads it fresh (the client forgot history).
		if (this.sessions.has(params.sessionId)) await this.closeSession(params.sessionId);

		const session = await this.spawnSession(params.sessionId, params.cwd, client);
		this.options.logger.info(
			`${options.replay ? "session/load" : "session/resume"}: ${params.sessionId} → ${record.piSessionPath}`,
		);
		try {
			const switched = await session.pi.switchSession(record.piSessionPath);
			if (switched.cancelled) {
				throw new RequestError(ERROR_SERVER, "session switch cancelled by an extension");
			}
		} catch (error) {
			await this.teardownSession(session);
			if (error instanceof RequestError) throw error;
			throw new RequestError(
				ERROR_SERVER,
				`failed to switch to pi session file ${record.piSessionPath}: ${stringifyUnknown(error)}`,
			);
		}

		if (options.replay) {
			await replaySessionHistory(
				session.pi,
				{ sessionId: session.acpSessionId, cwd: session.cwd },
				async (notification) => {
					await session.client.notify("session/update", notification).catch((error: unknown) => {
						this.options.logger.warn(`session/update failed: ${stringifyUnknown(error)}`);
					});
				},
			);
		}
		await this.syncSessionRecord(session);

		const configOptions = await this.safeConfigOptions(session.pi);
		return configOptions ? { configOptions } : {};
	}

	private async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		const records = await this.sessionMap.list(params.cwd ?? undefined);
		const sessions: SessionInfo[] = records.map((record) => {
			const info: SessionInfo = { sessionId: record.sessionId, cwd: record.cwd, updatedAt: record.updatedAt };
			if (record.title !== undefined) info.title = record.title;
			return info;
		});
		return { sessions };
	}

	private async deleteSession(sessionId: string): Promise<void> {
		await this.sessionMap.delete(sessionId);
		if (this.sessions.has(sessionId)) await this.closeSession(sessionId);
		this.options.logger.info(`session/delete: ${sessionId}`);
	}

	private async forkSession(params: ForkSessionRequest, client: ClientCaller): Promise<{ sessionId: string; configOptions?: SessionConfigOption[] }> {
		const record = await this.sessionMap.get(params.sessionId);
		if (!record?.piSessionPath) {
			throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		}
		const acpSessionId = randomUUID();
		const cwd = params.cwd || record.cwd;
		const session = await this.spawnSession(acpSessionId, cwd, client);
		this.options.logger.info(`session/fork: ${params.sessionId} → ${acpSessionId}`);
		try {
			const switched = await session.pi.switchSession(record.piSessionPath);
			if (switched.cancelled) {
				throw new RequestError(ERROR_SERVER, "session switch cancelled by an extension");
			}
			const cloned = await session.pi.clone();
			if (cloned.cancelled) {
				throw new RequestError(ERROR_SERVER, "session clone cancelled by an extension");
			}
		} catch (error) {
			await this.teardownSession(session);
			if (error instanceof RequestError) throw error;
			throw new RequestError(ERROR_SERVER, `failed to fork session: ${stringifyUnknown(error)}`);
		}
		await this.registerSessionRecord(acpSessionId, cwd, session.pi, record.title);
		const configOptions = await this.safeConfigOptions(session.pi);
		return configOptions ? { sessionId: acpSessionId, configOptions } : { sessionId: acpSessionId };
	}

	private async setConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) {
			throw new RequestError(ERROR_SERVER, `session ${params.sessionId} not found`);
		}
		if (typeof params.value !== "string") {
			throw new RequestError(ERROR_SERVER, "boolean config options are not supported");
		}
		try {
			await applyConfigOption(session.pi, params.configId, params.value);
		} catch (error) {
			throw new RequestError(ERROR_SERVER, stringifyUnknown(error));
		}
		let configOptions: SessionConfigOption[];
		try {
			configOptions = await buildConfigOptions(session.pi);
		} catch (error) {
			this.options.logger.warn(`failed to rebuild config options: ${stringifyUnknown(error)}`);
			configOptions = [];
		}
		return { configOptions };
	}

	/** Start a pi process and register it as an ACP session. */
	private async spawnSession(acpSessionId: string, cwd: string, client: ClientCaller): Promise<AgentSessionState> {
		const pi = this.options.createPiClient({ piBinary: this.options.piBinary, cwd });
		try {
			await pi.start();
		} catch (error) {
			void pi.stop().catch(() => {});
			throw new RequestError(
				ERROR_SERVER,
				`failed to start pi (${this.options.piBinary}): ${stringifyUnknown(error)}`,
			);
		}
		const translator = new EventTranslator({ sessionId: acpSessionId, cwd });
		const session: AgentSessionState = {
			acpSessionId,
			cwd,
			pi,
			client,
			translator,
			activeRun: undefined,
			pendingDialogIds: new Set(),
		};
		this.sessions.set(acpSessionId, session);
		pi.onEvent((event) => this.onPiEvent(acpSessionId, event));
		pi.onExit((error) => this.onPiExit(session, error));
		return session;
	}

	/**
	 * Persist the session map entry for a live session. Non-fatal: sessions
	 * keep working without persistence, they just cannot be resumed later.
	 */
	private async registerSessionRecord(
		sessionId: string,
		cwd: string,
		pi: PiClient,
		title?: string,
	): Promise<void> {
		try {
			const state = await pi.getState();
			if (!state.sessionFile) {
				this.options.logger.warn(`pi reported no session file for ${sessionId}; not persisting to session map`);
				return;
			}
			await this.sessionMap.put({
				sessionId,
				piSessionPath: state.sessionFile,
				piSessionId: state.sessionId,
				cwd,
				title: title ?? state.sessionName,
				updatedAt: new Date().toISOString(),
			});
		} catch (error) {
			this.options.logger.warn(`failed to persist session map entry for ${sessionId}: ${stringifyUnknown(error)}`);
		}
	}

	/**
	 * Refresh the session map entry of a live session from pi's current state.
	 *
	 * pi can move the underlying session file under us (branching, or a
	 * future rename-on-title), and it tracks session names inside the file
	 * (`session_info` entries) without telling the adapter. A stale
	 * `piSessionPath` would break later `session/load`/`session/resume`; a
	 * stale title would show an outdated name in `session/list`. Non-fatal.
	 */
	private async syncSessionRecord(session: AgentSessionState, title?: string | undefined): Promise<void> {
		try {
			const record = await this.sessionMap.get(session.acpSessionId);
			if (!record) return;
			const state = await session.pi.getState();
			const piSessionPath = state.sessionFile ?? record.piSessionPath;
			const nextTitle = title ?? state.sessionName ?? record.title;
			if (piSessionPath === record.piSessionPath && nextTitle === record.title) {
				await this.sessionMap.touch(session.acpSessionId);
				return;
			}
			if (piSessionPath !== record.piSessionPath) {
				this.options.logger.info(
					`session ${session.acpSessionId}: pi session file moved ${record.piSessionPath} → ${piSessionPath}`,
				);
			}
			await this.sessionMap.put({
				...record,
				piSessionPath,
				piSessionId: state.sessionId,
				title: nextTitle,
				updatedAt: new Date().toISOString(),
			});
		} catch (error) {
			this.options.logger.warn(
				`failed to sync session map entry for ${session.acpSessionId}: ${stringifyUnknown(error)}`,
			);
		}
	}

	/** Config options for responses; `undefined` when pi exposes none. */
	private async safeConfigOptions(pi: PiClient): Promise<SessionConfigOption[] | undefined> {
		try {
			const options = await buildConfigOptions(pi);
			return options.length > 0 ? options : undefined;
		} catch (error) {
			this.options.logger.warn(`failed to build config options: ${stringifyUnknown(error)}`);
			return undefined;
		}
	}

	private onPiEvent(sessionId: string, event: PiEvent): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;

		if (isExtensionUiRequest(event)) {
			void this.handleExtensionUiRequest(session, event);
			return;
		}
		this.dispatchSessionEvent(session, event);
	}

	/**
	 * The pi process of a session died. Without this, an in-flight
	 * `session/prompt` would hang forever waiting for `agent_settled` events
	 * that can no longer arrive.
	 */
	private onPiExit(session: AgentSessionState, error: Error): void {
		if (this.sessions.get(session.acpSessionId) !== session) return;
		this.options.logger.warn(`session ${session.acpSessionId}: ${error.message}`);
		const run = session.activeRun;
		if (!run) return;
		session.activeRun = undefined;
		run.reject(error);
	}

	/** Bridges one extension UI request to ACP and answers pi. */
	private async handleExtensionUiRequest(session: AgentSessionState, request: RpcExtensionUIRequest): Promise<void> {
		const elicitation = toElicitationRequest(request, {
			sessionId: session.acpSessionId,
			elicitationId: randomUUID(),
		});
		if (!elicitation) {
			// Fire-and-forget UI updates (notify/setStatus/setWidget/...) have
			// no ACP counterpart.
			this.options.logger.debug(`extension ui ${request.method} ignored (no ACP counterpart)`);
			return;
		}
		if (this.clientCapabilities?.elicitation?.form == null) {
			const title = (request as { title?: string }).title ?? request.method;
			this.options.logger.warn(`client does not advertise elicitation form support; cancelling "${title}" (${request.method})`);
			this.safeRespond(session.pi, cancelledResponse(request.id));
			return;
		}

		session.pendingDialogIds.add(request.id);
		try {
			const answer = await session.client.request("elicitation/create", elicitation);
			// The session may have been closed while the user was thinking.
			if (!this.sessions.has(session.acpSessionId)) return;
			this.safeRespond(session.pi, fromElicitationResponse(answer, request));
		} catch (error) {
			this.options.logger.warn(`elicitation/create failed: ${stringifyUnknown(error)}`);
			if (this.sessions.has(session.acpSessionId)) {
				this.safeRespond(session.pi, cancelledResponse(request.id));
			}
		} finally {
			session.pendingDialogIds.delete(request.id);
		}
	}

	private safeRespond(pi: PiClient, response: RpcExtensionUIResponse): void {
		try {
			pi.respondToExtensionUi(response);
		} catch (error) {
			this.options.logger.warn(`extension_ui_response failed: ${stringifyUnknown(error)}`);
		}
	}

	private dispatchSessionEvent(session: AgentSessionState, event: JsonAgentSessionEvent): void {
		for (const notification of session.translator.translate(event)) {
			void session.client.notify("session/update", notification).catch((error: unknown) => {
				this.options.logger.warn(`session/update failed: ${stringifyUnknown(error)}`);
			});
		}

		const run = session.activeRun;
		if (!run) return;
		switch (event.type) {
			case "agent_start":
				run.started = true;
				return;
			case "agent_end":
				if (!event.willRetry) run.stopReason = stopReasonFromAgentEnd(event);
				return;
			case "agent_settled":
				if (run.started) {
					session.activeRun = undefined;
					run.resolve(run.stopReason ?? "end_turn");
				}
				return;
			default:
				return;
		}
	}

	private async prompt(params: PromptRequest): Promise<PromptResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) {
			throw new RequestError(ERROR_SERVER, `session ${params.sessionId} not found`);
		}
		if (session.activeRun) {
			throw new RequestError(ERROR_SERVER, "a prompt is already in progress for this session");
		}

		const input = collectPromptInput(params.prompt);

		// pi TUI built-ins (/compact, /name, /model, ...) have no RPC-side
		// handling; intercept them here. Everything else starting with "/"
		// (extension commands, prompt templates, /skill:*) is forwarded to
		// pi, which expands them natively.
		if (input.images.length === 0) {
			const builtin = parseBuiltinCommand(input.text);
			if (builtin) {
				const usageError = builtinUsageError(builtin);
				if (usageError) throw new RequestError(ERROR_SERVER, usageError);
				return this.executeBuiltin(session, builtin);
			}
		}

		const run: ActiveRun = {
			started: false,
			stopReason: undefined,
			resolve: () => {},
			reject: () => {},
		};
		session.activeRun = run;
		const settled = new Promise<StopReason>((resolve, reject) => {
			run.resolve = resolve;
			run.reject = reject;
		});

		try {
			await session.pi.prompt(input.text, input.images.length > 0 ? input.images : undefined);
		} catch (error) {
			session.activeRun = undefined;
			run.reject(new Error(stringifyUnknown(error)));
			throw new RequestError(ERROR_SERVER, `pi prompt failed: ${stringifyUnknown(error)}`);
		}

		let stopReason: StopReason;
		try {
			stopReason = await settled;
		} catch (error) {
			throw new RequestError(ERROR_SERVER, `pi process died: ${stringifyUnknown(error)}`);
		}
		// Refresh the persisted mapping (updatedAt, plus any pi-side rename).
		void this.syncSessionRecord(session);
		return { stopReason };
	}

	/** Execute an intercepted pi TUI built-in and report back as a message. */
	private async executeBuiltin(session: AgentSessionState, command: BuiltinCommand): Promise<PromptResponse> {
		let detail: string | undefined;
		switch (command.kind) {
			case "compact": {
				const result = await session.pi.compact(command.instructions);
				const after = result.estimatedTokensAfter === undefined ? "?" : String(result.estimatedTokensAfter);
				detail = `compacted (~${result.tokensBefore} → ~${after} tokens)`;
				break;
			}
			case "name": {
				await session.pi.setSessionName(command.name);
				await this.syncSessionRecord(session, command.name);
				await this.notifySessionInfo(session, { title: command.name });
				detail = `session renamed to "${command.name}"`;
				break;
			}
			case "export": {
				const result = await session.pi.exportHtml(command.outputPath);
				detail = `exported to ${result.path}`;
				break;
			}
			case "autocompact": {
				await session.pi.setAutoCompaction(command.enabled);
				detail = `auto-compaction ${command.enabled ? "enabled" : "disabled"}`;
				break;
			}
			case "steering": {
				await session.pi.setSteeringMode(command.mode);
				detail = `steering mode: ${command.mode}`;
				break;
			}
			case "followup": {
				await session.pi.setFollowUpMode(command.mode);
				detail = `follow-up mode: ${command.mode}`;
				break;
			}
			case "model": {
				if (command.value === undefined) {
					const cycled = await session.pi.cycleModel();
					detail = cycled
						? `switched to ${cycled.model.provider}/${cycled.model.id}`
						: "no other model available";
				} else {
					const parsed = parseModelValue(command.value);
					if (!parsed) {
						throw new RequestError(ERROR_SERVER, `invalid model "${command.value}"; expected provider/modelId`);
					}
					const model = await session.pi.setModel(parsed.provider, parsed.modelId);
					detail = `switched to ${model.provider}/${model.id}`;
				}
				break;
			}
			case "thinking": {
				const levels = await session.pi.getAvailableThinkingLevels();
				if (!levels.includes(command.level)) {
					throw new RequestError(
						ERROR_SERVER,
						`unknown thought level "${command.level}"; available: ${levels.join(", ")}`,
					);
				}
				await session.pi.setThinkingLevel(command.level);
				detail = `thought level: ${command.level}`;
				break;
			}
		}
		await this.notifyAgentMessage(session, builtinFeedback(command, detail ?? "done"));
		await this.sessionMap.touch(session.acpSessionId);
		return { stopReason: "end_turn" };
	}

	/** Emit one agent_message_chunk update (used for built-in feedback). */
	private async notifyAgentMessage(session: AgentSessionState, text: string): Promise<void> {
		const notification: SessionNotification = {
			sessionId: session.acpSessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				messageId: randomUUID(),
				content: { type: "text", text },
			},
		};
		await session.client.notify("session/update", notification).catch((error: unknown) => {
			this.options.logger.warn(`session/update failed: ${stringifyUnknown(error)}`);
		});
	}

	/** Emit a session_info_update (e.g. new title after /name). */
	private async notifySessionInfo(
		session: AgentSessionState,
		info: { title?: string | null; updatedAt?: string | null },
	): Promise<void> {
		const notification: SessionNotification = {
			sessionId: session.acpSessionId,
			update: { sessionUpdate: "session_info_update", ...info },
		};
		await session.client.notify("session/update", notification).catch((error: unknown) => {
			this.options.logger.warn(`session/update failed: ${stringifyUnknown(error)}`);
		});
	}

	private cancel(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		this.options.logger.debug(`session/cancel for ${sessionId}`);
		void session.pi.abort().catch((error: unknown) => {
			this.options.logger.warn(`pi abort failed: ${stringifyUnknown(error)}`);
		});
	}

	private async closeSession(sessionId: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;
		this.options.logger.info(`session/close: ${sessionId}`);
		await this.teardownSession(session);
	}

	private async teardownSession(session: AgentSessionState): Promise<void> {
		this.sessions.delete(session.acpSessionId);
		// Unblock extensions still waiting on a dialog answer.
		for (const id of session.pendingDialogIds) {
			this.safeRespond(session.pi, cancelledResponse(id));
		}
		await session.pi.stop().catch((error: unknown) => {
			this.options.logger.warn(`pi stop failed: ${stringifyUnknown(error)}`);
		});
	}

}

function stopReasonFromAgentEnd(event: { messages: unknown[] }): StopReason {
	for (let i = event.messages.length - 1; i >= 0; i--) {
		const message = event.messages[i];
		if (
			typeof message === "object" &&
			message !== null &&
			(message as { role?: unknown }).role === "assistant" &&
			typeof (message as { stopReason?: unknown }).stopReason === "string"
		) {
			switch ((message as { stopReason: string }).stopReason) {
				case "aborted":
					return "cancelled";
				case "error":
					return "refusal";
				case "length":
					return "max_tokens";
				default:
					return "end_turn";
			}
		}
	}
	return "end_turn";
}

function collectPromptInput(blocks: readonly ContentBlock[]): { text: string; images: PiImageContent[] } {
	const textParts: string[] = [];
	const images: PiImageContent[] = [];
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				textParts.push(block.text);
				break;
			case "image":
				images.push({ type: "image", data: block.data, mimeType: block.mimeType });
				break;
			case "resource_link":
				textParts.push(`[resource: ${block.name ?? block.uri}]`);
				break;
			case "resource": {
				const contents = block.resource;
				if ("text" in contents && typeof contents.text === "string") {
					textParts.push(contents.text);
				} else {
					throw new RequestError(ERROR_SERVER, "binary resource content is not supported in prompts");
				}
				break;
			}
			case "audio":
				throw new RequestError(ERROR_SERVER, "audio content is not supported in prompts");
		}
	}
	if (textParts.length === 0 && images.length === 0) {
		throw new RequestError(ERROR_SERVER, "prompt contained no supported content");
	}
	return { text: textParts.join("\n\n"), images };
}
