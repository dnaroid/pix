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
import { resolve } from "node:path";
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
import {
	SessionManager,
	type JsonAgentSessionEvent,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type SessionInfo as PiSessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { Logger } from "../logging.js";
import { stringifyUnknown } from "../stringify-unknown.js";
import {
	createAutocompleteCompleter,
	autocompleteSettings,
	loadAutocompleteConfig,
	parseAutocompleteRequest,
	parseAutocompleteSettingsRequest,
	type AutocompleteCompleter,
	type AutocompleteConfig,
	type AutocompleteRequest,
	type AutocompleteResponse,
	type AutocompleteSettingsRequest,
	type AutocompleteSettingsResponse,
} from "./autocomplete.js";
import {
	isExtensionUiRequest,
	type PiClient,
	type PiEvent,
	type PiImageContent,
	type PiRpcClientOptions,
} from "../pi/pi-rpc-client.js";
import { applyConfigOption, buildConfigOptions, parseModelValue } from "./config-options.js";
import { loadPixDefaultModel, type PixDefaultModel } from "./default-model.js";
import { EventTranslator } from "./event-translator.js";
import {
	builtinFeedback,
	builtinUsageError,
	parseBuiltinCommand,
	type BuiltinCommand,
} from "./slash-commands.js";
import { SessionMapStore, type SessionMapRecord } from "./session-map.js";
import { replaySessionHistory } from "./session-replay.js";
import { loadTuiTabSnapshot, type TuiTabSnapshot } from "./tui-tabs.js";
import { cancelledResponse, fromElicitationResponse, toElicitationRequest } from "./ui-request-bridge.js";
import {
	PIX_SESSION_STATE_METHOD,
	sessionStateEnvelopeFromUiRequest,
	type PixSessionStateNotification,
} from "./session-state-bridge.js";

/** Minimal shape of the handler `client` context used for notifications and elicitations. */
type ClientCaller = {
	notify(method: "session/update", params: SessionNotification): Promise<void>;
	notify(method: typeof PIX_SESSION_STATE_METHOD, params: PixSessionStateNotification): Promise<void>;
	request(method: "elicitation/create", params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
};

// JSON-RPC server-error range; plain `throw new Error(...)` would surface
// to the client as an opaque "Internal error".
const ERROR_SERVER = -32000;

interface ActiveRun {
	/** Whether the client requested cancellation before pi reported its reason. */
	cancelled: boolean;
	/** Whether pi emitted agent_start for this run. */
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
	readonly piEntry: string;
	/** Explicit bundled question extension path for Desktop-owned sessions. */
	readonly questionExtensionPath?: string;
	readonly logger: Logger;
	/** Path of the persistent ACP↔pi session map file. */
	readonly sessionMapPath: string;
	/** Native Pi-session discovery (overridable for hermetic tests). */
	readonly listPiSessions?: (cwd?: string) => Promise<readonly PiSessionInfo[]>;
	/** Reader for the TUI's project tab snapshot (overridable for tests). */
	readonly loadTuiTabs?: (cwd: string) => Promise<TuiTabSnapshot>;
	/** Private prompt-completion backend (overridable for hermetic tests). */
	readonly completeAutocomplete?: AutocompleteCompleter;
	/** Pix autocomplete config reader (overridable for hermetic tests). */
	readonly loadAutocompleteConfig?: (cwd: string) => AutocompleteConfig;
	/** Pix default-model reader (overridable for hermetic tests). */
	readonly loadDefaultModel?: (cwd: string) => PixDefaultModel | undefined;
}

export class PixAcpAgent {
	private readonly sessions = new Map<string, AgentSessionState>();
	/** Starts already accepted by ACP but not yet registered in `sessions`. */
	private readonly pendingSpawns = new Set<Promise<AgentSessionState>>();
	/** Serializes load/resume/fork/delete/close operations for the same id. */
	private readonly sessionLifecycle = new Map<string, Promise<void>>();
	private readonly app: AgentApp;
	private readonly options: PixAcpAgentOptions;
	private readonly sessionMap: SessionMapStore;
	private readonly listPiSessions: (cwd?: string) => Promise<readonly PiSessionInfo[]>;
	private readonly loadTuiTabs: (cwd: string) => Promise<TuiTabSnapshot>;
	private readonly completeAutocomplete: AutocompleteCompleter;
	private readonly loadAutocompleteConfig: (cwd: string) => AutocompleteConfig;
	private readonly loadDefaultModel: (cwd: string) => PixDefaultModel | undefined;
	private disposed = false;
	/** Advertised by the client during `initialize`; gates dialog bridging. */
	private clientCapabilities: ClientCapabilities | null | undefined;

	constructor(options: PixAcpAgentOptions) {
		this.options = options;
		this.sessionMap = new SessionMapStore(options.sessionMapPath, options.logger);
		this.listPiSessions = options.listPiSessions
			?? ((cwd) => cwd ? SessionManager.list(cwd) : SessionManager.listAll());
		this.loadTuiTabs = options.loadTuiTabs ?? ((cwd) => loadTuiTabSnapshot(cwd));
		this.loadAutocompleteConfig = options.loadAutocompleteConfig ?? loadAutocompleteConfig;
		this.loadDefaultModel = options.loadDefaultModel ?? loadPixDefaultModel;
		this.completeAutocomplete = options.completeAutocomplete ?? createAutocompleteCompleter({
			logger: options.logger,
			loadConfig: this.loadAutocompleteConfig,
		});
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
			.onRequest("session/load", (ctx) =>
				this.withSessionLifecycle(ctx.params.sessionId, () => this.loadSession(ctx.params, ctx.client)),
			)
			.onRequest("session/resume", (ctx) =>
				this.withSessionLifecycle(ctx.params.sessionId, () => this.resumeSession(ctx.params, ctx.client)),
			)
			.onRequest("session/list", (ctx) => this.listSessions(ctx.params))
			.onRequest("session/delete", (ctx) =>
				this.withSessionLifecycle(ctx.params.sessionId, () => this.deleteSession(ctx.params.sessionId)),
			)
			.onRequest("session/fork", (ctx) =>
				this.withSessionLifecycle(ctx.params.sessionId, () => this.forkSession(ctx.params, ctx.client)),
			)
			.onRequest("session/set_config_option", (ctx) => this.setConfigOption(ctx.params))
			.onRequest("session/set_mode", () => ({}))
			.onRequest("session/prompt", (ctx) => this.prompt(ctx.params))
			.onRequest("pix/autocomplete", parseAutocompleteRequest, (ctx) =>
				this.autocomplete(ctx.params, ctx.signal),
			)
			.onRequest("pix/autocomplete/config", parseAutocompleteSettingsRequest, (ctx) =>
				this.autocompleteConfig(ctx.params),
			)
			.onRequest("session/close", (ctx) =>
				this.withSessionLifecycle(ctx.params.sessionId, () => this.closeSession(ctx.params.sessionId)),
			)
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
		this.disposed = true;
		await Promise.allSettled([...this.pendingSpawns]);
		await Promise.allSettled([...this.sessionLifecycle.values()]);
		await Promise.all([...this.sessions.values()].map((session) => this.teardownSession(session)));
	}

	getSession(sessionId: string): AgentSessionState | undefined {
		return this.sessions.get(sessionId);
	}

	/** Number of registered sessions (used by tests). */
	get sessionCount(): number {
		return this.sessions.size;
	}

	private async autocomplete(
		params: AutocompleteRequest,
		signal: AbortSignal,
	): Promise<AutocompleteResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		const completion = await this.completeAutocomplete({
			cwd: session.cwd,
			draft: params.draft,
			signal,
			getMessages: () => session.pi.getMessages(),
		});
		return { completion };
	}

	private autocompleteConfig(params: AutocompleteSettingsRequest): AutocompleteSettingsResponse {
		const session = this.sessions.get(params.sessionId);
		if (!session) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		return autocompleteSettings(this.loadAutocompleteConfig(session.cwd));
	}

	private async newSession(cwd: string, client: ClientCaller): Promise<NewSessionResponse> {
		const acpSessionId = randomUUID();
		let defaultModel: PixDefaultModel | undefined;
		try {
			defaultModel = this.loadDefaultModel(cwd);
		} catch (error) {
			throw new RequestError(ERROR_SERVER, `failed to resolve Pix default model: ${stringifyUnknown(error)}`);
		}
		const session = await this.spawnSession(acpSessionId, cwd, client, defaultModel);
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
		try {
			const nativeSessions = await this.listPiSessions(params.cwd ?? undefined);
			const discovered = nativeSessions.flatMap((session) => {
				const record = nativeSessionRecord(session, params.cwd ?? undefined);
				return record ? [record] : [];
			});
			await this.sessionMap.mergeByPiSessionPath(discovered);
		} catch (error) {
			this.options.logger.warn(`native session discovery failed: ${stringifyUnknown(error)}`);
		}

		const records = await this.sessionMap.list(params.cwd ?? undefined);
		const sessions: SessionInfo[] = records.map((record) => {
			const info: SessionInfo = { sessionId: record.sessionId, cwd: record.cwd, updatedAt: record.updatedAt };
			if (record.title !== undefined) info.title = record.title;
			return info;
		});
		if (!params.cwd) return { sessions };

		let tabs: TuiTabSnapshot = { sessionPaths: [] };
		try {
			tabs = await this.loadTuiTabs(params.cwd);
		} catch (error) {
			this.options.logger.warn(`TUI tab discovery failed: ${stringifyUnknown(error)}`);
		}
		const sessionIdByPath = new Map(records.map((record) => [resolve(record.piSessionPath), record.sessionId]));
		const sessionIds = tabs.sessionPaths.flatMap((path) => {
			const sessionId = sessionIdByPath.get(resolve(path));
			return sessionId ? [sessionId] : [];
		});
		const activeSessionId = tabs.activeSessionPath
			? sessionIdByPath.get(resolve(tabs.activeSessionPath))
			: undefined;
		return {
			sessions,
			_meta: {
				"pix.tabs": {
					sessionIds,
					...(activeSessionId ? { activeSessionId } : {}),
				},
			},
		};
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
	private spawnSession(
		acpSessionId: string,
		cwd: string,
		client: ClientCaller,
		defaultModel?: PixDefaultModel,
	): Promise<AgentSessionState> {
		const pending = this.startSession(acpSessionId, cwd, client, defaultModel);
		this.pendingSpawns.add(pending);
		void pending.finally(() => this.pendingSpawns.delete(pending)).catch(() => {});
		return pending;
	}

	private async startSession(
		acpSessionId: string,
		cwd: string,
		client: ClientCaller,
		defaultModel?: PixDefaultModel,
	): Promise<AgentSessionState> {
		if (this.disposed) throw new RequestError(ERROR_SERVER, "adapter is shutting down");
		const pi = this.options.createPiClient(piClientOptions(
			this.options.piEntry,
			cwd,
			defaultModel,
			this.options.questionExtensionPath,
		));
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
		// Register routing before start so session_start extension state emitted
		// during RPC startup is delivered instead of being dropped.
		this.sessions.set(acpSessionId, session);
		const unsubscribeEvents = pi.onEvent((event) => this.onPiEvent(session, event));
		try {
			await pi.start();
		} catch (error) {
			unsubscribeEvents();
			if (this.sessions.get(acpSessionId) === session) this.sessions.delete(acpSessionId);
			void pi.stop().catch(() => {});
			throw new RequestError(
				ERROR_SERVER,
				`failed to start pi (${this.options.piEntry}): ${stringifyUnknown(error)}`,
			);
		}
		if (this.disposed) {
			unsubscribeEvents();
			if (this.sessions.get(acpSessionId) === session) this.sessions.delete(acpSessionId);
			await pi.stop().catch(() => {});
			throw new RequestError(ERROR_SERVER, "adapter is shutting down");
		}
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

	/**
	 * Serialize background metadata refreshes with load/delete/close so an old
	 * pi process cannot recreate a deleted record or overwrite its replacement.
	 */
	private async syncLiveSessionRecord(session: AgentSessionState, title?: string | undefined): Promise<void> {
		await this.withSessionLifecycle(session.acpSessionId, async () => {
			if (this.sessions.get(session.acpSessionId) !== session) return;
			await this.syncSessionRecord(session, title);
		});
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

	private onPiEvent(session: AgentSessionState, event: PiEvent): void {
		// A replaced process may still flush events while it is stopping. Never
		// route those events into the newer process registered under the same id.
		if (this.sessions.get(session.acpSessionId) !== session) return;

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
		this.sessions.delete(session.acpSessionId);
		this.options.logger.warn(`session ${session.acpSessionId}: ${error.message}`);
		this.rejectActiveRun(session, error);
		session.pendingDialogIds.clear();
	}

	/** Bridges one extension UI request to ACP and answers pi. */
	private async handleExtensionUiRequest(session: AgentSessionState, request: RpcExtensionUIRequest): Promise<void> {
		const state = sessionStateEnvelopeFromUiRequest(request);
		if (state) {
			await session.client.notify(PIX_SESSION_STATE_METHOD, {
				sessionId: session.acpSessionId,
				...state,
			}).catch((error: unknown) => {
				this.options.logger.warn(`${PIX_SESSION_STATE_METHOD} failed: ${stringifyUnknown(error)}`);
			});
			return;
		}
		const elicitation = toElicitationRequest(request, {
			sessionId: session.acpSessionId,
			elicitationId: randomUUID(),
		});
		if (!elicitation) {
			if (request.method === "select" || request.method === "confirm" || request.method === "input" || request.method === "editor") {
				this.options.logger.warn(`invalid blocking extension ui request (${request.method}); cancelling`);
				this.safeRespond(session.pi, cancelledResponse(request.id));
				return;
			}
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
			if (this.sessions.get(session.acpSessionId) !== session) return;
			this.safeRespond(session.pi, fromElicitationResponse(answer, request));
		} catch (error) {
			this.options.logger.warn(`elicitation/create failed: ${stringifyUnknown(error)}`);
			if (this.sessions.get(session.acpSessionId) === session) {
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
				// Ignore a late duplicate settlement from the prior run. An early
				// cancellation is the only valid run that can settle before start.
				if (!run.started && !run.cancelled) return;
				this.resolveActiveRun(session, run.cancelled ? "cancelled" : (run.stopReason ?? "end_turn"));
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
			cancelled: false,
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
			throw new RequestError(ERROR_SERVER, `pi prompt failed: ${stringifyUnknown(error)}`);
		}

		let stopReason: StopReason;
		try {
			stopReason = await settled;
		} catch (error) {
			throw new RequestError(ERROR_SERVER, `pi process died: ${stringifyUnknown(error)}`);
		}
		// Refresh the persisted mapping (updatedAt, plus any pi-side rename).
		void this.syncLiveSessionRecord(session);
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
				await this.syncLiveSessionRecord(session, command.name);
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
		if (session.activeRun) session.activeRun.cancelled = true;
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
		if (this.sessions.get(session.acpSessionId) === session) {
			this.sessions.delete(session.acpSessionId);
		}
		const hadActiveRun = this.resolveActiveRun(session, "cancelled");
		// Unblock extensions still waiting on a dialog answer.
		for (const id of session.pendingDialogIds) {
			this.safeRespond(session.pi, cancelledResponse(id));
		}
		if (hadActiveRun) {
			await session.pi.abort().catch((error: unknown) => {
				this.options.logger.warn(`pi abort failed during teardown: ${stringifyUnknown(error)}`);
			});
		}
		await session.pi.stop().catch((error: unknown) => {
			this.options.logger.warn(`pi stop failed: ${stringifyUnknown(error)}`);
		});
	}

	private resolveActiveRun(session: AgentSessionState, stopReason: StopReason): boolean {
		const run = session.activeRun;
		if (!run) return false;
		session.activeRun = undefined;
		run.resolve(stopReason);
		return true;
	}

	private rejectActiveRun(session: AgentSessionState, error: Error): boolean {
		const run = session.activeRun;
		if (!run) return false;
		session.activeRun = undefined;
		run.reject(error);
		return true;
	}

	/** Queue lifecycle mutations so two requests cannot replace one another. */
	private async withSessionLifecycle<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.sessionLifecycle.get(sessionId) ?? Promise.resolve();
		const queued = previous.catch(() => {}).then(operation);
		const tail = queued.then(
			() => {},
			() => {},
		);
		this.sessionLifecycle.set(sessionId, tail);
		try {
			return await queued;
		} finally {
			if (this.sessionLifecycle.get(sessionId) === tail) this.sessionLifecycle.delete(sessionId);
		}
	}

}

function piClientOptions(
	piEntry: string,
	cwd: string,
	defaultModel?: PixDefaultModel,
	questionExtensionPath?: string,
): PiRpcClientOptions {
	const base = {
		piEntry,
		cwd,
		env: {
			PIX_ACP_SESSION_STATE_BRIDGE: "1",
			...(questionExtensionPath ? { PIX_QUESTION_RPC_BRIDGE: "1" } : {}),
		},
		...(questionExtensionPath ? { args: ["--extension", questionExtensionPath] } : {}),
	};
	if (!defaultModel) return base;
	const selected = {
		...base,
		provider: defaultModel.provider,
		model: defaultModel.modelId,
	};
	if (defaultModel.thinkingLevel === undefined) return selected;
	return { ...selected, args: [...(base.args ?? []), "--thinking", defaultModel.thinkingLevel] };
}

function nativeSessionRecord(session: PiSessionInfo, requestedCwd?: string): SessionMapRecord | undefined {
	const cwd = requestedCwd ?? session.cwd;
	if (!cwd || !session.id || !session.path) return undefined;
	const title = session.name?.trim() || session.firstMessage.trim();
	const record: SessionMapRecord = {
		sessionId: session.id,
		piSessionPath: resolve(session.path),
		piSessionId: session.id,
		cwd,
		updatedAt: session.modified.toISOString(),
	};
	if (title) record.title = title;
	return record;
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
				textParts.push(block.uri.startsWith("file://")
					? `[Pix attachment: ${block.uri}]`
					: `[resource: ${block.name ?? block.uri}]`);
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
