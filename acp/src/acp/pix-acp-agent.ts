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

import { createHash, randomUUID } from "node:crypto";
import { BrainstormHost, BRAINSTORM_CHANNEL, type BrainstormLink } from "./brainstorm-host.js";
import { brainstormParticipantOptions, freshParticipantAnswer } from "./brainstorm-participant.js";
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setText as copyTextToClipboard } from "@mariozechner/clipboard";
import {
	PROTOCOL_VERSION,
	RequestError,
	agent,
	type AgentApp,
	type AgentConnection,
	type AvailableCommand,
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
	getAgentDir,
	getPackageDir,
	SessionManager,
	SettingsManager,
	type JsonAgentSessionEvent,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type SessionInfo as PiSessionInfo,
} from "@earendil-works/pi-coding-agent";
import type { Logger } from "../logging.js";
import { DesktopRegistryService } from "../registry/service.js";
import type { RegistryContext } from "../registry/context.js";
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

const PIX_FILE_IMAGES_META_KEY = "pix.fileImages";
const MAX_PROMPT_FILE_IMAGE_COUNT = 10;
const MAX_PROMPT_FILE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_PROMPT_FILE_IMAGES_TOTAL_BYTES = 50 * 1024 * 1024;
import {
	isExtensionUiRequest,
	type PiClient,
	type PiAgentMessage,
	type PiEvent,
	type PiImageContent,
	type PiModel,
	type PiAnthropicUsageRecord,
	type PiRpcClientOptions,
	type PiSessionEntry,
	type PiSessionState,
	type PiSessionStats,
} from "../pi/pi-rpc-client.js";
import {
	applyConfigOption,
	buildConfigOptions,
	CONFIG_ID_MODEL,
	modelOption,
	parseModelValue,
	supportedThinkingLevels,
	thoughtLevelOption,
} from "./config-options.js";
import {
	PIX_ENHANCE_PROMPT_METHOD,
	PIX_AGENT_CONTROL_METHOD,
	PIX_BRANCH_USER_MESSAGES_METHOD,
	PIX_CLAUDE_QUOTA_REFRESH_METHOD,
	PIX_GIT_ASSIST_METHOD,
	PIX_DEFER_MESSAGE_METHOD,
	PIX_DCP_STATS_METHOD,
	PIX_DRAFT_CONFIG_METHOD,
	PIX_MODEL_ROUTING_STATUS_METHOD,
	PIX_MODEL_ROUTE_METHOD,
	PIX_BASH_METHOD,
	PIX_CLEAR_TODOS_METHOD,
	PIX_FORK_MESSAGES_METHOD,
	PIX_IMPORT_SESSION_METHOD,
	PIX_QUEUE_ACTION_METHOD,
	PIX_QUEUE_CONSUMED_METHOD,
	PIX_QUEUE_MESSAGE_METHOD,
	PIX_QUEUE_STATE_METHOD,
	PIX_REGISTRY_ACTION_METHOD,
	PIX_REGISTRY_DIFF_METHOD,
	PIX_RELOAD_SESSION_METHOD,
	PIX_REQUEST_HISTORY_METHOD,
	PIX_RESUME_PATH_METHOD,
	PIX_RUNTIME_STATUS_METHOD,
	PIX_SESSION_USAGE_METHOD,
	PIX_SESSION_IMAGE_METHOD,
	PIX_SESSION_HISTORY_METHOD,
	PIX_TAKE_AUTO_MESSAGE_METHOD,
	PIX_TOOL_RESULT_METHOD,
	PIX_USER_MESSAGE_ACTION_METHOD,
	parseDesktopEnhancePromptRequest,
	parseDesktopDraftConfigRequest,
	parseDesktopModelRoutingStatusRequest,
	parseDesktopModelRouteRequest,
	parseDesktopBashRequest,
	parseDesktopAgentControlRequest,
	parseDesktopSessionRequest,
	parseDesktopGitAssistantRequest,
	parseDesktopImportSessionRequest,
	parseDesktopQueueActionRequest,
	parseDesktopQueueSubmitRequest,
	parseDesktopRegistryActionRequest,
	parseDesktopRegistryDiffRequest,
	parseDesktopResumePathRequest,
	parseDesktopRuntimeStatusRequest,
	parseDesktopSessionImageRequest,
	parseDesktopSessionHistoryRequest,
	parseDesktopToolResultRequest,
	parseDesktopUserMessageActionRequest,
	type DesktopEnhancePromptRequest,
	type DesktopEnhancePromptResponse,
	type DesktopAgentControlRequest,
	type DesktopAgentControlResponse,
	type DesktopAgentControlState,
	type DesktopDcpStatsResponse,
	type DesktopDraftConfigRequest,
	type DesktopDraftConfigResponse,
	type DesktopModelRoutingStatusRequest,
	type DesktopModelRoutingStatusResponse,
	type DesktopModelRouteRequest,
	type DesktopModelRouteResponse,
	type DesktopBashRequest,
	type DesktopClaudeQuotaRefreshResponse,
	type DesktopGitAssistantRequest,
	type DesktopGitAssistantResponse,
	type DesktopImportSessionRequest,
	type DesktopQueueActionRequest,
	type DesktopQueueActionResponse,
	type DesktopQueueConsumedNotification,
	type DesktopQueueItem,
	type DesktopQueueStateResponse,
	type DesktopQueueSubmitRequest,
	type DesktopQueueSubmitResponse,
	type DesktopQueuedUserMessage,
	type DesktopRegistryActionRequest,
	type DesktopRegistryActionResponse,
	type DesktopRegistryDiffFile,
	type DesktopRegistryDiffRequest,
	type DesktopRegistryDiffResponse,
	type DesktopRequestHistoryResponse,
	type DesktopRuntimeStatusRequest,
	type DesktopRuntimeStatusResponse,
	type DesktopSessionUsageReport,
	type DesktopSessionUsageResponse,
	type DesktopModelUsageStatus,
	type DesktopSessionHistoryRequest,
	type DesktopSessionHistoryResponse,
	type DesktopSessionImageRequest,
	type DesktopSessionImageResponse,
	type DesktopSessionRequest,
	type DesktopResumePathRequest,
	type DesktopToolResultRequest,
	type DesktopToolResultResponse,
	type DesktopUserMessageActionRequest,
	type DesktopUserMessageActionResponse,
	type ForkMessagesResponse,
} from "./desktop-commands.js";
import {
	createDesktopDraftModelRuntime,
	desktopToolsSuiteExtensionPath,
} from "./draft-model-runtime.js";
import {
	bashExecutionErrorUpdate,
	bashExecutionResultUpdate,
	bashExecutionStartUpdate,
} from "./bash-execution.js";
import { loadPixDefaultModel, type PixDefaultModel } from "./default-model.js";
import { launchClaudeCodeLoginNudge } from "./claude-code-login-nudge.js";
import {
	defaultRoutingDecision,
	loadModelRoutingConfig,
	routeModelWithRuntime,
} from "./model-routing.js";
import { EventTranslator } from "./event-translator.js";
import { createGitAssistant, type GitAssistant } from "./git-assistant.js";
import {
	isThinkingLevel,
	loadPixIgnoreContextFiles,
	loadPixCommandSettings,
	parseModelRef as parsePixModelRef,
	savePixAutocompleteModel,
	savePixDefaultModel,
	savePixDefaultThinking,
	saveProjectPixIgnoreContextFiles,
} from "./pix-settings.js";
import { createPromptEnhancer, type PromptEnhancer } from "./prompt-enhancer.js";
import {
	loadDesktopQueues,
	saveDesktopQueues,
	type PersistedDesktopQueues,
} from "./queue-store.js";
import {
	BUILTIN_SLASH_COMMANDS,
	builtinFeedback,
	builtinUsageError,
	parseBuiltinCommand,
	rendererCommandName,
	unsupportedCommandName,
	type BuiltinCommand,
} from "./slash-commands.js";
import { SessionMapStore, type SessionMapRecord } from "./session-map.js";
import {
	readPersistedHistoryTail,
	readPersistedHistoryBefore,
	readPersistedImage,
	readPersistedToolResult,
	type PersistedImageRef,
	type PersistedToolResultRef,
} from "./session-history-file.js";
import {
	deferredSessionHistory,
	deferredSessionHistoryFromMessages,
	deferredToolResultUpdate,
	replaySessionHistory,
	type DeferredImageResult,
	type DeferredSessionHistory,
	type DeferredToolResult,
} from "./session-replay.js";
import { loadTuiTabSnapshot, type TuiTabSnapshot } from "./tui-tabs.js";
import { cancelledResponse, fromElicitationResponse, toElicitationRequest, PIX_QUESTION_ELICITATION_MODE } from "./ui-request-bridge.js";
import {
	PIX_CONTEXT_USAGE_CHANNEL,
	PIX_DCP_CONTEXT_MAP_CHANNEL,
	PIX_DCP_TOKENS_SAVED_CHANNEL,
	PIX_MODEL_USAGE_CHANNEL,
	PIX_SESSION_STATE_METHOD,
	sessionStateEnvelopeFromUiRequest,
	type PixSessionStateNotification,
} from "./session-state-bridge.js";
import {
	CONTEXT_INVENTORY_EVENT,
	formatReloadContextInventory,
	parseContextInventoryState,
	withFinalSkillCommands,
	type ContextInventoryState,
} from "./context-inventory.js";

/** Minimal shape of the handler `client` context used for notifications and elicitations. */
type ClientCaller = {
	notify(method: "session/update", params: SessionNotification): Promise<void>;
	notify(method: typeof PIX_SESSION_STATE_METHOD, params: PixSessionStateNotification): Promise<void>;
	notify(method: typeof PIX_QUEUE_STATE_METHOD, params: DesktopQueueStateResponse): Promise<void>;
	notify(method: typeof PIX_QUEUE_CONSUMED_METHOD, params: DesktopQueueConsumedNotification): Promise<void>;
	request(method: "elicitation/create", params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
};

// JSON-RPC server-error range; plain `throw new Error(...)` would surface
// to the client as an opaque "Internal error".
const ERROR_SERVER = -32000;
const ERROR_INVALID_PARAMS = -32602;
const WORKSPACE_UNDO_RPC_COMMAND = "__pix-workspace-undo";
const WORKSPACE_UNDO_RESULT_CHANNEL = "pix.workspace-undo-result";
let requestHistorySaveChain: Promise<void> = Promise.resolve();

type WorkspaceUndoBridgeResult = {
	requestId: string;
	status: "ok" | "warning" | "cancelled" | "error";
	revertedChanges?: number;
	changedFiles?: number;
	error?: string;
};

interface ActiveRun {
	/** Whether the client requested cancellation before pi reported its reason. */
	cancelled: boolean;
	/** Extension slash commands report their result through ctx.ui.notify. */
	slashPrompt: boolean;
	/** Whether pi emitted agent_start for this run. */
	started: boolean;
	/** Adopted runs use running as Desktop's unsolicited, pause-ready busy signal. */
	extensionInitiated?: boolean;
	/** A new agent_start invalidates all pending work for this settlement. */
	settlement?: symbol | undefined;
	/** Stop reason captured from `agent_end`, pending `agent_settled`. */
	stopReason: StopReason | undefined;
	resolve: (stopReason: StopReason) => void;
	reject: (error: Error) => void;
}

interface AgentSessionState {
	readonly acpSessionId: string;
	activityOwner: string | undefined;
	readonly activitySnapshots: Map<string, PixSessionStateNotification>;
	cwd: string;
	readonly pi: PiClient;
	readonly client: ClientCaller;
	translator: EventTranslator;
	unsubscribeEvents: (() => void) | undefined;
	unsubscribeExit: (() => void) | undefined;
	activeRun: ActiveRun | undefined;
	agentControlState: DesktopAgentControlState;
	builtinRunning: boolean;
	bashRunning: boolean;
	queueSessionPath: string | undefined;
	queueRevision: number;
	steeringQueue: string[];
	followUpQueue: string[];
	autoUserMessages: DesktopQueuedUserMessage[];
	deferredUserMessages: DesktopQueuedUserMessage[];
	trackedSteeringMessages: DesktopQueuedUserMessage[];
	sdkQueueRestoreAfterInterrupt: { steering: string[]; followUp: string[] } | undefined;
	/** Dialog extension UI requests awaiting an ACP elicitation answer. */
	readonly pendingDialogIds: Set<string>;
	readonly pendingQuestionIds: Set<string>;
	readonly workspaceUndoResults: Map<string, WorkspaceUndoBridgeResult>;
	contextInventory: ContextInventoryState | undefined;
	contextInventoryNoticeReason: "reload" | "model_select" | undefined;
	contextUsagePushGeneration: number;
	/** Guards config-option pushes against session replacement and bursts. */
	configOptionsPushGeneration: number;
	/**
	 * Session-scoped Anthropic API-key usage parsed from provider response
	 * headers. Kept separate from quota `modelUsage` so header pushes can
	 * refresh instantly without invalidating in-flight quota refreshes.
	 */
	headerUsage: DesktopModelUsageStatus | undefined;
	/** Guards model-usage pushes against session replacement and bursts. */
	modelUsagePushGeneration: number;
	/** Runtime extension slash command names (without slash), lower-cased. */
	runtimeExtensionCommands: Set<string>;
	/** An extension slash command is executing outside the run lifecycle. */
	extensionCommandRunning: boolean;
	/** `/wait state` was already requested once for this runtime. */
	quotaWaitStateRequested: boolean;
}

interface PendingDesktopNewSession {
	readonly promise: Promise<{ session: AgentSessionState; configOptions?: SessionConfigOption[] }>;
}

interface DesktopDeferredToolResult {
	readonly result: DeferredToolResult;
	readonly persistedRef?: PersistedToolResultRef;
}

interface DesktopDeferredImage {
	readonly result: DeferredImageResult;
	readonly persistedRef?: PersistedImageRef;
}

interface DesktopPromptFileImage {
	readonly uri: string;
	readonly mimeType: string;
	readonly size?: number;
	readonly name?: string;
}

export interface PixAcpAgentOptions {
	/** Factory for per-session pi RPC clients (injected for tests). */
	readonly createPiClient: (options: PiRpcClientOptions) => PiClient;
	readonly piEntry: string;
	/** Explicit bundled question extension path for Desktop-owned sessions. */
	readonly questionExtensionPath?: string;
	/** Explicit bundled session-title extension path, matching the Pix TUI runtime. */
	readonly sessionTitleExtensionPath?: string;
	/** Bundled Desktop workspace-mutation recorder / undo bridge. */
	readonly workspaceUndoExtensionPath?: string;
	/** Bundled pi-tools-suite extension, including Antigravity model providers. */
	readonly toolsSuiteExtensionPath?: string;
	/** Bundled quota-wait extension providing scheduled continuation. */
	readonly quotaWaitExtensionPath?: string;
	/** Agent resource directory override for hermetic draft-catalog tests. */
	readonly agentDir?: string;
	readonly logger: Logger;
	/** Path of the persistent ACP↔pi session map file. */
	readonly sessionMapPath: string;
	/** Native Pi-session discovery (overridable for hermetic tests). */
	readonly listPiSessions?: (cwd?: string) => Promise<readonly PiSessionInfo[]>;
	/** Reader for the TUI's project tab snapshot (overridable for tests). */
	readonly loadTuiTabs?: (cwd: string) => Promise<TuiTabSnapshot>;
	/** Private prompt-completion backend (overridable for hermetic tests). */
	readonly completeAutocomplete?: AutocompleteCompleter;
	/** Prompt enhancer backend (overridable for hermetic tests). */
	readonly enhancePrompt?: PromptEnhancer;
	/** One-shot Git review/commit-message backend (overridable for hermetic tests). */
	readonly gitAssistant?: GitAssistant;
	/** Direct workspace Registry backend (overridable for transport tests). */
	readonly registryService?: Pick<DesktopRegistryService, "action" | "diff">;
	/** Shared model-usage query (overridable for deterministic concurrency tests). */
	readonly queryModelUsage?: (state: PiSessionState) => Promise<ModelUsageRefreshResult>;
	/**
	 * Headless Claude CLI login nudge for the manual Claude Code quota
	 * refresh (overridable for tests; the default launches a bounded child
	 * whose output is never captured).
	 */
	readonly claudeCodeLoginNudge?: () => Promise<boolean>;
	/**
	 * Parses an Anthropic API-key response-header record into a usage status
	 * (overridable for tests; the default uses the shared Pix module).
	 */
	readonly parseAnthropicUsageHeaders?: (record: PiAnthropicUsageRecord) => Promise<DesktopModelUsageStatus | undefined>;
	/** Pix autocomplete config reader (overridable for hermetic tests). */
	readonly loadAutocompleteConfig?: (cwd: string) => AutocompleteConfig;
	/** Pix default-model reader (overridable for hermetic tests). */
	readonly loadDefaultModel?: (cwd: string) => PixDefaultModel | undefined;
	/** Effective Pix project-context setting (overridable for hermetic tests). */
	readonly loadIgnoreContextFiles?: (cwd: string) => boolean;
	/** Shared Pix queue persistence readers/writers (overridable for hermetic tests). */
	readonly loadDesktopQueues?: (cwd: string, sessionPath: string | undefined) => Promise<PersistedDesktopQueues>;
	readonly saveDesktopQueues?: (cwd: string, sessionPath: string | undefined, queues: PersistedDesktopQueues) => Promise<void>;
	/** Clipboard writer (overridable for hermetic tests). */
	readonly copyText?: (text: string) => Promise<void>;
}

export class PixAcpAgent {
	private readonly sessions = new Map<string, AgentSessionState>();
	/** Desktop may reserve a tab id before its expensive pi runtime has finished starting. */
	private readonly pendingDesktopNewSessions = new Map<string, PendingDesktopNewSession>();
	/** Lazy Desktop tool bodies are cached independently of a live pi runtime. */
	private readonly desktopDeferredToolResults = new Map<string, Map<string, DesktopDeferredToolResult>>();
	private readonly desktopDeferredImages = new Map<string, Map<string, DesktopDeferredImage>>();
	/** Starts already accepted by ACP but not yet registered in `sessions`. */
	private readonly pendingSpawns = new Set<Promise<AgentSessionState>>();
	/** Serializes load/resume/fork/delete/close operations for the same id. */
	private readonly sessionLifecycle = new Map<string, Promise<void>>();
	/** Deduplicates concurrent account-quota I/O for one Desktop session/model/thinking route. */
	private readonly modelUsageRefreshes = new Map<string, Promise<ModelUsageRefreshResult>>();
	/** Last successful quota snapshot per Claude Code route, resent as `stale` cache while the credential is absent. */
	private readonly claudeCodeQuotaCache = new Map<string, DesktopModelUsageStatus>();
	/** Single-flight headless Claude CLI login nudge; at most one child at a time. */
	private claudeLoginNudgeInFlight: Promise<boolean> | undefined;
	/** Deduplicates concurrent manual Claude Code quota refreshes per session. */
	private readonly claudeQuotaRefreshes = new Map<string, Promise<DesktopClaudeQuotaRefreshResponse>>();
	private readonly app: AgentApp;
	private readonly options: PixAcpAgentOptions;
	private readonly sessionMap: SessionMapStore;
	private readonly brainstormHost: BrainstormHost;
	private readonly listPiSessions: (cwd?: string) => Promise<readonly PiSessionInfo[]>;
	private readonly loadTuiTabs: (cwd: string) => Promise<TuiTabSnapshot>;
	private readonly completeAutocomplete: AutocompleteCompleter;
	private readonly enhancePrompt: PromptEnhancer;
	private readonly gitAssistant: GitAssistant;
	private readonly queryModelUsage: (state: PiSessionState) => Promise<ModelUsageRefreshResult>;
	private readonly claudeCodeLoginNudge: () => Promise<boolean>;
	private readonly parseAnthropicUsageHeaders: (record: PiAnthropicUsageRecord) => Promise<DesktopModelUsageStatus | undefined>;
	private readonly loadAutocompleteConfig: (cwd: string) => AutocompleteConfig;
	private readonly loadDefaultModel: (cwd: string) => PixDefaultModel | undefined;
	private readonly loadIgnoreContextFiles: (cwd: string) => boolean;
	private readonly loadDesktopQueues: (cwd: string, sessionPath: string | undefined) => Promise<PersistedDesktopQueues>;
	private readonly saveDesktopQueues: (cwd: string, sessionPath: string | undefined, queues: PersistedDesktopQueues) => Promise<void>;
	private readonly copyText: (text: string) => Promise<void>;
	private readonly registryService: Pick<DesktopRegistryService, "action" | "diff">;
	private disposed = false;
	/** Advertised by the client during `initialize`; gates dialog bridging. */
	private clientCapabilities: ClientCapabilities | null | undefined;
	private clientName: string | undefined;

	constructor(options: PixAcpAgentOptions) {
		this.options = options;
		this.sessionMap = new SessionMapStore(options.sessionMapPath, options.logger);
		this.brainstormHost = new BrainstormHost({
			create: async (parent, participant, link, signal) => {
				const owner = this.sessions.get(parent);
				if (!owner) throw new Error("brainstorm parent session lost");
				const startup = await brainstormParticipantOptions(options.piEntry, owner.cwd, options.toolsSuiteExtensionPath, participant.model);
				signal.throwIfAborted();
				const session = await this.spawnSession(participant.sessionId, owner.cwd, owner.client, undefined, undefined, startup);
				if (signal.aborted) { await this.teardownSession(session); signal.throwIfAborted(); }
				await session.pi.setSessionName(participant.name);
				if (signal.aborted || this.sessions.get(participant.sessionId) !== session) { await this.teardownSession(session); throw new Error("brainstorm participant startup cancelled"); }
				await this.registerSessionRecord(participant.sessionId, owner.cwd, session.pi, participant.name, link);
				if (signal.aborted) {
					await this.teardownSession(session);
					const record = await this.sessionMap.get(participant.sessionId);
					if (record) await this.sessionMap.put({ ...record, brainstorm: this.brainstormHost.metadata(participant.sessionId) ?? link });
					signal.throwIfAborted();
				}
			},
			round: async (participant, task, signal) => {
				const session = this.sessions.get(participant.sessionId);
				if (!session) throw new Error("brainstorm participant session lost; no replacement permitted");
				const state = await session.pi.getState();
				if (`${state.model?.provider}/${state.model?.id}` !== participant.model) throw new Error("brainstorm requested model unavailable (no fallback)");
				await session.pi.setThinkingLevel(task.thinking);
				signal.throwIfAborted();
				return freshParticipantAnswer(session.pi, task.task, () => this.prompt({ sessionId: participant.sessionId, prompt: [{ type: "text", text: task.task }] }, true), signal);
			},
			stop: async (id) => { const session = this.sessions.get(id); if (session) await this.teardownSession(session); },
			link: (id, link) => this.withSessionLifecycle(id, async () => {
				const record = await this.sessionMap.get(id);
				if (record) await this.sessionMap.put({ ...record, brainstorm: link });
			}),
			publish: async (parent, data) => {
				const session = this.sessions.get(parent);
				if (!session) return;
				const envelope: PixSessionStateNotification = { sessionId: parent, channel: BRAINSTORM_CHANNEL, data, ...(session.activityOwner ? { activityOwner: session.activityOwner } : {}) };
				session.activitySnapshots.set(BRAINSTORM_CHANNEL, envelope);
				await session.client.notify(PIX_SESSION_STATE_METHOD, envelope).catch(() => {});
			},
		});
		this.listPiSessions = options.listPiSessions
			?? ((cwd) => cwd ? SessionManager.list(cwd) : SessionManager.listAll());
		this.loadTuiTabs = options.loadTuiTabs ?? ((cwd) => loadTuiTabSnapshot(cwd));
		this.loadAutocompleteConfig = options.loadAutocompleteConfig ?? loadAutocompleteConfig;
		this.loadDefaultModel = options.loadDefaultModel ?? loadPixDefaultModel;
		this.loadIgnoreContextFiles = options.loadIgnoreContextFiles ?? loadPixIgnoreContextFiles;
		this.loadDesktopQueues = options.loadDesktopQueues ?? ((cwd, sessionPath) => loadDesktopQueues(cwd, sessionPath));
		this.saveDesktopQueues = options.saveDesktopQueues ?? ((cwd, sessionPath, queues) => saveDesktopQueues(cwd, sessionPath, queues));
		this.copyText = options.copyText ?? copyTextToClipboard;
		this.registryService = options.registryService ?? new DesktopRegistryService();
		this.completeAutocomplete = options.completeAutocomplete ?? createAutocompleteCompleter({
			logger: options.logger,
			loadConfig: this.loadAutocompleteConfig,
		});
		this.enhancePrompt = options.enhancePrompt ?? createPromptEnhancer();
		this.gitAssistant = options.gitAssistant ?? createGitAssistant();
		this.queryModelUsage = options.queryModelUsage ?? queryPixModelUsage;
		this.claudeCodeLoginNudge = options.claudeCodeLoginNudge ?? launchClaudeCodeLoginNudge;
		this.parseAnthropicUsageHeaders = options.parseAnthropicUsageHeaders ?? parsePixAnthropicUsageHeaders;
		this.app = agent({ name: "pix-acp" })
			.onRequest("initialize", (ctx) => {
				this.clientCapabilities = ctx.params.clientCapabilities;
				this.clientName = typeof ctx.params.clientInfo?.name === "string"
					? ctx.params.clientInfo.name
					: undefined;
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
			.onRequest("session/new", (ctx) => this.newSession(ctx.params, ctx.client))
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
			.onRequest("session/set_mode", async (ctx) => { await this.assertBrainstormWritable(ctx.params.sessionId); return {}; })
			.onRequest("session/prompt", (ctx) => this.prompt(ctx.params))
			.onRequest(PIX_AGENT_CONTROL_METHOD, parseDesktopAgentControlRequest, (ctx) =>
				this.desktopAgentControl(ctx.params),
			)
			.onRequest(PIX_RUNTIME_STATUS_METHOD, parseDesktopRuntimeStatusRequest, (ctx) =>
				this.desktopRuntimeStatus(ctx.params),
			)
			.onRequest(PIX_DCP_STATS_METHOD, parseDesktopSessionRequest, (ctx) =>
				this.desktopDcpStats(ctx.params),
			)
			.onRequest(PIX_SESSION_USAGE_METHOD, parseDesktopSessionRequest, (ctx) =>
				this.desktopSessionUsage(ctx.params),
			)
			.onRequest(PIX_CLAUDE_QUOTA_REFRESH_METHOD, parseDesktopSessionRequest, (ctx) =>
				this.desktopClaudeQuotaRefresh(ctx.params),
			)
			.onRequest(PIX_DRAFT_CONFIG_METHOD, parseDesktopDraftConfigRequest, (ctx) =>
				this.desktopDraftConfig(ctx.params),
			)
			.onRequest(PIX_MODEL_ROUTING_STATUS_METHOD, parseDesktopModelRoutingStatusRequest, (ctx) =>
				this.desktopModelRoutingStatus(ctx.params),
			)
			.onRequest(PIX_MODEL_ROUTE_METHOD, parseDesktopModelRouteRequest, (ctx) =>
				this.desktopRouteModel(ctx.params, ctx.signal),
			)
			.onRequest(PIX_BASH_METHOD, parseDesktopBashRequest, (ctx) =>
				this.desktopBash(ctx.params),
			)
			.onRequest(PIX_CLEAR_TODOS_METHOD, parseDesktopSessionRequest, (ctx) =>
				this.desktopClearTodos(ctx.params),
			)
			.onRequest("pix/autocomplete", parseAutocompleteRequest, (ctx) =>
				this.autocomplete(ctx.params, ctx.signal),
			)
			.onRequest("pix/autocomplete/config", parseAutocompleteSettingsRequest, (ctx) =>
				this.autocompleteConfig(ctx.params),
			)
			.onRequest(PIX_ENHANCE_PROMPT_METHOD, parseDesktopEnhancePromptRequest, (ctx) =>
				this.desktopEnhancePrompt(ctx.params, ctx.signal),
			)
			.onRequest(PIX_GIT_ASSIST_METHOD, parseDesktopGitAssistantRequest, (ctx) =>
				this.desktopGitAssist(ctx.params, ctx.signal),
			)
			.onRequest(PIX_FORK_MESSAGES_METHOD, parseDesktopSessionRequest, (ctx) =>
				this.forkMessages(ctx.params),
			)
			.onRequest(PIX_BRANCH_USER_MESSAGES_METHOD, parseDesktopSessionRequest, (ctx) =>
				this.branchUserMessages(ctx.params),
			)
			.onRequest(PIX_USER_MESSAGE_ACTION_METHOD, parseDesktopUserMessageActionRequest, (ctx) =>
				this.withSessionLifecycle(ctx.params.sessionId, () => this.desktopUserMessageAction(ctx.params)),
			)
			.onRequest(PIX_IMPORT_SESSION_METHOD, parseDesktopImportSessionRequest, (ctx) =>
				this.withSessionLifecycle(ctx.params.sessionId, () => this.importSession(ctx.params)),
			)
			.onRequest(PIX_QUEUE_STATE_METHOD, parseDesktopSessionRequest, (ctx) =>
				this.desktopQueueState(ctx.params),
			)
			.onRequest(PIX_QUEUE_MESSAGE_METHOD, parseDesktopQueueSubmitRequest, (ctx) =>
				this.desktopQueueMessage(ctx.params),
			)
			.onRequest(PIX_DEFER_MESSAGE_METHOD, parseDesktopQueueSubmitRequest, (ctx) =>
				this.desktopDeferMessage(ctx.params),
			)
			.onRequest(PIX_QUEUE_ACTION_METHOD, parseDesktopQueueActionRequest, (ctx) =>
				this.desktopQueueAction(ctx.params),
			)
			.onRequest(PIX_REGISTRY_ACTION_METHOD, parseDesktopRegistryActionRequest, (ctx) =>
				this.desktopRegistryAction(ctx.params, ctx.client),
			)
			.onRequest(PIX_REGISTRY_DIFF_METHOD, parseDesktopRegistryDiffRequest, (ctx) =>
				this.desktopRegistryDiff(ctx.params),
			)
			.onRequest(PIX_TAKE_AUTO_MESSAGE_METHOD, parseDesktopSessionRequest, (ctx) =>
				this.desktopTakeAutoMessage(ctx.params),
			)
			.onRequest(PIX_RELOAD_SESSION_METHOD, parseDesktopSessionRequest, (ctx) =>
				this.withSessionLifecycle(ctx.params.sessionId, () => this.reloadSession(ctx.params, ctx.client)),
			)
			.onRequest(PIX_REQUEST_HISTORY_METHOD, parseDesktopSessionRequest, (ctx) =>
				this.desktopRequestHistory(ctx.params),
			)
			.onRequest(PIX_RESUME_PATH_METHOD, parseDesktopResumePathRequest, (ctx) =>
				this.withSessionLifecycle(ctx.params.sessionId, () => this.resumePath(ctx.params)),
			)
			.onRequest(PIX_SESSION_HISTORY_METHOD, parseDesktopSessionHistoryRequest, (ctx) =>
				this.desktopSessionHistory(ctx.params),
			)
			.onRequest(PIX_TOOL_RESULT_METHOD, parseDesktopToolResultRequest, (ctx) =>
				this.desktopToolResult(ctx.params),
			)
			.onRequest(PIX_SESSION_IMAGE_METHOD, parseDesktopSessionImageRequest, (ctx) =>
				this.desktopSessionImage(ctx.params),
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
		await this.brainstormHost.dispose();
		this.claudeCodeQuotaCache.clear();
		this.claudeQuotaRefreshes.clear();
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

	private async desktopEnhancePrompt(
		params: DesktopEnhancePromptRequest,
		signal: AbortSignal,
	): Promise<DesktopEnhancePromptResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		if (session.activeRun || session.builtinRunning) {
			throw new RequestError(ERROR_SERVER, "prompt enhancement is unavailable while the agent is running");
		}
		const prompt = await this.enhancePrompt({ cwd: session.cwd, draft: params.draft, signal });
		return { prompt };
	}

	private async desktopGitAssist(
		params: DesktopGitAssistantRequest,
		signal: AbortSignal,
	): Promise<DesktopGitAssistantResponse> {
		try {
			const text = await this.gitAssistant({
				cwd: params.cwd,
				kind: params.kind,
				diff: params.diff,
				signal,
			});
			return { text };
		} catch (error) {
			if (error instanceof RequestError) throw error;
			const detail = error instanceof Error ? error.message : String(error);
			throw new RequestError(ERROR_SERVER, `Git assistant failed: ${detail || "unknown error"}`);
		}
	}

	/**
	 * Bridge direct workspace Registry dialogs to Desktop elicitation without
	 * creating or borrowing a conversation/Pi runtime.
	 */
	private registryContext(cwd: string, client: ClientCaller): RegistryContext {
		const ask = async (request: RpcExtensionUIRequest): Promise<{ value?: string; confirmed?: boolean }> => {
			const elicitation = toElicitationRequest(request, { elicitationId: randomUUID() });
			if (!elicitation || this.clientCapabilities?.elicitation?.form == null) return {};
			try {
				const response = fromElicitationResponse(await client.request("elicitation/create", elicitation), request);
				return "value" in response ? { value: response.value } : "confirmed" in response ? { confirmed: response.confirmed } : {};
			}
			catch (error) {
				this.options.logger.warn(`registry elicitation failed: ${stringifyUnknown(error)}`);
				return {};
			}
		};
		return {
			cwd, hasUI: this.clientCapabilities?.elicitation?.form != null,
			ui: {
				confirm: async (title, message) => (await ask({ type: "extension_ui_request", id: randomUUID(), method: "confirm", title, message })).confirmed === true,
				input: async (title, placeholder) => (await ask({ type: "extension_ui_request", id: randomUUID(), method: "input", title, ...(placeholder === undefined ? {} : { placeholder }) })).value,
				editor: async (title, prefill) => (await ask({ type: "extension_ui_request", id: randomUUID(), method: "editor", title, ...(prefill === undefined ? {} : { prefill }) })).value,
				notify: (message, type) => { if (type === "error" || type === "warning") this.options.logger.warn(message); },
			},
		};
	}

	private async desktopRegistryAction(
		params: DesktopRegistryActionRequest,
		client: ClientCaller,
	): Promise<DesktopRegistryActionResponse> {
		const snapshot = await this.registryService.action(params, this.registryContext(params.cwd, client));
		return { snapshot };
	}

	/** Read-only diff between one resource's registry and project-local copies. */
	private async desktopRegistryDiff(
		params: DesktopRegistryDiffRequest,
	): Promise<DesktopRegistryDiffResponse> {
		const payload = await this.registryService.diff(params);
		return { files: desktopRegistryDiffFiles(payload) };
	}

	private async forkMessages(params: DesktopSessionRequest): Promise<ForkMessagesResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		if (session.activeRun || session.builtinRunning) {
			throw new RequestError(ERROR_SERVER, "fork is unavailable while the agent is running");
		}
		return { messages: await session.pi.getForkMessages() };
	}

	private async branchUserMessages(params: DesktopSessionRequest): Promise<ForkMessagesResponse> {
		const session = this.requireDesktopSession(params.sessionId);
		return { messages: branchUserMessagesFromEntries(await session.pi.getEntries()) };
	}

	private async desktopUserMessageAction(
		params: DesktopUserMessageActionRequest,
	): Promise<DesktopUserMessageActionResponse> {
		if (params.action !== "copy") await this.assertBrainstormWritable(params.sessionId);
		const session = this.requireDesktopSession(params.sessionId);
		const messages = branchUserMessagesFromEntries(await session.pi.getEntries());
		const selected = messages.find((message) => message.entryId === params.entryId);
		if (!selected) {
			throw new RequestError(ERROR_SERVER, `user message ${params.entryId} is not on the active session branch`);
		}

		if (params.action === "copy") {
			await this.copyText(selected.text);
			return { status: "ok" };
		}

		if (session.activeRun || session.builtinRunning) {
			throw new RequestError(ERROR_SERVER, "undo changes is unavailable while the agent is running");
		}
		const state = await session.pi.getState();
		if (state.isStreaming || state.isCompacting) {
			throw new RequestError(ERROR_SERVER, "undo changes is unavailable while the session is busy");
		}

		const commands = await session.pi.getCommands();
		if (!commands.some((command) => normalizedRuntimeCommandName(command.name) === WORKSPACE_UNDO_RPC_COMMAND)) {
			throw new RequestError(ERROR_SERVER, "workspace undo bridge is unavailable in this session");
		}

		const requestId = randomUUID();
		session.workspaceUndoResults.delete(requestId);
		session.builtinRunning = true;
		try {
			await session.pi.prompt(`/${WORKSPACE_UNDO_RPC_COMMAND} ${JSON.stringify({ requestId, targetEntryId: params.entryId })}`);
			// Extension-ui events precede the matching RPC prompt response on pi's
			// stdout stream. Yield once as a defensive guard for injected/mock clients.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			const result = session.workspaceUndoResults.get(requestId);
			session.workspaceUndoResults.delete(requestId);
			if (!result) throw new RequestError(ERROR_SERVER, "workspace undo bridge returned no result");
			if (result.status === "error") {
				throw new RequestError(ERROR_SERVER, result.error || "workspace undo failed");
			}
			if (result.status === "cancelled") {
				return { status: "cancelled", editorText: selected.text };
			}
			return {
				status: result.status,
				editorText: selected.text,
				...(result.revertedChanges === undefined ? {} : { revertedChanges: result.revertedChanges }),
				...(result.changedFiles === undefined ? {} : { changedFiles: result.changedFiles }),
				...(result.error ? { warning: result.error } : {}),
			};
		} finally {
			session.builtinRunning = false;
			session.workspaceUndoResults.delete(requestId);
		}
	}

	private async desktopRequestHistory(params: DesktopSessionRequest): Promise<DesktopRequestHistoryResponse> {
		if (!this.sessions.has(params.sessionId)) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		return { entries: await readRequestHistoryEntries() };
	}

	private async desktopBash(params: DesktopBashRequest): Promise<Record<string, never>> {
		await this.assertBrainstormWritable(params.sessionId);
		const session = this.requireDesktopSession(params.sessionId);
		if (session.bashRunning) {
			throw new RequestError(ERROR_SERVER, "a bash command is already running");
		}

		const toolCallId = `pix-bash:${randomUUID()}`;
		const notifyUpdate = async (update: SessionNotification["update"]): Promise<void> => {
			await session.client.notify("session/update", { sessionId: session.acpSessionId, update }).catch((error: unknown) => {
				this.options.logger.warn(`session/update failed: ${stringifyUnknown(error)}`);
			});
		};

		session.bashRunning = true;
		if (this.clientName === "pix-desktop") {
			void queueRequestHistoryEntry(params.displayText).catch(() => undefined);
		}
		await notifyUpdate(bashExecutionStartUpdate(
			toolCallId,
			params.command,
			params.excludeFromContext,
			Date.now(),
		));

		try {
			const result = await session.pi.bash(params.command, params.excludeFromContext);
			await notifyUpdate(bashExecutionResultUpdate(toolCallId, result, Date.now()));
			await this.sessionMap.touch(session.acpSessionId);
			return {};
		} catch (error) {
			await notifyUpdate(bashExecutionErrorUpdate(toolCallId, error, Date.now()));
			throw new RequestError(ERROR_SERVER, `bash command failed: ${stringifyUnknown(error)}`);
		} finally {
			session.bashRunning = false;
		}
	}

	private async desktopClearTodos(params: DesktopSessionRequest): Promise<Record<string, never>> {
		await this.assertBrainstormWritable(params.sessionId);
		const session = this.requireDesktopSession(params.sessionId);
		if (session.activeRun || session.builtinRunning) {
			throw new RequestError(ERROR_SERVER, "session plan clear is unavailable while the agent is running");
		}
		// Claim the session before the first await so simultaneous ACP requests
		// cannot both pass the idle check and dispatch the destructive command.
		session.builtinRunning = true;
		try {
			const state = await session.pi.getState();
			if (state.isStreaming || state.isCompacting) {
				throw new RequestError(ERROR_SERVER, "session plan clear is unavailable while the session is busy");
			}
			await session.pi.clearTodos();
			return {};
		} catch (error) {
			throw new RequestError(ERROR_SERVER, `session plan clear failed: ${stringifyUnknown(error)}`);
		} finally {
			session.builtinRunning = false;
		}
	}

	private async desktopQueueState(params: DesktopSessionRequest): Promise<DesktopQueueStateResponse> {
		const session = this.requireDesktopSession(params.sessionId);
		await this.ensureDesktopQueuesLoaded(session);
		return this.desktopQueueSnapshot(session);
	}

	private async desktopQueueMessage(params: DesktopQueueSubmitRequest): Promise<DesktopQueueSubmitResponse> {
		await this.assertBrainstormWritable(params.sessionId);
		const session = this.requireDesktopSession(params.sessionId);
		await this.ensureDesktopQueuesLoaded(session);
		const message = await this.desktopQueuedMessage(params);
		if (this.clientName === "pix-desktop" && message.displayText.trim()) {
			void queueRequestHistoryEntry(message.displayText).catch(() => undefined);
		}
		const state = await session.pi.getState();
		if (state.isStreaming && !state.isCompacting) {
			const revision = session.queueRevision;
			await session.pi.steer(message.promptText, queueMessageImages(message));
			session.trackedSteeringMessages.push(cloneQueuedUserMessage(message));
			// queue_update normally arrives before the RPC response. Keep an
			// optimistic copy only when it did not, so the Desktop never shows a
			// missing row after Enter during streaming.
			if (session.queueRevision === revision) {
				session.steeringQueue.push(message.promptText);
				session.queueRevision += 1;
			}
			await this.notifyDesktopQueueState(session);
			return { disposition: "steering", itemId: message.id };
		}

		// This is the same local race/compaction queue as Pix TUI. It covers the
		// short window where an ACP prompt is admitted but Pi has not started
		// streaming yet, plus explicit compaction periods.
		session.autoUserMessages.push(cloneQueuedUserMessage(message));
		await this.persistDesktopQueues(session);
		await this.notifyDesktopQueueState(session);
		return { disposition: "auto", itemId: message.id };
	}

	private async desktopDeferMessage(params: DesktopQueueSubmitRequest): Promise<DesktopQueueSubmitResponse> {
		await this.assertBrainstormWritable(params.sessionId);
		const session = this.requireDesktopSession(params.sessionId);
		await this.ensureDesktopQueuesLoaded(session);
		const message = await this.desktopQueuedMessage(params);
		if (this.clientName === "pix-desktop" && message.displayText.trim()) {
			void queueRequestHistoryEntry(message.displayText).catch(() => undefined);
		}
		session.deferredUserMessages.push(cloneQueuedUserMessage(message));
		await this.persistDesktopQueues(session);
		await this.notifyDesktopQueueState(session);
		return { disposition: "deferred", itemId: message.id };
	}

	private async desktopTakeAutoMessage(params: DesktopSessionRequest): Promise<DesktopQueueActionResponse> {
		await this.assertBrainstormWritable(params.sessionId);
		const session = this.requireDesktopSession(params.sessionId);
		await this.ensureDesktopQueuesLoaded(session);
		const state = await session.pi.getState();
		if (session.activeRun || session.builtinRunning || state.isStreaming || state.isCompacting) return {};
		const message = session.autoUserMessages.shift();
		if (!message) return {};
		await this.persistDesktopQueues(session);
		await this.notifyDesktopQueueState(session);
		return { message: cloneQueuedUserMessage(message) };
	}

	private async desktopQueueAction(params: DesktopQueueActionRequest): Promise<DesktopQueueActionResponse> {
		await this.assertBrainstormWritable(params.sessionId);
		const session = this.requireDesktopSession(params.sessionId);
		await this.ensureDesktopQueuesLoaded(session);
		const state = await session.pi.getState();
		const interruptRequired = params.action === "send-now"
			&& (Boolean(session.activeRun) || state.isStreaming || state.isCompacting === true);

		let removed: DesktopQueuedUserMessage;
		if (params.source === "auto" || params.source === "deferred") {
			const source = params.source === "auto" ? session.autoUserMessages : session.deferredUserMessages;
			const candidate = source[params.index];
			if (!candidate || candidate.displayText !== params.text) throw queueItemMissingError();
			removed = source.splice(params.index, 1)[0]!;
			await this.persistDesktopQueues(session);
			if (interruptRequired) {
				const queued = await session.pi.clearQueue();
				session.sdkQueueRestoreAfterInterrupt = {
					steering: [...queued.steering],
					followUp: [...queued.followUp],
				};
				session.steeringQueue = [];
				session.followUpQueue = [];
			}
		} else {
			const sdk = await session.pi.clearQueue();
			const steering = [...sdk.steering];
			const followUp = [...sdk.followUp];
			const messages = params.source === "sdk-steering" ? steering : followUp;
			if (messages[params.index] !== params.text) {
				await this.restoreSdkQueues(session, sdk).catch(() => undefined);
				throw queueItemMissingError();
			}
			messages.splice(params.index, 1);
			const tracked = params.source === "sdk-steering"
				? takeTrackedSteeringMessage(session.trackedSteeringMessages, sdk.steering, params.index)
				: undefined;
			removed = tracked ?? textOnlyQueuedMessage(params.text);

			if (interruptRequired) {
				session.sdkQueueRestoreAfterInterrupt = { steering, followUp };
				session.steeringQueue = [];
				session.followUpQueue = [];
			} else {
				await this.restoreSdkQueues(session, { steering, followUp });
			}
		}

		await this.notifyDesktopQueueState(session);
		if (params.action === "cancel") return {};
		if (params.action === "send-now" && interruptRequired) {
			await this.interruptForQueuedSend(session);
		}
		return {
			message: cloneQueuedUserMessage(removed),
		};
	}

	private async interruptForQueuedSend(session: AgentSessionState): Promise<void> {
		const hadActiveRun = Boolean(session.activeRun);
		await session.pi.abort();
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const state = await session.pi.getState();
			if (!state.isStreaming && !state.isCompacting) break;
			await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
		}
		const state = await session.pi.getState();
		if (state.isStreaming || state.isCompacting) {
			throw new RequestError(ERROR_SERVER, "timed out interrupting the current work before sending the queued message");
		}

		// `agent_settled` restores the remaining SDK queue for an active prompt.
		// Compaction can be busy without an ACP active run, so restore it here.
		if (!hadActiveRun && session.sdkQueueRestoreAfterInterrupt) {
			const queues = session.sdkQueueRestoreAfterInterrupt;
			session.sdkQueueRestoreAfterInterrupt = undefined;
			await this.restoreSdkQueues(session, queues);
		}

		while (hadActiveRun && (session.activeRun || session.sdkQueueRestoreAfterInterrupt) && Date.now() < deadline) {
			await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
		}
		if (session.activeRun || session.sdkQueueRestoreAfterInterrupt) {
			throw new RequestError(ERROR_SERVER, "current prompt did not settle after interruption");
		}
	}

	private requireDesktopSession(sessionId: string): AgentSessionState {
		const session = this.sessions.get(sessionId);
		if (!session) throw new RequestError(ERROR_SERVER, `unknown session ${sessionId}`);
		return session;
	}

	private async desktopQueuedMessage(params: DesktopQueueSubmitRequest): Promise<DesktopQueuedUserMessage> {
		const fileImages = desktopPromptFileImages(params as unknown as PromptRequest);
		const input = await collectPromptInput(params.prompt, fileImages);
		return {
			id: randomUUID(),
			promptText: input.text,
			displayText: params.displayText.trimEnd() || input.text,
			images: input.images.map((image) => ({ ...image })),
		};
	}

	private async ensureDesktopQueuesLoaded(session: AgentSessionState): Promise<void> {
		const state = await session.pi.getState();
		const sessionPath = state.sessionFile ? resolve(state.sessionFile) : undefined;
		if (session.queueSessionPath === sessionPath) return;
		const persisted = await this.loadDesktopQueues(session.cwd, sessionPath);
		session.queueSessionPath = sessionPath;
		session.autoUserMessages = persisted.auto.map(cloneQueuedUserMessage);
		session.deferredUserMessages = persisted.deferred.map(cloneQueuedUserMessage);
	}

	private async persistDesktopQueues(session: AgentSessionState): Promise<void> {
		await this.ensureDesktopQueuesLoaded(session);
		await this.saveDesktopQueues(session.cwd, session.queueSessionPath, {
			auto: session.autoUserMessages,
			deferred: session.deferredUserMessages,
		});
	}

	private desktopQueueSnapshot(session: AgentSessionState): DesktopQueueStateResponse {
		const steering = session.steeringQueue.map((text, index): DesktopQueueItem => ({
			id: queueSdkItemId("sdk-steering", index, text),
			source: "sdk-steering",
			mode: "steering",
			index,
			text,
			...(trackedSteeringMessageAt(session.trackedSteeringMessages, session.steeringQueue, index)
				? { message: trackedSteeringMessageAt(session.trackedSteeringMessages, session.steeringQueue, index)! }
				: {}),
		}));
		const followUp = session.followUpQueue.map((text, index): DesktopQueueItem => ({
			id: queueSdkItemId("sdk-follow-up", index, text),
			source: "sdk-follow-up",
			mode: "follow-up",
			index,
			text,
		}));
		const auto = session.autoUserMessages.map((message, index): DesktopQueueItem => ({
			id: `auto:${message.id}`,
			source: "auto",
			mode: "steering",
			index,
			text: message.displayText,
			message: cloneQueuedUserMessage(message),
		}));
		const deferred = session.deferredUserMessages.map((message, index): DesktopQueueItem => ({
			id: `deferred:${message.id}`,
			source: "deferred",
			mode: "steering",
			index,
			text: message.displayText,
			message: cloneQueuedUserMessage(message),
		}));
		return { sessionId: session.acpSessionId, items: [...steering, ...followUp, ...auto, ...deferred] };
	}

	private async notifyDesktopQueueState(session: AgentSessionState): Promise<void> {
		if (this.sessions.get(session.acpSessionId) !== session) return;
		await session.client.notify(PIX_QUEUE_STATE_METHOD, this.desktopQueueSnapshot(session)).catch((error: unknown) => {
			this.options.logger.warn(`${PIX_QUEUE_STATE_METHOD} failed: ${stringifyUnknown(error)}`);
		});
	}

	private async restoreSdkQueues(
		session: AgentSessionState,
		queues: { steering: readonly string[]; followUp: readonly string[] },
	): Promise<void> {
		for (const text of queues.steering) await session.pi.steer(text);
		for (const text of queues.followUp) await session.pi.followUp(text);
		session.steeringQueue = [...queues.steering];
		session.followUpQueue = [...queues.followUp];
		session.queueRevision += 1;
		await this.notifyDesktopQueueState(session);
	}

	private async desktopSessionHistory(params: DesktopSessionHistoryRequest): Promise<DesktopSessionHistoryResponse> {
		const [record, session] = await Promise.all([
			this.sessionMap.get(params.sessionId),
			Promise.resolve(this.sessions.get(params.sessionId)),
		]);
		if (!record?.piSessionPath && !session) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		const cwd = session?.cwd ?? record!.cwd;
		const context = { sessionId: params.sessionId, cwd };
		let persisted: Awaited<ReturnType<typeof readPersistedHistoryTail>>;
		if (!params.full && record?.piSessionPath) {
			persisted = params.cursor
				? await readPersistedHistoryBefore(record.piSessionPath, params.cursor)
				: await readPersistedHistoryTail(record.piSessionPath);
		}

		let history: DeferredSessionHistory | undefined;
		if (persisted) {
			history = deferredSessionHistoryFromMessages(
				persisted.messages,
				context,
				persisted.replayKeys,
			);
		} else if (!params.cursor && session) {
			const entriesState = await session.pi.getEntries();
			const messages = activeBranchEntries(entriesState.entries, entriesState.leafId)
				.filter((entry) => entry.type === "message" && typeof entry.id === "string" && isRecord(entry.message));
			history = messages.length > 0
				? deferredSessionHistoryFromMessages(
					messages.map((entry) => entry.message as PiAgentMessage),
					context,
					messages.map((entry) => entry.id as string),
				)
				: await deferredSessionHistory(session.pi, context);
		}
		if (!history) throw new RequestError(ERROR_SERVER, `session history ${params.sessionId} is unavailable`);

		const deferred = params.cursor
			? new Map(this.desktopDeferredToolResults.get(params.sessionId) ?? [])
			: new Map<string, DesktopDeferredToolResult>();
		for (const [toolCallId, result] of history.toolResults) {
			const persistedRef = persisted?.toolResultRefs.get(toolCallId);
			deferred.set(toolCallId, {
				result,
				...(persistedRef ? { persistedRef } : {}),
			});
		}
		this.desktopDeferredToolResults.set(params.sessionId, deferred);
		const deferredImages = params.cursor
			? new Map(this.desktopDeferredImages.get(params.sessionId) ?? [])
			: new Map<string, DesktopDeferredImage>();
		for (const [imageId, result] of history.images) {
			const persistedRef = result.persistedImageId
				? persisted?.imageRefs.get(result.persistedImageId)
				: undefined;
			deferredImages.set(imageId, { result, ...(persistedRef ? { persistedRef } : {}) });
		}
		this.desktopDeferredImages.set(params.sessionId, deferredImages);
		return {
			updates: history.updates,
			deferredToolCallIds: [...history.toolResults.keys()],
			...(persisted?.cursor ? { cursor: persisted.cursor } : {}),
		};
	}

	private async desktopSessionImage(params: DesktopSessionImageRequest): Promise<DesktopSessionImageResponse> {
		const cached = this.desktopDeferredImages.get(params.sessionId)?.get(params.imageId);
		if (!cached) throw new RequestError(ERROR_SERVER, `image ${params.imageId} is not available for lazy loading`);
		const materialized = cached.persistedRef
			? await readPersistedImage(cached.persistedRef)
			: cached.result.data
				? { data: cached.result.data, mimeType: cached.result.mimeType }
				: undefined;
		if (!materialized) throw new RequestError(ERROR_SERVER, `image ${params.imageId} could not be materialized`);
		this.desktopDeferredImages.get(params.sessionId)?.delete(params.imageId);
		return materialized;
	}

	private async desktopToolResult(params: DesktopToolResultRequest): Promise<DesktopToolResultResponse> {
		const cached = this.desktopDeferredToolResults.get(params.sessionId)?.get(params.toolCallId);
		if (!cached) {
			throw new RequestError(ERROR_SERVER, `tool result ${params.toolCallId} is not available for lazy loading`);
		}
		const [record, persistedMessage] = await Promise.all([
			this.sessionMap.get(params.sessionId),
			cached.persistedRef ? readPersistedToolResult(cached.persistedRef) : Promise.resolve(undefined),
		]);
		const session = this.sessions.get(params.sessionId);
		const cwd = session?.cwd ?? record?.cwd;
		if (!cwd) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		const deferred: DeferredToolResult = persistedMessage
			? { message: persistedMessage, ...(cached.result.rawInput !== undefined ? { rawInput: cached.result.rawInput } : {}) }
			: cached.result;
		const update = deferredToolResultUpdate(
			{ sessionId: params.sessionId, cwd },
			deferred,
		);
		if (!update) {
			throw new RequestError(ERROR_SERVER, `tool result ${params.toolCallId} could not be materialized`);
		}
		// The Desktop keeps the hydrated result in its transcript, so free the
		// duplicate backend copy as soon as it has been requested once.
		this.desktopDeferredToolResults.get(params.sessionId)?.delete(params.toolCallId);
		return { update };
	}

	private async reloadSession(
		params: DesktopSessionRequest,
		client: ClientCaller,
	): Promise<{ configOptions?: SessionConfigOption[] }> {
		await this.assertBrainstormWritable(params.sessionId);
		const current = this.sessions.get(params.sessionId);
		if (!current) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		if (current.activeRun || current.builtinRunning) {
			throw new RequestError(ERROR_SERVER, "reload is unavailable while the agent is running");
		}
		const state = await current.pi.getState();
		if (state.isStreaming || state.isCompacting) {
			throw new RequestError(ERROR_SERVER, "reload is unavailable while the session is busy");
		}

		const response = await this.loadOrResumeSession(
			{ sessionId: params.sessionId, cwd: current.cwd },
			client,
			{ replay: false, ...(current.activityOwner ? { activityOwner: current.activityOwner } : {}) },
		);
		const replacement = this.sessions.get(params.sessionId);
		if (replacement) {
			let inventory = replacement.contextInventory;
			if (inventory) {
				try {
					inventory = withFinalSkillCommands(inventory, await replacement.pi.getCommands());
					replacement.contextInventory = inventory;
				} catch {
					// The session-start snapshot still provides model/tools/agents; if
					// command discovery fails, keep its conservative skills list.
				}
			}
			await this.notifyAgentMessage(
				replacement,
				formatReloadContextInventory(inventory),
			);
		}
		return response;
	}

	private async resumePath(params: DesktopResumePathRequest): Promise<{ configOptions?: SessionConfigOption[] }> {
		await this.assertBrainstormWritable(params.sessionId);
		const session = this.sessions.get(params.sessionId);
		if (!session) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		if (session.activeRun || session.builtinRunning) {
			throw new RequestError(ERROR_SERVER, "resume is unavailable while the agent is running");
		}
		const state = await session.pi.getState();
		if (state.isStreaming || state.isCompacting) {
			throw new RequestError(ERROR_SERVER, "resume is unavailable while the session is busy");
		}

		const sessionPath = resolve(session.cwd, commandPathArgument(params.path) ?? params.path);
		await this.assertBrainstormPathAvailable(sessionPath);
		const switched = await session.pi.switchSession(sessionPath);
		if (switched.cancelled) {
			throw new RequestError(ERROR_SERVER, "session switch cancelled by an extension");
		}
		await this.syncSessionRecord(session);
		await this.refreshAgentControlState(session);
		const configOptions = await this.safeConfigOptions(session.pi);
		this.scheduleAvailableCommands(session);
		return configOptions ? { configOptions } : {};
	}

	private async importSession(params: DesktopImportSessionRequest): Promise<{ configOptions?: SessionConfigOption[] }> {
		await this.assertBrainstormWritable(params.sessionId);
		const session = this.sessions.get(params.sessionId);
		if (!session) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		if (session.activeRun || session.builtinRunning) {
			throw new RequestError(ERROR_SERVER, "import is unavailable while the agent is running");
		}
		const state = await session.pi.getState();
		if (state.isStreaming || state.isCompacting) {
			throw new RequestError(ERROR_SERVER, "import is unavailable while the session is busy");
		}
		if (!state.sessionFile) throw new RequestError(ERROR_SERVER, "current session has no persisted session file");

		const sourcePath = resolve(session.cwd, commandPathArgument(params.path) ?? params.path);
		await this.assertBrainstormPathAvailable(sourcePath);
		const sourceStat = await stat(sourcePath).catch(() => undefined);
		if (!sourceStat?.isFile()) throw new RequestError(ERROR_SERVER, `import file not found: ${sourcePath}`);

		const sessionDir = SessionManager.open(state.sessionFile).getSessionDir();
		await mkdir(sessionDir, { recursive: true });
		let destinationPath = join(sessionDir, basename(sourcePath));
		const sourceAlreadyStored = resolve(destinationPath) === sourcePath;
		if (!sourceAlreadyStored) {
			const parsed = parse(destinationPath);
			let suffix = 1;
			while (await pathExists(destinationPath)) {
				destinationPath = join(sessionDir, `${parsed.name}-${suffix++}${parsed.ext}`);
			}
			await copyFile(sourcePath, destinationPath);
		}

		try {
			const switched = await session.pi.switchSession(destinationPath);
			if (switched.cancelled) {
				if (!sourceAlreadyStored) await rm(destinationPath, { force: true }).catch(() => undefined);
				throw new RequestError(ERROR_SERVER, "session import cancelled by an extension");
			}
		} catch (error) {
			if (!sourceAlreadyStored) await rm(destinationPath, { force: true }).catch(() => undefined);
			throw error;
		}

		await this.syncSessionRecord(session);
		await this.refreshAgentControlState(session);
		const configOptions = await this.safeConfigOptions(session.pi);
		this.scheduleAvailableCommands(session);
		return configOptions ? { configOptions } : {};
	}

	private async newSession(
		params: { cwd: string; _meta?: Record<string, unknown> | null },
		client: ClientCaller,
	): Promise<NewSessionResponse> {
		const acpSessionId = randomUUID();
		const lazyRuntime = params._meta?.["pix.lazyRuntime"] === true;
		const draftDefaultModel = draftDefaultModelFromMeta(params._meta);
		const activityOwner = activityOwnerFromMeta(params._meta);
		const pending = lazyRuntime
			? Promise.resolve().then(() => this.startNewSession(acpSessionId, params.cwd, client, draftDefaultModel, activityOwner))
			: this.startNewSession(acpSessionId, params.cwd, client, draftDefaultModel, activityOwner);
		if (lazyRuntime) {
			this.pendingDesktopNewSessions.set(acpSessionId, { promise: pending });
			void pending.catch((error: unknown) => {
				this.options.logger.warn(`background session/new failed for ${acpSessionId}: ${stringifyUnknown(error)}`);
			});
			return { sessionId: acpSessionId };
		}

		const ready = await pending;
		return ready.configOptions
			? { sessionId: acpSessionId, configOptions: ready.configOptions }
			: { sessionId: acpSessionId };
	}

	private async startNewSession(
		acpSessionId: string,
		cwd: string,
		client: ClientCaller,
		defaultModelOverride?: PixDefaultModel,
		activityOwner?: string,
	): Promise<{ session: AgentSessionState; configOptions?: SessionConfigOption[] }> {
		let defaultModel = defaultModelOverride;
		if (!defaultModel) {
			try {
				defaultModel = this.loadDefaultModel(cwd);
			} catch (error) {
				throw new RequestError(ERROR_SERVER, `failed to resolve Pix default model: ${stringifyUnknown(error)}`);
			}
		}
		let session: AgentSessionState | undefined;
		let lastError: unknown;
		for (const candidate of defaultModelCandidates(defaultModel)) {
			try {
				session = await this.spawnSession(acpSessionId, cwd, client, candidate, activityOwner);
				break;
			} catch (error) {
				lastError = error;
			}
		}
		if (!session) throw lastError ?? new RequestError(ERROR_SERVER, "failed to start Pix session with configured models");
		this.options.logger.info(`session/new: ${acpSessionId} (cwd: ${cwd})`);
		await this.registerSessionRecord(acpSessionId, cwd, session.pi);
		const configOptions = await this.safeConfigOptions(session.pi);
		this.scheduleAvailableCommands(session);
		return configOptions ? { session, configOptions } : { session };
	}

	private async loadSession(params: LoadSessionRequest, client: ClientCaller): Promise<LoadSessionResponse> {
		const lazyHistory = (params as { _meta?: Record<string, unknown> })._meta?.["pix.lazyHistory"] === true;
		const owner = activityOwnerFromMeta(params._meta);
		const participant = await this.attachBrainstormSession(params.sessionId, owner, !lazyHistory);
		if (participant) return participant;
		if (lazyHistory) {
			const pendingNew = this.pendingDesktopNewSessions.get(params.sessionId);
			if (pendingNew) {
				try {
					const ready = await pendingNew.promise;
					await this.attachActivity(ready.session, owner);
					return ready.configOptions ? { configOptions: ready.configOptions } : {};
				} finally {
					this.pendingDesktopNewSessions.delete(params.sessionId);
				}
			}
			const existing = this.sessions.get(params.sessionId);
			if (existing) {
				await this.attachActivity(existing, owner);
				const configOptions = await this.safeConfigOptions(existing.pi);
				return configOptions ? { configOptions } : {};
			}
		}
		return this.loadOrResumeSession(params, client, { replay: !lazyHistory, ...(owner ? { activityOwner: owner } : {}) });
	}

	/** A reused Pi process still needs a fresh Desktop attachment. Replay only
	 * its two latest activity snapshots, with their original checkedAt values. */
	private async attachActivity(session: AgentSessionState, owner: string | undefined): Promise<void> {
		if (!owner || this.sessions.get(session.acpSessionId) !== session || session.activityOwner === owner) return;
		session.activityOwner = owner;
		for (const snapshot of session.activitySnapshots.values()) {
			await session.client.notify(PIX_SESSION_STATE_METHOD, { ...snapshot, activityOwner: owner });
		}
	}

	private async resumeSession(params: ResumeSessionRequest, client: ClientCaller): Promise<ResumeSessionResponse> {
		const participant = await this.attachBrainstormSession(params.sessionId, activityOwnerFromMeta(params._meta), false);
		if (participant) return participant;
		return this.loadOrResumeSession(params, client, { replay: false });
	}

	private async assertBrainstormWritable(sessionId: string): Promise<void> {
		const link = this.brainstormHost.metadata(sessionId) ?? (await this.sessionMap.get(sessionId))?.brainstorm;
		if (link?.owned) throw new RequestError(ERROR_SERVER, "brainstorm participant is owned by its parent; direct mutations are disabled");
	}

	private async assertBrainstormPathAvailable(path: string): Promise<void> {
		const canonical = await realpath(path).catch(() => resolve(path));
		const owned = (await this.sessionMap.list()).filter((record) => (this.brainstormHost.metadata(record.sessionId) ?? record.brainstorm)?.owned);
		for (const record of owned) {
			const candidate = await realpath(record.piSessionPath).catch(() => resolve(record.piSessionPath));
			if (candidate === canonical) throw new RequestError(ERROR_SERVER, "brainstorm participant history is owned; a second writer is disabled");
		}
	}

	private async attachBrainstormSession(sessionId: string, owner: string | undefined, replay: boolean): Promise<LoadSessionResponse | undefined> {
		const link = this.brainstormHost.metadata(sessionId) ?? (await this.sessionMap.get(sessionId))?.brainstorm;
		if (!link && !this.brainstormHost.ownsRuns(sessionId)) return undefined;
		const session = this.sessions.get(sessionId);
		if (!session) {
			if (link?.owned) throw new RequestError(ERROR_SERVER, "brainstorm participant session lost; cannot resume or replace while owned");
			return undefined;
		}
		await this.attachActivity(session, owner);
		if (replay) await replaySessionHistory(session.pi, { sessionId, cwd: session.cwd }, (notification) => session.client.notify("session/update", notification));
		const configOptions = await this.safeConfigOptions(session.pi);
		return { ...(configOptions ? { configOptions } : {}), ...(link ? { _meta: { "pix.brainstorm": link } } : {}) };
	}

	/** Shared implementation of `session/load` (with replay) and `session/resume`. */
	private async loadOrResumeSession(
		params: { sessionId: string; cwd: string },
		client: ClientCaller,
		options: { replay: boolean; activityOwner?: string },
	): Promise<{ configOptions?: SessionConfigOption[]; _meta?: Record<string, unknown> }> {
		const record = await this.sessionMap.get(params.sessionId);
		if (!record?.piSessionPath) {
			throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		}
		await this.assertBrainstormPathAvailable(record.piSessionPath);
		// Reloading a live session reloads it fresh (the client forgot history).
		if (this.sessions.has(params.sessionId)) await this.closeSession(params.sessionId);

		const session = await this.spawnSession(params.sessionId, params.cwd, client, undefined, options.activityOwner);
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
		await this.refreshAgentControlState(session);

		const configOptions = await this.safeConfigOptions(session.pi);
		this.scheduleAvailableCommands(session);
		return { ...(configOptions ? { configOptions } : {}), ...(record.brainstorm ? { _meta: { "pix.brainstorm": record.brainstorm } } : {}) };
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
		const sessionIdByPath = new Map(records
			.map((record) => [resolve(record.piSessionPath), record.sessionId]));
		const sessions: SessionInfo[] = records.map((record) => {
			const info: SessionInfo = { sessionId: record.sessionId, cwd: record.cwd, updatedAt: record.updatedAt };
			if (record.title !== undefined) info.title = record.title;
			const brainstorm = this.brainstormHost.metadata(record.sessionId) ?? record.brainstorm;
			if (brainstorm) info._meta = { "pix.brainstorm": brainstorm };
			if (record.parentSessionPath !== undefined) {
				const parentSessionId = sessionIdByPath.get(resolve(record.parentSessionPath));
				info._meta = {
					...info._meta,
					"pix.isFork": true,
					...(parentSessionId ? { "pix.parentSessionId": parentSessionId } : {}),
				};
			}
			return info;
		});
		if (!params.cwd) return { sessions };

		let tabs: TuiTabSnapshot = { sessionPaths: [] };
		try {
			tabs = await this.loadTuiTabs(params.cwd);
		} catch (error) {
			this.options.logger.warn(`TUI tab discovery failed: ${stringifyUnknown(error)}`);
		}
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
		await this.assertBrainstormWritable(sessionId);
		const record = await this.sessionMap.get(sessionId);
		this.desktopDeferredToolResults.delete(sessionId);
		this.desktopDeferredImages.delete(sessionId);
		if (this.pendingDesktopNewSessions.has(sessionId) || this.sessions.has(sessionId)) {
			await this.closeSession(sessionId);
		}
		if (record?.piSessionPath) {
			await rm(record.piSessionPath, { force: true }).catch((error: unknown) => {
				throw new RequestError(ERROR_SERVER, `failed to delete session file: ${stringifyUnknown(error)}`);
			});
		}
		await this.sessionMap.delete(sessionId);
		this.options.logger.info(`session/delete: ${sessionId}`);
	}

	private async forkSession(params: ForkSessionRequest, client: ClientCaller): Promise<{ sessionId: string; configOptions?: SessionConfigOption[]; _meta?: Record<string, unknown> }> {
		await this.assertBrainstormWritable(params.sessionId);
		const record = await this.sessionMap.get(params.sessionId);
		if (!record?.piSessionPath) {
			throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		}
		await this.assertBrainstormPathAvailable(record.piSessionPath);
		const acpSessionId = randomUUID();
		const cwd = params.cwd || record.cwd;
		const session = await this.spawnSession(acpSessionId, cwd, client, undefined, activityOwnerFromMeta(params._meta));
		let selectedText: string | undefined;
		this.options.logger.info(`session/fork: ${params.sessionId} → ${acpSessionId}`);
		try {
			const switched = await session.pi.switchSession(record.piSessionPath);
			if (switched.cancelled) {
				throw new RequestError(ERROR_SERVER, "session switch cancelled by an extension");
			}
			const entryId = typeof params._meta?.["pix.entryId"] === "string"
				? params._meta["pix.entryId"].trim()
				: "";
			if (entryId) {
				const forked = await session.pi.fork(entryId);
				if (forked.cancelled) {
					throw new RequestError(ERROR_SERVER, "session fork cancelled by an extension");
				}
				selectedText = forked.text;
			} else {
				const cloned = await session.pi.clone();
				if (cloned.cancelled) {
					throw new RequestError(ERROR_SERVER, "session clone cancelled by an extension");
				}
			}
		} catch (error) {
			await this.teardownSession(session);
			if (error instanceof RequestError) throw error;
			throw new RequestError(ERROR_SERVER, `failed to fork session: ${stringifyUnknown(error)}`);
		}
		await this.registerSessionRecord(acpSessionId, cwd, session.pi, record.title);
		const configOptions = await this.safeConfigOptions(session.pi);
		this.scheduleAvailableCommands(session);
		return {
			sessionId: acpSessionId,
			...(configOptions ? { configOptions } : {}),
			...(selectedText !== undefined ? { _meta: { "pix.selectedText": selectedText } } : {}),
		};
	}

	private async setConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		await this.assertBrainstormWritable(params.sessionId);
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
		if (params.configId === CONFIG_ID_MODEL) {
			// Model selection emits extension model_select hooks before set_model
			// returns. Yield once so the structured inventory event can be consumed
			// by this adapter before we render the post-change status message.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			await this.consumeContextInventoryNotice(session, {
				reason: "model_select",
				model: params.value,
			});
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
		activityOwner?: string,
		startupOverride?: PiRpcClientOptions,
	): Promise<AgentSessionState> {
		const pending = this.startSession(acpSessionId, cwd, client, defaultModel, activityOwner, startupOverride);
		this.pendingSpawns.add(pending);
		void pending.finally(() => this.pendingSpawns.delete(pending)).catch(() => {});
		return pending;
	}

	private async startSession(
		acpSessionId: string,
		cwd: string,
		client: ClientCaller,
		defaultModel?: PixDefaultModel,
		activityOwner?: string,
		startupOverride?: PiRpcClientOptions,
	): Promise<AgentSessionState> {
		if (this.disposed) throw new RequestError(ERROR_SERVER, "adapter is shutting down");
		const toolsSuiteExtensionPath = desktopToolsSuiteExtensionPath({
			...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
			...(this.options.toolsSuiteExtensionPath
				? { bundledExtensionPath: this.options.toolsSuiteExtensionPath }
				: {}),
		});
		const startup = startupOverride ?? piClientOptions(
			this.options.piEntry,
			cwd,
			defaultModel,
			this.options.questionExtensionPath,
			this.options.sessionTitleExtensionPath,
			this.options.workspaceUndoExtensionPath,
			toolsSuiteExtensionPath,
			this.options.quotaWaitExtensionPath,
			this.loadIgnoreContextFiles(cwd),
		);
		const hostEnv = !startupOverride && this.clientName === "pix-desktop" ? await this.brainstormHost.environment(acpSessionId) : {};
		const pi = this.options.createPiClient({ ...startup, env: { ...startup.env, ...hostEnv } });
		const translator = new EventTranslator({ sessionId: acpSessionId, cwd });
		const session: AgentSessionState = {
			acpSessionId,
			activityOwner,
			activitySnapshots: new Map(),
			cwd,
			pi,
			client,
			translator,
			unsubscribeEvents: undefined,
			unsubscribeExit: undefined,
			activeRun: undefined,
			agentControlState: "idle",
			builtinRunning: false,
			bashRunning: false,
			queueSessionPath: undefined,
			queueRevision: 0,
			steeringQueue: [],
			followUpQueue: [],
			autoUserMessages: [],
			deferredUserMessages: [],
			trackedSteeringMessages: [],
			sdkQueueRestoreAfterInterrupt: undefined,
			pendingDialogIds: new Set(),
			pendingQuestionIds: new Set(),
			workspaceUndoResults: new Map(),
			contextInventory: undefined,
			contextInventoryNoticeReason: undefined,
			contextUsagePushGeneration: 0,
			configOptionsPushGeneration: 0,
			headerUsage: undefined,
			modelUsagePushGeneration: 0,
			runtimeExtensionCommands: new Set(),
			extensionCommandRunning: false,
			quotaWaitStateRequested: false,
		};
		// Register routing before start so session_start extension state emitted
		// during RPC startup is delivered instead of being dropped.
		this.sessions.set(acpSessionId, session);
		const unsubscribeEvents = pi.onEvent((event) => this.onPiEvent(session, event));
		session.unsubscribeEvents = unsubscribeEvents;
		try {
			await pi.start();
		} catch (error) {
			await this.brainstormHost.cancelParent(acpSessionId, true);
			this.unsubscribeSessionEvents(session);
			if (this.sessions.get(acpSessionId) === session) this.sessions.delete(acpSessionId);
			void pi.stop().catch(() => {});
			throw new RequestError(
				ERROR_SERVER,
				`failed to start pi (${this.options.piEntry}): ${stringifyUnknown(error)}`,
			);
		}
		if (this.disposed || this.sessions.get(acpSessionId) !== session) {
			this.unsubscribeSessionEvents(session);
			if (this.sessions.get(acpSessionId) === session) this.sessions.delete(acpSessionId);
			await pi.stop().catch(() => {});
			throw new RequestError(ERROR_SERVER, "adapter is shutting down");
		}
		session.unsubscribeExit = pi.onExit((error) => this.onPiExit(session, error));
		if (!startupOverride) await this.ensureDesktopQueuesLoaded(session);
		return session;
	}

	/**
	 * Persist the session map entry for a live session. Non-fatal: sessions
	 * keep working without persistence, they just cannot be resumed later.
	 * Council participants fail closed: their stable ownership must be durable
	 * before the first prompt or a catalog refresh could create another writer.
	 */
	private async registerSessionRecord(
		sessionId: string,
		cwd: string,
		pi: PiClient,
		title?: string,
		brainstorm?: BrainstormLink,
	): Promise<void> {
		try {
			const state = await pi.getState();
			if (!state.sessionFile) {
				if (brainstorm) throw new Error("brainstorm participant has no persisted session file");
				this.options.logger.warn(`pi reported no session file for ${sessionId}; not persisting to session map`);
				return;
			}
			await this.sessionMap.put({
				sessionId,
				piSessionPath: state.sessionFile,
				piSessionId: state.sessionId,
				cwd,
				title: title ?? state.sessionName,
				...(brainstorm ? { brainstorm } : {}),
				updatedAt: new Date().toISOString(),
			});
		} catch (error) {
			this.options.logger.warn(`failed to persist session map entry for ${sessionId}: ${stringifyUnknown(error)}`);
			if (brainstorm) throw error;
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
	private async syncSessionRecord(
		session: AgentSessionState,
		title?: string | undefined,
	): Promise<{ titleChanged: boolean; title: string | undefined } | undefined> {
		try {
			const record = await this.sessionMap.get(session.acpSessionId);
			if (!record) return undefined;
			const state = await session.pi.getState();
			const piSessionPath = state.sessionFile ?? record.piSessionPath;
			const nextTitle = title ?? state.sessionName ?? record.title;
			const titleChanged = nextTitle !== record.title;
			if (piSessionPath === record.piSessionPath && nextTitle === record.title) {
				await this.sessionMap.touch(session.acpSessionId);
				return { titleChanged: false, title: nextTitle };
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
			return { titleChanged, title: nextTitle };
		} catch (error) {
			this.options.logger.warn(
				`failed to sync session map entry for ${session.acpSessionId}: ${stringifyUnknown(error)}`,
			);
			return undefined;
		}
	}

	/**
	 * Serialize background metadata refreshes with load/delete/close so an old
	 * pi process cannot recreate a deleted record or overwrite its replacement.
	 */
	private async syncLiveSessionRecord(session: AgentSessionState, title?: string | undefined): Promise<void> {
		const synced = await this.withSessionLifecycle(session.acpSessionId, async () => {
			if (this.sessions.get(session.acpSessionId) !== session) return undefined;
			return await this.syncSessionRecord(session, title);
		});
		if (!synced?.titleChanged || this.sessions.get(session.acpSessionId) !== session) return;
		await this.notifySessionInfo(session, { title: synced.title ?? null });
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

	private async consumeContextInventoryNotice(
		session: AgentSessionState,
		expected: { reason?: "reload" | "model_select"; model?: string } = {},
	): Promise<void> {
		const reason = session.contextInventoryNoticeReason;
		const inventory = session.contextInventory;
		if (!reason || !inventory) return;
		if (expected.reason && reason !== expected.reason) return;
		if (expected.model && inventory.model !== expected.model) return;

		// Clear before awaits so a second event that arrives while command
		// discovery runs remains pending for the next operation instead of being
		// accidentally consumed by this one.
		session.contextInventoryNoticeReason = undefined;
		let finalInventory = inventory;
		try {
			finalInventory = withFinalSkillCommands(finalInventory, await session.pi.getCommands()) ?? finalInventory;
			session.contextInventory = finalInventory;
		} catch {
			// Keep the event snapshot when final command discovery is unavailable.
		}

		const heading = reason === "reload"
			? "Reloaded resources"
			: `Model changed to ${finalInventory.model ?? expected.model ?? "unknown"}`;
		await this.notifyAgentMessage(session, formatReloadContextInventory(finalInventory, heading));
	}

	private onPiEvent(session: AgentSessionState, event: PiEvent): void {
		// A replaced process may still flush events while it is stopping. Never
		// route those events into the newer process registered under the same id.
		if (this.sessions.get(session.acpSessionId) !== session) return;

		if (isExtensionUiRequest(event)) {
			void this.handleExtensionUiRequest(session, event);
			return;
		}
		if (event.type === "queue_update") {
			session.steeringQueue = [...event.steering];
			session.followUpQueue = [...event.followUp];
			session.queueRevision += 1;
			void this.notifyDesktopQueueState(session);
		}
		if (event.type === "message_start" && event.message.role === "user") {
			const text = queuedUserMessageText(event.message);
			const index = session.trackedSteeringMessages.findIndex((message) => message.promptText === text);
			if (index >= 0) {
				const [message] = session.trackedSteeringMessages.splice(index, 1);
				if (message) {
					void session.client.notify(PIX_QUEUE_CONSUMED_METHOD, {
						sessionId: session.acpSessionId,
						message: cloneQueuedUserMessage(message),
					}).catch((error: unknown) => {
						this.options.logger.warn(`${PIX_QUEUE_CONSUMED_METHOD} failed: ${stringifyUnknown(error)}`);
					});
				}
			}
		}
		if (
			event.type === "message_end"
			|| (event.type === "compaction_end" && !event.aborted && event.result)
		) {
			this.scheduleContextUsagePush(session);
		}
		if (event.type === "message_end") {
			// Provider responses carrying Anthropic rate-limit headers have just
			// been recorded by the pi entry; refresh the pushed usage snapshot
			// without any network request.
			this.scheduleModelUsagePush(session);
		}
		if (event.type === "thinking_level_changed") {
			// Server-side thinking changes (todo-thinking overrides, builtin
			// /thinking and /model commands) are not visible through the event
			// translator; re-push the config options so clients can refresh
			// their model/thought-level indicators like pi's TUI footer does.
			this.scheduleConfigOptionsPush(session);
		}
		this.dispatchSessionEvent(session, event);
	}

	private scheduleContextUsagePush(session: AgentSessionState): void {
		const generation = ++session.contextUsagePushGeneration;
		queueMicrotask(() => void this.pushContextUsage(session, generation));
	}

	private async pushContextUsage(session: AgentSessionState, generation: number): Promise<void> {
		if (
			this.sessions.get(session.acpSessionId) !== session
			|| session.contextUsagePushGeneration !== generation
		) return;

		try {
			const stats = await session.pi.getSessionStats();
			if (
				this.sessions.get(session.acpSessionId) !== session
				|| session.contextUsagePushGeneration !== generation
			) return;
			await session.client.notify(PIX_SESSION_STATE_METHOD, {
				sessionId: session.acpSessionId,
				channel: PIX_CONTEXT_USAGE_CHANNEL,
				data: stats.contextUsage ?? null,
			});
			if (this.sessions.get(session.acpSessionId) !== session || session.contextUsagePushGeneration !== generation) return;
			await session.client.notify(PIX_SESSION_STATE_METHOD, {
				sessionId: session.acpSessionId,
				channel: PIX_DCP_TOKENS_SAVED_CHANNEL,
				data: dcpTokensSavedFromStats(stats) ?? null,
			});
			if (this.sessions.get(session.acpSessionId) !== session || session.contextUsagePushGeneration !== generation) return;
			await session.client.notify(PIX_SESSION_STATE_METHOD, {
				sessionId: session.acpSessionId,
				channel: PIX_DCP_CONTEXT_MAP_CHANNEL,
				data: dcpContextMapFromStats(stats) ?? null,
			});
		} catch (error) {
			if (this.sessions.get(session.acpSessionId) !== session) return;
			this.options.logger.warn(`context usage push failed: ${stringifyUnknown(error)}`);
		}
	}

	private scheduleConfigOptionsPush(session: AgentSessionState): void {
		const generation = ++session.configOptionsPushGeneration;
		queueMicrotask(() => void this.pushConfigOptions(session, generation));
	}

	private scheduleModelUsagePush(session: AgentSessionState): void {
		const generation = ++session.modelUsagePushGeneration;
		queueMicrotask(() => void this.pushModelUsage(session, generation));
	}

	/**
	 * Push freshly observed Anthropic API-key response-header usage to Desktop.
	 *
	 * Reads the session-scoped header record through session stats (local RPC,
	 * no provider network), parses it with the shared Pix module, and pushes
	 * the parsed status — or `null` to clear a previously pushed snapshot when
	 * the active session/model no longer has header usage.
	 */
	private async pushModelUsage(session: AgentSessionState, generation: number): Promise<void> {
		if (
			this.sessions.get(session.acpSessionId) !== session
			|| session.modelUsagePushGeneration !== generation
		) return;

		try {
			const [state, stats] = await Promise.all([session.pi.getState(), session.pi.getSessionStats()]);
			if (
				this.sessions.get(session.acpSessionId) !== session
				|| session.modelUsagePushGeneration !== generation
			) return;
			const headerUsage = await this.sessionHeaderUsage(state, stats);
			if (
				this.sessions.get(session.acpSessionId) !== session
				|| session.modelUsagePushGeneration !== generation
			) return;
			// Only notify when something changed: a fresh snapshot, or `null` to
			// clear a previously pushed one. Reading `previous` before parsing
			// matters — the parse result alone cannot tell whether a clear is due.
			const previous = session.headerUsage;
			if (!headerUsage && !previous) return;
			session.headerUsage = headerUsage;
			await session.client.notify(PIX_SESSION_STATE_METHOD, {
				sessionId: session.acpSessionId,
				channel: PIX_MODEL_USAGE_CHANNEL,
				data: headerUsage ?? null,
			});
		} catch (error) {
			if (this.sessions.get(session.acpSessionId) !== session) return;
			this.options.logger.warn(`model usage push failed: ${stringifyUnknown(error)}`);
		}
	}

	/**
	 * Resolve session-scoped Anthropic API-key header usage for the session's
	 * CURRENT model. A record for a different model is ignored, so usage never
	 * leaks across model switches or other sessions. Pure: callers own caching.
	 */
	private async sessionHeaderUsage(
		state: PiSessionState,
		stats: PiSessionStats,
	): Promise<DesktopModelUsageStatus | undefined> {
		const modelKey = state.model ? `${state.model.provider}/${state.model.id}` : undefined;
		const record = anthropicUsageRecordFromStats(stats);
		if (!record || !modelKey || record.modelKey !== modelKey) return undefined;
		const status = await this.parseAnthropicUsageHeaders(record);
		if (!status || status.modelKey !== modelKey) return undefined;
		return status;
	}

	private async pushConfigOptions(session: AgentSessionState, generation: number): Promise<void> {
		if (
			this.sessions.get(session.acpSessionId) !== session
			|| session.configOptionsPushGeneration !== generation
		) return;

		try {
			const configOptions = await this.safeConfigOptions(session.pi);
			if (
				!configOptions
				|| this.sessions.get(session.acpSessionId) !== session
				|| session.configOptionsPushGeneration !== generation
			) return;
			const notification: SessionNotification = {
				sessionId: session.acpSessionId,
				update: { sessionUpdate: "config_option_update", configOptions },
			};
			await session.client.notify("session/update", notification);
		} catch (error) {
			if (this.sessions.get(session.acpSessionId) !== session) return;
			this.options.logger.warn(`config options push failed: ${stringifyUnknown(error)}`);
		}
	}

	/**
	 * The pi process of a session died. Without this, an in-flight
	 * `session/prompt` would hang forever waiting for `agent_settled` events
	 * that can no longer arrive.
	 */
	private onPiExit(session: AgentSessionState, error: Error): void {
		if (this.sessions.get(session.acpSessionId) !== session) return;
		void this.brainstormHost.participantLost(session.acpSessionId);
		void this.brainstormHost.cancelParent(session.acpSessionId, true);
		this.sessions.delete(session.acpSessionId);
		this.pendingDesktopNewSessions.delete(session.acpSessionId);
		this.desktopDeferredToolResults.delete(session.acpSessionId);
		this.desktopDeferredImages.delete(session.acpSessionId);
		this.unsubscribeSessionEvents(session);
		this.options.logger.warn(`session ${session.acpSessionId}: ${error.message}`);
		this.rejectActiveRun(session, error);
		session.pendingDialogIds.clear();
		session.pendingQuestionIds.clear();
	}

	/** Bridges one extension UI request to ACP and answers pi. */
	private async handleExtensionUiRequest(session: AgentSessionState, request: RpcExtensionUIRequest): Promise<void> {
		const state = sessionStateEnvelopeFromUiRequest(request);
		if (state) {
			if (state.channel === WORKSPACE_UNDO_RESULT_CHANNEL) {
				const result = parseWorkspaceUndoBridgeResult(state.data);
				if (result) session.workspaceUndoResults.set(result.requestId, result);
				return;
			}
			if (state.channel === CONTEXT_INVENTORY_EVENT) {
				const inventory = parseContextInventoryState(state.data);
				if (inventory) {
					session.contextInventory = inventory;
					if (inventory.reason === "reload" || inventory.reason === "model_select") {
						session.contextInventoryNoticeReason = inventory.reason;
					}
				}
			}
			const activity = state.channel === "pi-tools-suite:todo:state"
				|| state.channel === "pi-tools-suite:async-subagents:live-state"
				|| state.channel === BRAINSTORM_CHANNEL;
			const envelope: PixSessionStateNotification = {
				sessionId: session.acpSessionId,
				...state,
				...(activity && session.activityOwner ? { activityOwner: session.activityOwner } : {}),
			};
			if (activity) {
				const previous = session.activitySnapshots.get(state.channel);
				const timestamp = activityCheckedAt(state.data);
				const priorTimestamp = previous && activityCheckedAt(previous.data);
				if (!previous || timestamp === undefined || priorTimestamp === undefined || timestamp >= priorTimestamp) {
					session.activitySnapshots.set(state.channel, envelope);
				}
			}
			await session.client.notify(PIX_SESSION_STATE_METHOD, envelope).catch((error: unknown) => {
				this.options.logger.warn(`${PIX_SESSION_STATE_METHOD} failed: ${stringifyUnknown(error)}`);
			});
			return;
		}
		if (request.method === "setTitle") {
			// The bundled session-title extension refreshes the terminal title
			// whenever it changes the persisted session name. RPC exposes that as
			// a fire-and-forget setTitle event, so use it as a cheap wake-up signal
			// and publish the actual session name through standard ACP metadata.
			await this.syncLiveSessionRecord(session);
			return;
		}
		if (request.method === "notify" && (session.activeRun?.slashPrompt || session.extensionCommandRunning)) {
			// Pi RPC sends extension command feedback as a fire-and-forget UI
			// notification. ACP has no equivalent, so put it in the command's
			// visible transcript instead of silently dropping the result.
			await this.notifyAgentMessage(session, request.message);
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
		const isQuestion = elicitation.mode === PIX_QUESTION_ELICITATION_MODE;
		if (isQuestion) session.pendingQuestionIds.add(request.id);
		let interrupted = false;
		try {
			const answer = await session.client.request("elicitation/create", elicitation);
			// The session may have been closed while the user was thinking.
			if (this.sessions.get(session.acpSessionId) !== session) return;
			if (isQuestion && answer._meta?.["_pix/question-interrupted"] === true) {
				interrupted = true;
				return;
			}
			this.safeRespond(session.pi, fromElicitationResponse(answer, request));
		} catch (error) {
			this.options.logger.warn(`elicitation/create failed: ${stringifyUnknown(error)}`);
			interrupted = isQuestion;
			if (!isQuestion && this.sessions.get(session.acpSessionId) === session) {
				this.safeRespond(session.pi, cancelledResponse(request.id));
			}
		} finally {
			session.pendingDialogIds.delete(request.id);
			if (!interrupted) session.pendingQuestionIds.delete(request.id);
		}
	}

	private safeRespond(pi: PiClient, response: RpcExtensionUIResponse): void {
		try {
			pi.respondToExtensionUi(response);
		} catch (error) {
			this.options.logger.warn(`extension_ui_response failed: ${stringifyUnknown(error)}`);
		}
	}

	/** Only the bundled wait controls are safe out-of-band commands. */
	private runtimeExtensionCommandMatches(session: AgentSessionState, text: string): boolean {
		const name = /^\/(\S+)/.exec(text.trim())?.[1]?.toLowerCase();
		return (name === "wait" || name === "quota-wait") && session.runtimeExtensionCommands.has(name);
	}

	/**
	 * Execute a runtime extension slash command without creating an ActiveRun.
	 *
	 * pi dispatches extension commands in prompt preflight even while the
	 * agent is streaming, so this stays safe mid-run; the command result
	 * reaches the transcript through the `notify` UI bridge.
	 */
	private async runExtensionSlashCommand(session: AgentSessionState, text: string): Promise<PromptResponse> {
		session.extensionCommandRunning = true;
		try {
			await session.pi.prompt(text);
		} catch (error) {
			throw new RequestError(ERROR_SERVER, `extension command failed: ${stringifyUnknown(error)}`);
		} finally {
			session.extensionCommandRunning = false;
		}
		return { stopReason: "end_turn" };
	}

	/**
	 * Adopt an agent run the extension started itself (for example the
	 * quota-wait continuation). Without an ActiveRun, Stop/cancel requests
	 * and post-settle agent-control state would have nothing to act on.
	 */
	private beginExtensionRun(session: AgentSessionState): void {
		const run: ActiveRun = {
			cancelled: false,
			slashPrompt: false,
			started: true,
			extensionInitiated: true,
			stopReason: undefined,
			resolve: () => {},
			reject: () => {},
		};
		session.activeRun = run;
		const settled = new Promise<StopReason>((resolve, reject) => {
			run.resolve = resolve;
			run.reject = reject;
		});
		void settled.catch(() => {});
		if (session.agentControlState !== "running") {
			void this.setAgentControlState(session, "running");
		}
	}

	private dispatchSessionEvent(session: AgentSessionState, event: JsonAgentSessionEvent): void {
		for (const notification of session.translator.translate(event)) {
			void session.client.notify("session/update", notification).catch((error: unknown) => {
				this.options.logger.warn(`session/update failed: ${stringifyUnknown(error)}`);
			});
		}

		const run = session.activeRun;
		if (!run) {
			// The extension itself started an agent run (for example the
			// quota-wait hidden continuation). Adopt it so runtime run
			// ownership, stop reasons, and post-settle agent-control state
			// behave like any Desktop-initiated run.
			if (event.type === "agent_start" && !session.builtinRunning) this.beginExtensionRun(session);
			return;
		}
		switch (event.type) {
			case "agent_start":
				// Extensions can start a fresh SDK run while the previous settlement
				// is awaiting RPC snapshots/notifications. Keep the busy owner, but
				// invalidate that completion and discard its reason/cancellation.
				if (run.settlement) {
					run.cancelled = false;
					void this.setAgentControlState(session, run.extensionInitiated ? "running" : "idle");
				}
				run.settlement = undefined;
				run.stopReason = undefined;
				run.started = true;
				if (!run.extensionInitiated && session.agentControlState === "resuming") {
					void this.setAgentControlState(session, "idle");
				}
				return;
			case "agent_end":
				if (!event.willRetry) run.stopReason = stopReasonFromAgentEnd(event);
				return;
			case "agent_settled": {
				// Ignore a late duplicate settlement from the prior run. An early
				// cancellation is the only valid run that can settle before start.
				if ((!run.started && !run.cancelled) || run.settlement) return;
				const settlement = Symbol("agent settlement");
				run.settlement = settlement;
				if (session.sdkQueueRestoreAfterInterrupt) {
					const queues = session.sdkQueueRestoreAfterInterrupt;
					session.sdkQueueRestoreAfterInterrupt = undefined;
					void this.restoreSdkQueues(session, queues)
						.then(() => this.finishActiveRun(session, run, settlement))
						.catch((error: unknown) => {
							if (session.activeRun !== run || run.settlement !== settlement) return;
							this.rejectActiveRun(session, error instanceof Error ? error : new Error(stringifyUnknown(error)));
						});
					return;
				}
				void this.finishActiveRun(session, run, settlement);
				return;
			}
			default:
				return;
		}
	}

	private async desktopAgentControl(params: DesktopAgentControlRequest): Promise<DesktopAgentControlResponse> {
		if (params.action !== "state") await this.assertBrainstormWritable(params.sessionId);
		const session = this.sessions.get(params.sessionId);
		if (!session) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);

		if (params.action === "state") {
			if (!session.activeRun) {
				await this.refreshAgentControlState(
					session,
					session.agentControlState === "paused" ? "paused" : undefined,
				);
			}
			return { sessionId: session.acpSessionId, state: session.agentControlState };
		}

		if (params.action === "pause") {
			if (!session.activeRun || session.activeRun.cancelled || session.builtinRunning) {
				throw new RequestError(ERROR_SERVER, "agent pause is only available while the agent is running");
			}
			if (session.agentControlState === "pause-requested") {
				return { sessionId: session.acpSessionId, state: session.agentControlState };
			}
			await this.setAgentControlState(session, "pause-requested");
			try {
				await session.pi.pause();
			} catch (error) {
				if (this.sessions.get(session.acpSessionId) === session && session.activeRun) {
					await this.setAgentControlState(session, session.activeRun.extensionInitiated ? "running" : "idle");
				}
				throw new RequestError(ERROR_SERVER, `pi pause failed: ${stringifyUnknown(error)}`);
			}
			return { sessionId: session.acpSessionId, state: session.agentControlState };
		}

		if (session.activeRun || session.builtinRunning) {
			throw new RequestError(ERROR_SERVER, "agent continuation is unavailable while the session is running");
		}
		const current = await this.refreshAgentControlState(
			session,
			session.agentControlState === "paused" ? "paused" : "continuable",
		);
		if (current !== "paused" && current !== "continuable") {
			throw new RequestError(ERROR_SERVER, "agent has no continuable turn");
		}

		await this.setAgentControlState(session, "resuming");
		const run: ActiveRun = {
			cancelled: false,
			slashPrompt: false,
			// Keep the normal agent_start guard so a late duplicate settlement from
			// the prior paused/limited run cannot resolve this continuation.
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
		// pi can exit while continue() is still in flight. Attach a rejection
		// handler immediately; the awaited promise below still observes the error.
		void settled.catch(() => {});
		try {
			await session.pi.continue();
		} catch (error) {
			if (session.activeRun === run) session.activeRun = undefined;
			await this.refreshAgentControlState(session, current).catch(() => {});
			throw new RequestError(ERROR_SERVER, `pi continuation failed: ${stringifyUnknown(error)}`);
		}

		let stopReason: StopReason;
		try {
			stopReason = await settled;
		} catch (error) {
			throw new RequestError(ERROR_SERVER, `pi process died: ${stringifyUnknown(error)}`);
		}
		await this.syncLiveSessionRecord(session);
		const state = await this.refreshAgentControlState(session);
		return { sessionId: session.acpSessionId, state, stopReason };
	}

	private async desktopRuntimeStatus(params: DesktopRuntimeStatusRequest): Promise<DesktopRuntimeStatusResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);

		const [state, stats] = await Promise.all([session.pi.getState(), session.pi.getSessionStats()]);
		const modelUsage = params.refreshModelUsage
			? await this.querySessionModelUsage(session.acpSessionId, state)
			: { refresh: "skipped" as const };
		const dcpTokensSaved = dcpTokensSavedFromStats(stats);
		// Header usage comes from the session's recorded provider responses;
		// exposing it costs no provider network request.
		const headerUsage = await this.sessionHeaderUsage(state, stats);

		return {
			sessionId: session.acpSessionId,
			...(stats.contextUsage ? { context: stats.contextUsage } : {}),
			...(dcpTokensSaved !== undefined ? { dcpTokensSaved } : {}),
			dcpContextMap: dcpContextMapFromStats(stats) ?? null,
			modelUsageRefresh: modelUsage.refresh,
			...this.modelUsageResponseFields(state.model, modelUsage),
			...(headerUsage ? { headerUsage } : {}),
		};
	}

	private async desktopDcpStats(params: DesktopSessionRequest): Promise<DesktopDcpStatsResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);

		const [state, stats, entriesState] = await Promise.all([
			session.pi.getState(),
			session.pi.getSessionStats(),
			session.pi.getEntries(),
		]);
		const branch = activeBranchEntries(entriesState.entries, entriesState.leafId);
		const dcpStats = await formatPixDcpStats(state, stats, branch);
		return {
			sessionId: session.acpSessionId,
			...(dcpStats ? { dcpStats } : {}),
		};
	}

	private async desktopSessionUsage(params: DesktopSessionRequest): Promise<DesktopSessionUsageResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);

		const entriesState = await session.pi.getEntries();
		const usage = await aggregatePixSessionUsage(entriesState.entries);
		return { sessionId: session.acpSessionId, usage };
	}

	private async desktopRouteModel(params: DesktopModelRouteRequest, signal: AbortSignal): Promise<DesktopModelRouteResponse> {
		const config = loadModelRoutingConfig(params.cwd);
		const fallback = defaultRoutingDecision(config);
		if (!config.enabled) return fallback;
		const workspaceKey = resolve(params.cwd);
		const toolsSuiteExtensionPath = desktopToolsSuiteExtensionPath({
			...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
			...(this.options.toolsSuiteExtensionPath
				? { bundledExtensionPath: this.options.toolsSuiteExtensionPath }
				: {}),
		});
		try {
			const handle = await createDesktopDraftModelRuntime({
				cwd: workspaceKey,
				...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
				...(toolsSuiteExtensionPath ? { additionalExtensionPaths: [toolsSuiteExtensionPath] } : {}),
			});
			try {
				return await routeModelWithRuntime(handle.modelRuntime, config, params.prompt, params.attachmentCount, signal);
			} finally {
				handle.dispose();
			}
		} catch {
			return fallback;
		}
	}

	private desktopModelRoutingStatus(params: DesktopModelRoutingStatusRequest): DesktopModelRoutingStatusResponse {
		const routing = loadModelRoutingConfig(params.cwd);
		return { enabled: routing.enabled, default: routing.default };
	}

	private async desktopDraftConfig(params: DesktopDraftConfigRequest): Promise<DesktopDraftConfigResponse> {
		const workspaceKey = resolve(params.cwd);
		const modelRouting = loadModelRoutingConfig(params.cwd);
		const modelRoutingEnabled = modelRouting.enabled;
		const modelRoutingDefault = modelRouting.default;
		const toolsSuiteExtensionPath = desktopToolsSuiteExtensionPath({
			...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
			...(this.options.toolsSuiteExtensionPath
				? { bundledExtensionPath: this.options.toolsSuiteExtensionPath }
				: {}),
		});

		let handle: Awaited<ReturnType<typeof createDesktopDraftModelRuntime>>;
		try {
			handle = await createDesktopDraftModelRuntime({
				cwd: workspaceKey,
				...(this.options.agentDir ? { agentDir: this.options.agentDir } : {}),
				...(toolsSuiteExtensionPath
					? { additionalExtensionPaths: [toolsSuiteExtensionPath] }
					: {}),
			});
			await handle.modelRuntime.refresh({ allowNetwork: false });
		} catch (error) {
			throw new RequestError(ERROR_SERVER, `failed to load draft model catalogue: ${stringifyUnknown(error)}`);
		}

		const modelRuntime = handle.modelRuntime;
		try {
			const models = [...modelRuntime.getAvailableSnapshot()] as PiModel[];
			const configured = this.loadDefaultModel(params.cwd);
			let current: PiModel | undefined;
			let selectedDefault = configured;
			const requestedModel = params.modelRef ? parseModelValue(params.modelRef) : undefined;
			if (params.modelRef && !requestedModel) {
				throw new RequestError(ERROR_INVALID_PARAMS, `invalid draft model reference ${params.modelRef}`);
			}
			if (requestedModel) {
				current = models.find((model) => model.provider === requestedModel.provider && model.id === requestedModel.modelId)
					?? modelRuntime.getModel(requestedModel.provider, requestedModel.modelId) as PiModel | undefined;
				if (!current) throw new RequestError(ERROR_INVALID_PARAMS, `unknown draft model ${params.modelRef}`);
				if (!models.some((model) => model.provider === current!.provider && model.id === current!.id)) models.push(current);
				selectedDefault = undefined;
			} else {
				for (const candidate of defaultModelCandidates(configured)) {
					if (!candidate) continue;
					const match = models.find((model) => model.provider === candidate.provider && model.id === candidate.modelId);
					if (!match) continue;
					current = match;
					selectedDefault = candidate;
					break;
				}
				if (!current && configured) {
					current = modelRuntime.getModel(configured.provider, configured.modelId) as PiModel | undefined;
					selectedDefault = configured;
					if (current && !models.some((model) => model.provider === current!.provider && model.id === current!.id)) {
						models.push(current);
					}
				}
			}
			current ??= models[0];
			if (!current) return { configOptions: [], modelUsageRefresh: "unavailable", modelRoutingEnabled, modelRoutingDefault };

			const levels = supportedThinkingLevels(current);
			if (params.thinkingLevel && !levels.includes(params.thinkingLevel)) {
				throw new RequestError(ERROR_INVALID_PARAMS, `${params.modelRef ?? `${current.provider}/${current.id}`} does not support ${params.thinkingLevel} thinking`);
			}
			const thinkingLevel = params.thinkingLevel ?? selectedDefault?.thinkingLevel ?? levels[0] ?? "off";
			const modelUsage = params.refreshModelUsage
				? await this.querySessionModelUsage(`draft:${params.cwd}`, {
					model: current,
					thinkingLevel,
					sessionId: "draft",
					isStreaming: false,
				})
				: { refresh: "skipped" as const };
			return {
				configOptions: [
					modelOption(current, models),
					thoughtLevelOption(thinkingLevel, levels),
				],
				modelUsageRefresh: modelUsage.refresh,
				...this.modelUsageResponseFields(current, modelUsage),
				modelRoutingEnabled,
				modelRoutingDefault,
			};
		} finally {
			handle.dispose();
		}
	}

	private querySessionModelUsage(sessionId: string, state: PiSessionState): Promise<ModelUsageRefreshResult> {
		const model = state.model;
		const key = `${sessionId}\0${model?.provider ?? ""}/${model?.id ?? ""}\0${state.thinkingLevel}`;
		const existing = this.modelUsageRefreshes.get(key);
		if (existing) return existing;

		const pending = this.queryModelUsage(state).then((result) => {
			this.rememberClaudeCodeQuota(model, result);
			return result;
		}).finally(() => {
			if (this.modelUsageRefreshes.get(key) === pending) this.modelUsageRefreshes.delete(key);
		});
		this.modelUsageRefreshes.set(key, pending);
		return pending;
	}

	/** Keep the last successful quota per Claude Code route for stale-cache resend. */
	private rememberClaudeCodeQuota(
		model: PiSessionState["model"] | undefined,
		result: ModelUsageRefreshResult,
	): void {
		if (result.refresh !== "ready" || !result.status || !isClaudeCodeRoute(model)) return;
		this.claudeCodeQuotaCache.set(claudeCodeRouteKey(model), result.status);
	}

	/**
	 * Shared `modelUsage`/`modelUsageCredentialPending` response fields. A
	 * credential-pending unavailability additionally carries the route's last
	 * successful windows as an explicitly `stale` snapshot (windows whose
	 * reset already passed are dropped), so clients can keep a clearly marked
	 * cache instead of an empty display until Claude Code refreshes its login.
	 */
	private modelUsageResponseFields(
		model: PiSessionState["model"] | undefined,
		result: ModelUsageRefreshResult | { refresh: "skipped" },
	): { modelUsage?: DesktopModelUsageStatus; modelUsageCredentialPending?: true } {
		if (result.refresh === "ready" && result.status) return { modelUsage: result.status };
		if (result.refresh === "skipped" || !result.credentialPending) return {};
		const stale = staleClaudeCodeQuotaStatus(this.claudeCodeQuotaCache.get(claudeCodeRouteKey(model)));
		return {
			...(stale ? { modelUsage: stale } : {}),
			modelUsageCredentialPending: true,
		};
	}

	/**
	 * Manual Claude Code quota refresh for the session-usage popover. Only the
	 * active `pi-claude-code-provider` route may use it. It briefly launches
	 * the Claude CLI headless (single-flight: duplicate clicks share one
	 * bounded child, whose output is never captured), then rereads the local
	 * credential through the normal quota query for the route that is current
	 * when the child exits.
	 */
	private async desktopClaudeQuotaRefresh(params: DesktopSessionRequest): Promise<DesktopClaudeQuotaRefreshResponse> {
		const session = this.sessions.get(params.sessionId);
		if (!session) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		const existing = this.claudeQuotaRefreshes.get(session.acpSessionId);
		if (existing) return existing;

		const pending = this.runClaudeQuotaRefresh(session).finally(() => {
			if (this.claudeQuotaRefreshes.get(session.acpSessionId) === pending) {
				this.claudeQuotaRefreshes.delete(session.acpSessionId);
			}
		});
		this.claudeQuotaRefreshes.set(session.acpSessionId, pending);
		return pending;
	}

	private async runClaudeQuotaRefresh(session: AgentSessionState): Promise<DesktopClaudeQuotaRefreshResponse> {
		// Route guard before any child launch: this affordance exists only
		// for the active Claude Code route.
		const initialRoute = (await session.pi.getState()).model;
		if (!isClaudeCodeRoute(initialRoute)) {
			throw new RequestError(ERROR_INVALID_PARAMS, "claude quota refresh requires an active pi-claude-code-provider model");
		}
		const launched = await this.nudgeClaudeCodeLogin();
		// Session guard: the connection must not have forgotten or replaced
		// this session while the bounded child ran.
		if (this.sessions.get(session.acpSessionId) !== session) {
			throw new RequestError(ERROR_SERVER, `session ${session.acpSessionId} changed while refreshing Claude Code limits`);
		}
		// Model guard: the user may have switched models while the child ran.
		// Query the route that is current now and refuse when it is no longer
		// a Claude Code route instead of reporting another selection's quota.
		const state = await session.pi.getState();
		if (!isClaudeCodeRoute(state.model) || claudeCodeRouteKey(state.model) !== claudeCodeRouteKey(initialRoute)) {
			throw new RequestError(ERROR_INVALID_PARAMS, "claude quota refresh requires an active pi-claude-code-provider model");
		}
		const result = await this.queryModelUsage(state);
		// An account/model switch during the endpoint request invalidates its
		// reply just as a switch during the headless nudge does.
		if (this.sessions.get(session.acpSessionId) !== session
			|| claudeCodeRouteKey((await session.pi.getState()).model) !== claudeCodeRouteKey(state.model)) {
			throw new RequestError(ERROR_SERVER, "Claude Code route changed while refreshing limits");
		}
		this.rememberClaudeCodeQuota(state.model, result);
		return {
			sessionId: session.acpSessionId,
			launched,
			refresh: result.refresh,
			...this.modelUsageResponseFields(state.model, result),
		};
	}

	/** At most one headless Claude child at a time; concurrent callers share its outcome. */
	private nudgeClaudeCodeLogin(): Promise<boolean> {
		this.claudeLoginNudgeInFlight ??= this.claudeCodeLoginNudge().finally(() => {
			this.claudeLoginNudgeInFlight = undefined;
		});
		return this.claudeLoginNudgeInFlight;
	}

	private async setAgentControlState(session: AgentSessionState, state: DesktopAgentControlState): Promise<void> {
		if (this.sessions.get(session.acpSessionId) !== session || session.agentControlState === state) return;
		session.agentControlState = state;
		await session.client.notify(PIX_SESSION_STATE_METHOD, {
			sessionId: session.acpSessionId,
			channel: "agent-control",
			data: { state },
		}).catch((error: unknown) => {
			this.options.logger.warn(`${PIX_SESSION_STATE_METHOD} agent-control failed: ${stringifyUnknown(error)}`);
		});
	}

	private async refreshAgentControlState(
		session: AgentSessionState,
		preferred?: "paused" | "continuable",
	): Promise<DesktopAgentControlState> {
		if (this.sessions.get(session.acpSessionId) !== session || session.activeRun) return session.agentControlState;
		const next = await this.deriveAgentControlState(session, preferred);
		if (this.sessions.get(session.acpSessionId) !== session || session.activeRun) return session.agentControlState;
		await this.setAgentControlState(session, next);
		return next;
	}

	private async deriveAgentControlState(
		session: AgentSessionState,
		preferred?: "paused" | "continuable",
	): Promise<DesktopAgentControlState> {
		const [messages, piState] = await Promise.all([session.pi.getMessages(), session.pi.getState()]);
		const lastMessage = messages[messages.length - 1];
		const canContinue = Boolean(lastMessage && lastMessage.role !== "assistant")
			|| (piState.pendingMessageCount ?? 0) > 0;
		return canContinue
			? (preferred ?? (session.agentControlState === "paused" ? "paused" : "continuable"))
			: "idle";
	}

	private async finishActiveRun(session: AgentSessionState, run: ActiveRun, settlement: symbol): Promise<void> {
		const ownsSettlement = () => this.sessions.get(session.acpSessionId) === session
			&& session.activeRun === run && run.settlement === settlement;
		if (!ownsSettlement()) return;
		const pauseRequested = session.agentControlState === "pause-requested";
		const cancelled = run.cancelled;
		if (cancelled) {
			await this.setAgentControlState(session, "idle");
			if (ownsSettlement()) this.resolveActiveRun(session, "cancelled");
			return;
		}
		let next: DesktopAgentControlState;
		try {
			next = await this.deriveAgentControlState(session, pauseRequested ? "paused" : undefined);
		} catch (error) {
			this.options.logger.warn(`agent control state refresh failed: ${stringifyUnknown(error)}`);
			next = pauseRequested ? "paused" : "idle";
		}
		if (!ownsSettlement()) return;
		await this.setAgentControlState(session, next);
		if (ownsSettlement()) this.resolveActiveRun(session, run.stopReason ?? "end_turn");
	}

	private async prompt(params: PromptRequest, brainstormOwned = false): Promise<PromptResponse> {
		if (!brainstormOwned) await this.assertBrainstormWritable(params.sessionId);
		const session = this.sessions.get(params.sessionId);
		if (!session) {
			throw new RequestError(ERROR_SERVER, `session ${params.sessionId} not found`);
		}
		const fileImages = desktopPromptFileImages(params);
		if (fileImages.length > 0 && this.clientName !== "pix-desktop") {
			throw new RequestError(ERROR_SERVER, `${PIX_FILE_IMAGES_META_KEY} is reserved for Pix Desktop`);
		}
		const input = await collectPromptInput(params.prompt, fileImages);
		const isSlashPrompt = !brainstormOwned && input.images.length === 0 && /^\/\S/.test(input.text);

		// Wait controls must not reset an existing paused state or acquire the
		// active run; they also remain available while that run is streaming.
		if (!session.builtinRunning && isSlashPrompt
			&& this.runtimeExtensionCommandMatches(session, input.text)) {
			return await this.runExtensionSlashCommand(session, input.text);
		}

		if (session.activeRun || session.builtinRunning) {
			throw new RequestError(ERROR_SERVER, "a prompt is already in progress for this session");
		}

		// pi TUI built-ins (/compact, /name, /model, ...) have no RPC-side
		// handling; intercept them here. Everything else starting with "/"
		// (extension commands, prompt templates, /skill:*) is forwarded to
		// pi, which expands them natively.
		const builtin = brainstormOwned ? undefined : parseBuiltinCommand(input.text);
		if (builtin) {
			if (input.images.length > 0) {
				throw new RequestError(ERROR_SERVER, `/${builtin.kind} does not accept attachments`);
			}
			const usageError = builtinUsageError(builtin);
			if (usageError) throw new RequestError(ERROR_SERVER, usageError);
			session.builtinRunning = true;
			try {
				return await this.executeBuiltin(session, builtin);
			} finally {
				session.builtinRunning = false;
			}
		}
		const rendererCommand = brainstormOwned ? undefined : rendererCommandName(input.text);
		if (rendererCommand) {
			throw new RequestError(
				ERROR_SERVER,
				`/${rendererCommand} requires Pix renderer UI and is not available as an ACP prompt command`,
			);
		}
		const unsupportedCommand = brainstormOwned ? undefined : unsupportedCommandName(input.text);
		if (unsupportedCommand) {
			throw new RequestError(
				ERROR_SERVER,
				`/${unsupportedCommand} is intentionally not supported in Pix Desktop`,
			);
		}
		if (this.clientName === "pix-desktop" && !isSlashPrompt && input.text.trim()) {
			void queueRequestHistoryEntry(input.text).catch((error: unknown) => {
				this.options.logger.debug(`request history save failed: ${stringifyUnknown(error)}`);
			});
		}
		const run: ActiveRun = {
			cancelled: false,
			slashPrompt: isSlashPrompt,
			started: false,
			stopReason: undefined,
			resolve: () => {},
			reject: () => {},
		};
		void this.setAgentControlState(session, "idle");
		session.activeRun = run;
		const settled = new Promise<StopReason>((resolve, reject) => {
			run.resolve = resolve;
			run.reject = reject;
		});
		// onExit can reject the run before prompt() reaches the final await (for
		// example while session metadata is being synchronized). Handle that
		// rejection immediately so Node never reports it as transiently unhandled.
		void settled.catch(() => {});

		try {
			await session.pi.prompt(input.text, input.images.length > 0 ? input.images : undefined);
		} catch (error) {
			if (session.activeRun === run) session.activeRun = undefined;
			throw new RequestError(ERROR_SERVER, `pi prompt failed: ${stringifyUnknown(error)}`);
		}
		// The bundled session-title extension runs in the input preflight and
		// installs an immediate fallback title before RPC acknowledges prompt().
		// Sync it now so Desktop tabs rename while the agent is still working.
		await this.syncLiveSessionRecord(session);

		// RPC prompt acknowledgement happens after extension/input-hook preflight.
		// Input handled there starts no agent run and therefore emits no
		// agent_settled event; resolve it here instead of leaving ACP clients
		// waiting forever. Normal agent prompts are already streaming by now.
		if (session.activeRun === run && !run.started) {
			try {
				const state = await session.pi.getState();
				if (!state.isStreaming && session.activeRun === run && !run.started) {
					this.resolveActiveRun(session, "end_turn");
				}
			} catch (error) {
				const detail = error instanceof Error ? error.message : stringifyUnknown(error);
				const stateError = new Error(`prompt state inspection failed: ${detail}`);
				this.options.logger.warn(stateError.message);
				this.rejectActiveRun(session, stateError);
			}
		}

		let stopReason: StopReason;
		try {
			stopReason = await settled;
		} catch (error) {
			throw new RequestError(ERROR_SERVER, `pi process died: ${stringifyUnknown(error)}`);
		}
		// Refresh the persisted mapping (updatedAt, plus any pi-side rename)
		// before the ACP prompt resolves. A later resume must never observe the
		// stale path just because the post-settle write was still in flight.
		await this.syncLiveSessionRecord(session);
		if (isSlashPrompt) {
			// Extension commands can reload the Pi runtime from
			// inside the RPC process. Their context-inventory event arrives during
			// the command; consume it only after the prompt has settled so resource
			// discovery and skill command registration are final.
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			await this.consumeContextInventoryNotice(session);
			await this.notifyAvailableCommands(session);
			// Some extension commands mutate the live context entirely in input
			// preflight and therefore never emit agent/message lifecycle events.
			// Publish one boundary snapshot for those commands instead of restoring
			// the old Desktop-wide post-prompt runtime_status poll.
			if (!run.started) this.scheduleContextUsagePush(session);
		}
		return { stopReason };
	}

	/** Execute an intercepted pi TUI built-in and report back as a message. */
	private async executeBuiltin(session: AgentSessionState, command: BuiltinCommand): Promise<PromptResponse> {
		let detail: string | undefined;
		switch (command.kind) {
			case "settings": {
				const [state, levels] = await Promise.all([
					session.pi.getState(),
					session.pi.getAvailableThinkingLevels(),
				]);
				const pix = loadPixCommandSettings();
				const settings = SettingsManager.create(session.cwd);
				detail = formatSettingsSummary(
					state,
					pix,
					settings.getEnabledModels(),
					levels,
					settings.getTheme(),
					settings.getEnableSkillCommands(),
				);
				break;
			}
			case "compact": {
				const result = await session.pi.compact(command.instructions);
				const after = result.estimatedTokensAfter === undefined ? "?" : String(result.estimatedTokensAfter);
				detail = `compacted (~${result.tokensBefore} → ~${after} tokens)`;
				break;
			}
			case "name": {
				if (command.name === undefined) {
					const state = await session.pi.getState();
					detail = state.sessionName ? `current name: "${state.sessionName}"` : "session has no name";
					break;
				}
				await session.pi.setSessionName(command.name);
				await this.syncLiveSessionRecord(session, command.name);
				detail = `session renamed to "${command.name}"`;
				break;
			}
			case "export": {
				const outputPath = commandPathArgument(command.outputPath);
				if (outputPath?.toLowerCase().endsWith(".jsonl")) {
					const state = await session.pi.getState();
					if (!state.sessionFile) throw new RequestError(ERROR_SERVER, "session has no JSONL file to export");
					const destination = resolve(session.cwd, outputPath);
					if (resolve(state.sessionFile) === destination) {
						throw new RequestError(ERROR_SERVER, "export destination is the active session file");
					}
					await mkdir(dirname(destination), { recursive: true });
					await copyFile(state.sessionFile, destination);
					detail = `exported JSONL to ${destination}`;
				} else {
					const destination = outputPath ? resolve(session.cwd, outputPath) : undefined;
					const result = await session.pi.exportHtml(destination);
					detail = `exported HTML to ${result.path}`;
				}
				break;
			}
			case "default-model": {
				const models = await session.pi.getAvailableModels();
				let value = command.value;
				if (value === undefined) {
					value = await this.elicitBuiltinString(session, {
						title: "Default model",
						message: "Choose the model used for new Pix sessions.",
						options: models.map((model) => `${model.provider}/${model.id}`),
					});
					if (value === undefined) return { stopReason: "cancelled" };
				}
				const parsed = parsePixModelRef(value);
				if (!parsed || !models.some((model) => model.provider === parsed.provider && model.id === parsed.modelId)) {
					throw new RequestError(ERROR_SERVER, `unknown model "${value}"`);
				}
				const saved = savePixDefaultModel(value);
				detail = `default model: ${saved}`;
				break;
			}
			case "autocomplete": {
				const models = await session.pi.getAvailableModels();
				let value = command.value;
				if (value === undefined) {
					const disabled = "Disabled";
					const selected = await this.elicitBuiltinString(session, {
						title: "Inline autocomplete",
						message: "Choose an autocomplete model, or disable inline autocomplete.",
						options: [disabled, ...models.map((model) => `${model.provider}/${model.id}`)],
					});
					if (selected === undefined) return { stopReason: "cancelled" };
					value = selected === disabled ? "off" : selected;
				}
				if (["off", "disable", "disabled"].includes(value.toLowerCase())) {
					savePixAutocompleteModel("");
					detail = "inline autocomplete disabled";
					break;
				}
				const parsed = parsePixModelRef(value);
				if (!parsed || !models.some((model) => model.provider === parsed.provider && model.id === parsed.modelId)) {
					throw new RequestError(ERROR_SERVER, `unknown autocomplete model "${value}"`);
				}
				const saved = savePixAutocompleteModel(value);
				detail = `autocomplete model: ${saved}`;
				break;
			}
			case "no-context-files": {
				let value = command.value;
				if (value === undefined) {
					value = await this.elicitBuiltinString(session, {
						title: "Project context files",
						message: [
							`Context file loading is currently ${loadPixIgnoreContextFiles(session.cwd) ? "disabled" : "enabled"}.`,
							"Choose on to disable AGENTS.md/CLAUDE.md loading, or off to enable it.",
						].join("\n"),
						options: ["on", "off"],
					});
					if (value === undefined) return { stopReason: "cancelled" };
				}
				const disabled = value.toLowerCase() === "on";
				saveProjectPixIgnoreContextFiles(session.cwd, disabled);
				detail = `project context files ${disabled ? "disabled" : "enabled"}; reloading the session applies the change`;
				break;
			}
			case "scoped-models": {
				const models = await session.pi.getAvailableModels();
				const settings = SettingsManager.create(session.cwd);
				let value = command.value;
				if (value === undefined) {
					const current = settings.getEnabledModels() ?? [];
					value = await this.elicitBuiltinString(session, {
						title: "Scoped models",
						message: [
							"Enter one or more provider/model[:thinking] references separated by spaces or commas.",
							"Enter reset to use all available models.",
							`Available: ${models.map((model) => `${model.provider}/${model.id}`).join(", ")}`,
						].join("\n"),
						defaultValue: current.join(" "),
					});
					if (value === undefined) return { stopReason: "cancelled" };
				}
				if (["reset", "default", "clear"].includes(value.trim().toLowerCase())) {
					settings.setEnabledModels(undefined);
					detail = "model scope reset to all available models; reload the session to apply it to cycling";
					break;
				}
				const refs = value.split(/[,\s]+/u).map((ref) => ref.trim()).filter(Boolean);
				if (refs.length === 0) throw new RequestError(ERROR_SERVER, "no model references provided");
				for (const ref of refs) {
					const parsed = parsePixModelRef(ref);
					if (!parsed || !models.some((model) => model.provider === parsed.provider && model.id === parsed.modelId)) {
						throw new RequestError(ERROR_SERVER, `unknown model reference "${ref}"`);
					}
				}
				settings.setEnabledModels(refs);
				detail = `scoped models saved: ${refs.join(", ")}; reload the session to apply them to cycling`;
				break;
			}
			case "default-thinking": {
				const state = await session.pi.getState();
				const levels = await session.pi.getAvailableThinkingLevels();
				let level = command.level;
				if (level === undefined) {
					level = await this.elicitBuiltinString(session, {
						title: "Default thinking",
						message: "Choose the thinking level used for new Pix sessions.",
						options: levels,
					});
					if (level === undefined) return { stopReason: "cancelled" };
				}
				if (!isThinkingLevel(level) || !levels.includes(level)) {
					throw new RequestError(ERROR_SERVER, `unknown thought level "${level}"; available: ${levels.join(", ")}`);
				}
				const fallbackModel = state.model ? `${state.model.provider}/${state.model.id}` : undefined;
				const saved = savePixDefaultThinking(level, fallbackModel);
				detail = `default thinking: ${saved}`;
				break;
			}
			case "share": {
				detail = await shareSessionAsGist(session);
				break;
			}
			case "changelog": {
				detail = await readPiChangelog();
				break;
			}
			case "update": {
				detail = await formatPixUpdateReport(command.argumentsText);
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
					const parsed = parsePixModelRef(command.value);
					if (!parsed) {
						throw new RequestError(ERROR_SERVER, `invalid model "${command.value}"; expected provider/modelId[:thinking]`);
					}
					const model = await session.pi.setModel(parsed.provider, parsed.modelId);
					if (parsed.thinkingLevel !== undefined) {
						const levels = await session.pi.getAvailableThinkingLevels();
						if (!levels.includes(parsed.thinkingLevel)) {
							throw new RequestError(
								ERROR_SERVER,
								`unknown thought level "${parsed.thinkingLevel}"; available: ${levels.join(", ")}`,
							);
						}
						await session.pi.setThinkingLevel(parsed.thinkingLevel);
					}
					detail = `switched to ${model.provider}/${model.id}${parsed.thinkingLevel ? `:${parsed.thinkingLevel}` : ""}`;
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
			case "session": {
				const [state, stats] = await Promise.all([
					session.pi.getState(),
					session.pi.getSessionStats(),
				]);
				detail = formatSessionStats(state, stats);
				break;
			}
			case "usage": {
				detail = await formatPixAccountUsage();
				if (!detail) detail = formatUsageStats(await session.pi.getSessionStats());
				break;
			}
			case "tree": {
				if (command.targetId) {
					throw new RequestError(
						ERROR_SERVER,
						"/tree navigation is not exposed by Pi RPC 0.85.1; run /tree without an entry id to inspect the tree",
					);
				}
				const entriesState = await session.pi.getEntries();
				detail = formatSessionTree(entriesState.entries, entriesState.leafId);
				break;
			}
			case "clone": {
				const result = await session.pi.clone();
				if (result.cancelled) {
					throw new RequestError(ERROR_SERVER, "session clone cancelled by an extension");
				}
				await this.syncLiveSessionRecord(session);
				detail = "session duplicated at the current position";
				break;
			}
			case "copy": {
				const text = await session.pi.getLastAssistantText();
				if (!text) throw new RequestError(ERROR_SERVER, "no assistant messages to copy yet");
				await this.copyText(text);
				detail = "copied the last assistant message to the clipboard";
				break;
			}
		}
		await this.notifyAgentMessage(session, builtinFeedback(command, detail ?? "done"));
		await this.sessionMap.touch(session.acpSessionId);
		await this.notifyAvailableCommands(session);
		return { stopReason: "end_turn" };
	}

	private async elicitBuiltinString(
		session: AgentSessionState,
		options: {
			readonly title: string;
			readonly message: string;
			readonly options?: readonly string[];
			readonly defaultValue?: string;
		},
	): Promise<string | undefined> {
		if (this.clientCapabilities?.elicitation?.form == null) {
			throw new RequestError(ERROR_SERVER, "this command requires interactive form support or an explicit argument");
		}
		const property: Record<string, unknown> = {
			type: "string",
			title: options.title,
			...(options.options && options.options.length > 0 ? { enum: [...options.options] } : {}),
			...(options.defaultValue !== undefined ? { default: options.defaultValue } : {}),
		};
		const request = {
			mode: "form",
			elicitationId: randomUUID(),
			sessionId: session.acpSessionId,
			message: options.message,
			requestedSchema: {
				type: "object",
				title: options.title,
				properties: { value: property },
				required: ["value"],
			},
		} as CreateElicitationRequest;
		const response = await session.client.request("elicitation/create", request);
		if (response.action !== "accept") return undefined;
		const content = (response as { content?: Record<string, unknown> | null }).content;
		return typeof content?.value === "string" ? content.value.trim() : undefined;
	}

	/** Defer initial discovery until the session response has attached client-side update routing. */
	private scheduleAvailableCommands(session: AgentSessionState): void {
		setTimeout(() => {
			void this.notifyAvailableCommands(session);
		}, 0);
	}

	private async notifyAvailableCommands(session: AgentSessionState): Promise<void> {
		if (this.sessions.get(session.acpSessionId) !== session) return;
		const availableCommands: AvailableCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
			...(command.inputRequired && command.inputHint ? { input: { hint: command.inputHint } } : {}),
			_meta: {
				"pix.commandSource": "builtin",
				...(command.inputHint ? { "pix.inputHint": command.inputHint } : {}),
				...(command.aliases ? { "pix.aliases": command.aliases } : {}),
			},
		}));
		const names = new Set(
			BUILTIN_SLASH_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])])
				.map((name) => name.toLocaleLowerCase()),
		);

		const runtimeExtensionCommands = new Set<string>();
		try {
			for (const command of await session.pi.getCommands()) {
				if (this.sessions.get(session.acpSessionId) !== session) return;
				const name = command.name.replace(/^\/+/, "");
				const key = name.toLocaleLowerCase();
				if (
					!name
					|| names.has(key)
					|| rendererCommandName(`/${name}`)
					|| normalizedRuntimeCommandName(name) === WORKSPACE_UNDO_RPC_COMMAND
				) continue;
				names.add(key);
				if (command.source === "extension") runtimeExtensionCommands.add(key);
				availableCommands.push({
					name,
					description: command.description ?? runtimeCommandDescription(command.source),
					_meta: { "pix.commandSource": command.source },
				});
			}
		} catch (error) {
			this.options.logger.warn(`failed to discover slash commands: ${stringifyUnknown(error)}`);
		}
		if (this.sessions.get(session.acpSessionId) !== session) return;
		session.runtimeExtensionCommands = runtimeExtensionCommands;

		const notification: SessionNotification = {
			sessionId: session.acpSessionId,
			update: { sessionUpdate: "available_commands_update", availableCommands },
		};
		await session.client.notify("session/update", notification).catch((error: unknown) => {
			this.options.logger.warn(`session/update failed: ${stringifyUnknown(error)}`);
		});
		this.scheduleQuotaWaitStateRefresh(session);
	}

	/**
	 * Ask the quota-wait extension to republish its state once per runtime.
	 *
	 * The extension already publishes on session_start, but the Desktop
	 * frontend can attach after that moment (startup, load, reload); `/wait
	 * state` re-emits the widget channel so the popup never depends on push
	 * timing.
	 */
	private scheduleQuotaWaitStateRefresh(session: AgentSessionState): void {
		if (session.quotaWaitStateRequested || !session.runtimeExtensionCommands.has("wait")) return;
		session.quotaWaitStateRequested = true;
		setTimeout(() => {
			if (this.sessions.get(session.acpSessionId) !== session) return;
			void this.runExtensionSlashCommand(session, "/wait state")
				.catch((error: unknown) => {
					if (this.sessions.get(session.acpSessionId) !== session) return;
					this.options.logger.debug(`quota wait state refresh failed: ${stringifyUnknown(error)}`);
				});
		}, 0);
	}

	/** Emit one agent_message_chunk update (used for built-in feedback). */
	private async notifyAgentMessage(session: AgentSessionState, text: string): Promise<void> {
		const notification: SessionNotification = {
			sessionId: session.acpSessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				messageId: `pix-system:${randomUUID()}`,
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
		if (this.brainstormHost.metadata(sessionId)?.owned) return;
		void this.brainstormHost.cancelParent(sessionId);
		const session = this.sessions.get(sessionId);
		if (!session) return;
		if (session.activeRun) session.activeRun.cancelled = true;
		void this.setAgentControlState(session, "idle");
		this.options.logger.debug(`session/cancel for ${sessionId}`);
		void session.pi.abort().catch((error: unknown) => {
			this.options.logger.warn(`pi abort failed: ${stringifyUnknown(error)}`);
		});
	}

	private async closeSession(sessionId: string): Promise<void> {
		await this.assertBrainstormWritable(sessionId);
		await this.brainstormHost.cancelParent(sessionId, true);
		this.desktopDeferredToolResults.delete(sessionId);
		this.desktopDeferredImages.delete(sessionId);
		const pendingNew = this.pendingDesktopNewSessions.get(sessionId);
		if (pendingNew) {
			this.pendingDesktopNewSessions.delete(sessionId);
			await pendingNew.promise.catch(() => undefined);
		}
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
		// A questionnaire is an interrupted transcript call, not a user Cancel.
		// Stop RPC without answering it so it can reopen after loading the session.
		const hasPendingQuestion = session.pendingQuestionIds.size > 0;
		for (const id of session.pendingDialogIds) {
			if (session.pendingQuestionIds.has(id)) continue;
			this.safeRespond(session.pi, cancelledResponse(id));
		}
		if (hadActiveRun && !hasPendingQuestion) {
			await session.pi.abort().catch((error: unknown) => {
				this.options.logger.warn(`pi abort failed during teardown: ${stringifyUnknown(error)}`);
			});
		}
		await session.pi.stop().catch((error: unknown) => {
			this.options.logger.warn(`pi stop failed: ${stringifyUnknown(error)}`);
		});
		this.unsubscribeSessionEvents(session);
	}

	private unsubscribeSessionEvents(session: AgentSessionState): void {
		session.unsubscribeExit?.();
		session.unsubscribeExit = undefined;
		const unsubscribe = session.unsubscribeEvents;
		if (!unsubscribe) return;
		session.unsubscribeEvents = undefined;
		unsubscribe();
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

function activityOwnerFromMeta(meta: Record<string, unknown> | null | undefined): string | undefined {
	const value = meta?.["pix.activityOwner"];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function activityCheckedAt(data: unknown): number | undefined {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
	const value = (data as { checkedAt?: unknown }).checkedAt;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function draftDefaultModelFromMeta(meta: Record<string, unknown> | null | undefined): PixDefaultModel | undefined {
	const rawModel = meta?.["pix.draftModel"];
	const rawThinking = meta?.["pix.draftThinking"];
	if (rawModel === undefined && rawThinking === undefined) return undefined;
	if (typeof rawModel !== "string") {
		throw new RequestError(ERROR_INVALID_PARAMS, "pix.draftModel must be a provider/model string");
	}
	const parsed = parsePixModelRef(rawModel);
	if (!parsed) throw new RequestError(ERROR_INVALID_PARAMS, "pix.draftModel must use provider/model[:thinking] format");
	if (rawThinking !== undefined && (typeof rawThinking !== "string" || !isThinkingLevel(rawThinking))) {
		throw new RequestError(ERROR_INVALID_PARAMS, "pix.draftThinking is not a supported thinking level");
	}
	const thinkingLevel = typeof rawThinking === "string" ? rawThinking : parsed.thinkingLevel;
	return {
		provider: parsed.provider,
		modelId: parsed.modelId,
		fallbackModels: [],
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
	};
}

function defaultModelCandidates(defaultModel: PixDefaultModel | undefined): Array<PixDefaultModel | undefined> {
	if (!defaultModel) return [undefined];
	const candidates: PixDefaultModel[] = [defaultModel];
	const seen = new Set([`${defaultModel.provider}/${defaultModel.modelId}`]);
	for (const ref of defaultModel.fallbackModels ?? []) {
		const parsed = parsePixModelRef(ref);
		if (!parsed) continue;
		const key = `${parsed.provider}/${parsed.modelId}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({
			provider: parsed.provider,
			modelId: parsed.modelId,
			fallbackModels: [],
			...((parsed.thinkingLevel ?? defaultModel.thinkingLevel) === undefined
				? {}
				: { thinkingLevel: parsed.thinkingLevel ?? defaultModel.thinkingLevel }),
		});
	}
	return candidates;
}

function piClientOptions(
	piEntry: string,
	cwd: string,
	defaultModel?: PixDefaultModel,
	questionExtensionPath?: string,
	sessionTitleExtensionPath?: string,
	workspaceUndoExtensionPath?: string,
	toolsSuiteExtensionPath?: string,
	quotaWaitExtensionPath?: string,
	ignoreContextFiles = false,
): PiRpcClientOptions {
	const args = [
		...(questionExtensionPath ? ["--extension", questionExtensionPath] : []),
		...(sessionTitleExtensionPath ? ["--extension", sessionTitleExtensionPath] : []),
		...(workspaceUndoExtensionPath ? ["--extension", workspaceUndoExtensionPath] : []),
		...(toolsSuiteExtensionPath ? ["--extension", toolsSuiteExtensionPath] : []),
		...(quotaWaitExtensionPath ? ["--extension", quotaWaitExtensionPath] : []),
		...(ignoreContextFiles ? ["--no-context-files"] : []),
	];
	const base = {
		piEntry,
		cwd,
		env: {
			PIX_ACP_SESSION_STATE_BRIDGE: "1",
			...(workspaceUndoExtensionPath ? { PIX_ACP_WORKSPACE_UNDO_BRIDGE: "1" } : {}),
			...(questionExtensionPath ? { PIX_QUESTION_RPC_BRIDGE: "1" } : {}),
		},
		...(args.length > 0 ? { args } : {}),
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
		...(session.parentSessionPath ? { parentSessionPath: resolve(session.parentSessionPath) } : {}),
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

function runtimeCommandDescription(source: "extension" | "prompt" | "skill"): string {
	switch (source) {
		case "extension":
			return "Extension command";
		case "prompt":
			return "Prompt template";
		case "skill":
			return "Skill";
	}
}

function formatSessionStats(state: PiSessionState, stats: PiSessionStats): string {
	const promptTokens = stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite;
	const lines = [
		"**Session info**",
		...(state.sessionName ? [`- Name: ${state.sessionName}`] : []),
		`- File: ${stats.sessionFile ?? "In-memory"}`,
		`- ID: ${stats.sessionId}`,
		`- Messages: ${stats.totalMessages} total (${stats.userMessages} user, ${stats.assistantMessages} assistant)`,
		`- Tools: ${stats.toolCalls} calls, ${stats.toolResults} results`,
		`- Tokens: ${promptTokens} input, ${stats.tokens.output} output, ${stats.tokens.total} total`,
	];
	if (stats.cost > 0) lines.push(`- Cost: $${stats.cost.toFixed(3)}`);
	return lines.join("\n");
}

function formatUsageStats(stats: PiSessionStats): string {
	return [
		"**Usage**",
		`- Input: ${stats.tokens.input}`,
		`- Output: ${stats.tokens.output}`,
		`- Cache read: ${stats.tokens.cacheRead}`,
		`- Cache write: ${stats.tokens.cacheWrite}`,
		`- Total: ${stats.tokens.total}`,
		...(stats.cost > 0 ? [`- Cost: $${stats.cost.toFixed(4)}`] : []),
	].join("\n");
}

type SharedModelUsageModule = {
	modelUsageDescriptor?: (model: PiSessionState["model"], thinkingLevel?: string) => unknown;
	queryModelUsageStatus?: (descriptor: unknown) => Promise<DesktopModelUsageStatus | undefined>;
	/** Local-only Claude Code credential probe (never performs provider network I/O). */
	claudeCodeCredentialAvailable?: () => Promise<boolean>;
};

type SharedHeaderUsageModule = {
	/** Shared Anthropic response-header usage parser (header cache API). */
	anthropicUsageStatusFromResponseHeaders?: (
		headers: Record<string, string>,
		modelKey: string,
		now?: number,
	) => DesktopModelUsageStatus | undefined;
};

type SharedAnthropicAuthModule = {
	resolveAnthropicAuthKind?: () => Promise<"oauth" | "api-key">;
};

type SharedDcpStatsModule = {
	formatDcpStatistics?: (input: {
		branch?: readonly unknown[];
		historyStatus?: "full" | "unavailable";
		model?: PiSessionState["model"];
		usage?: PiSessionStats["contextUsage"];
	}) => string;
};

type SharedSessionUsageModule = {
	aggregateSessionUsage?: (entries: readonly unknown[]) => DesktopSessionUsageReport;
};

function dcpTokensSavedFromStats(stats: PiSessionStats): number | undefined {
	const value = stats.pixDcpTokensSaved;
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.round(value)
		: undefined;
}

/**
 * Validate the raw Anthropic response-header record injected by Pix's RPC
 * entry into session stats. Returns `undefined` for absent or malformed data
 * instead of trusting the child process blindly.
 */
function anthropicUsageRecordFromStats(stats: PiSessionStats): PiAnthropicUsageRecord | undefined {
	const value = stats.pixAnthropicUsage;
	if (!value || typeof value !== "object") return undefined;
	const { modelKey, status, headers, receivedAt } = value;
	if (typeof modelKey !== "string" || !modelKey.includes("/")) return undefined;
	if (typeof status !== "number" || !Number.isFinite(status)) return undefined;
	if (typeof receivedAt !== "number" || !Number.isFinite(receivedAt) || receivedAt <= 0) return undefined;
	if (!headers || typeof headers !== "object" || Array.isArray(headers)) return undefined;
	const bounded: Record<string, string> = {};
	let count = 0;
	for (const [name, headerValue] of Object.entries(headers)) {
		if (typeof headerValue !== "string" || !headerValue.trim()) continue;
		bounded[name.toLowerCase()] = headerValue;
		count += 1;
		if (count >= 64) break;
	}
	if (count === 0) return undefined;
	return { modelKey, status, headers: bounded, receivedAt };
}

/**
 * Parse an Anthropic API-key response-header record with the shared Pix
 * header-usage module (the same parser the TUI uses for its header cache).
 * Degrades to "no usage" when the shared module does not expose the parser.
 */
async function parsePixAnthropicUsageHeaders(
	record: PiAnthropicUsageRecord,
): Promise<DesktopModelUsageStatus | undefined> {
	try {
		const authModuleUrl = new URL("../../../dist/app/model/model-usage-status.js", import.meta.url).href;
		const auth = await import(authModuleUrl) as SharedAnthropicAuthModule;
		// Subscription credentials use the OAuth quota endpoint, even when they
		// were stored as a key. Never display Messages rate limits as that quota.
		if (!auth.resolveAnthropicAuthKind || await auth.resolveAnthropicAuthKind() !== "api-key") return undefined;
		const moduleUrl = new URL("../../../dist/app/model/anthropic-header-usage.js", import.meta.url).href;
		const usage = await import(moduleUrl) as SharedHeaderUsageModule;
		if (!usage.anthropicUsageStatusFromResponseHeaders) return undefined;
		return usage.anthropicUsageStatusFromResponseHeaders(record.headers, record.modelKey, record.receivedAt) ?? undefined;
	} catch {
		return undefined;
	}
}

function dcpContextMapFromStats(stats: PiSessionStats): PiSessionStats["pixDcpContextMap"] {
	const value = stats.pixDcpContextMap;
	const estimates = value?.tokenEstimates;
	if (!value
		|| !Number.isSafeInteger(value.revision) || value.revision <= 0
		|| !Number.isSafeInteger(value.sessionEpoch) || value.sessionEpoch < 0
		|| !Number.isSafeInteger(value.generatedAt) || value.generatedAt <= 0
		|| !Number.isFinite(new Date(value.generatedAt).getTime())
		|| !estimates || ![estimates.candidate, estimates.protected, estimates.compressed, estimates.retained]
			.every((tokens) => Number.isSafeInteger(tokens) && tokens >= 0)) return undefined;
	const total = estimates.candidate + estimates.protected + estimates.compressed + estimates.retained;
	if (!Number.isSafeInteger(total) || total <= 0) return undefined;
	return {
		revision: value.revision, sessionEpoch: value.sessionEpoch,
		generatedAt: value.generatedAt,
		tokenEstimates: { candidate: estimates.candidate, protected: estimates.protected,
			compressed: estimates.compressed, retained: estimates.retained },
	};
}

type ModelUsageRefreshResult = {
	readonly refresh: "ready" | "unavailable" | "failed";
	/** Present for "ready", and for credential-pending "unavailable" with cached stale windows. */
	readonly status?: DesktopModelUsageStatus;
	/**
	 * True when the Claude Code quota refresh was unavailable only because no
	 * usable local credential exists: the usage endpoint was never contacted.
	 */
	readonly credentialPending?: true;
};

async function queryPixModelUsage(state: PiSessionState): Promise<ModelUsageRefreshResult> {
	try {
		const moduleUrl = new URL("../../../dist/app/model/model-usage-status.js", import.meta.url).href;
		const usage = await import(moduleUrl) as SharedModelUsageModule;
		if (!usage.modelUsageDescriptor || !usage.queryModelUsageStatus) return { refresh: "unavailable" };
		const descriptor = usage.modelUsageDescriptor(state.model, state.thinkingLevel);
		if (!descriptor) return { refresh: "unavailable" };
		const status = await usage.queryModelUsageStatus(descriptor);
		if (status) return { refresh: "ready", status };
		// A Claude Code quota miss with no local credential is worth a faster
		// client retry: until Claude Code refreshes its login, each retry costs
		// only local credential reads and no provider network traffic.
		if (
			(descriptor as { kind?: unknown }).kind === "claude-code"
			&& usage.claudeCodeCredentialAvailable
			&& !(await usage.claudeCodeCredentialAvailable())
		) return { refresh: "unavailable", credentialPending: true };
		return { refresh: "unavailable" };
	} catch {
		return { refresh: "failed" };
	}
}

function isClaudeCodeRoute(model: PiSessionState["model"] | undefined): boolean {
	return model?.provider.toLowerCase() === "pi-claude-code-provider";
}

/** Cache key for one Claude Code model route, matching the quota `modelKey`. */
function claudeCodeRouteKey(model: PiSessionState["model"] | undefined): string {
	return `${model?.provider ?? ""}/${model?.id ?? ""}`;
}

/**
 * Cached-display view of the last successful Claude Code quota for one route:
 * windows whose reset already passed are dropped (a reset window describes a
 * quota period that is over), and the snapshot is explicitly marked stale so
 * clients can never present it as current. Returns `undefined` when no window
 * survives.
 */
function staleClaudeCodeQuotaStatus(
	cached: DesktopModelUsageStatus | undefined,
	now = Date.now(),
): DesktopModelUsageStatus | undefined {
	if (!cached) return undefined;
	const hourly = cached.hourly !== undefined && cached.hourly.resetAt > now ? cached.hourly : undefined;
	const weekly = cached.weekly !== undefined && cached.weekly.resetAt > now ? cached.weekly : undefined;
	if (!hourly && !weekly) return undefined;
	const { hourly: _oldHourly, weekly: _oldWeekly, ...withoutWindows } = cached;
	return { ...withoutWindows, stale: true, ...(hourly ? { hourly } : {}), ...(weekly ? { weekly } : {}) };
}

async function aggregatePixSessionUsage(entries: readonly unknown[]): Promise<DesktopSessionUsageReport> {
	const moduleUrl = new URL("../../../dist/app/session/session-usage.js", import.meta.url).href;
	const usage = await import(moduleUrl) as SharedSessionUsageModule;
	if (!usage.aggregateSessionUsage) throw new Error("Pix session usage module is unavailable");
	return usage.aggregateSessionUsage(entries);
}

/**
 * Walk the active branch root-first from flat session entries by following
 * `parentId` links from the leaf. Flat entries (getEntries RPC) are used
 * everywhere instead of the nested tree because deep linear sessions make the
 * SDK tree response exceed the JSON serialization recursion limit.
 */
function activeBranchEntries(entries: readonly PiSessionEntry[], leafId: string | null): readonly Record<string, unknown>[] {
	if (!leafId) return [];
	const byId = new Map<string, PiSessionEntry>();
	for (const entry of entries) {
		if (typeof entry.id === "string") byId.set(entry.id, entry);
	}
	const leaf = byId.get(leafId);
	if (!leaf) return [];
	const branch: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	let cursor: PiSessionEntry | undefined = leaf;
	while (cursor) {
		const id = cursor.id;
		if (id !== undefined) {
			if (seen.has(id)) break;
			seen.add(id);
		}
		branch.push(cursor);
		cursor = typeof cursor.parentId === "string" ? byId.get(cursor.parentId) : undefined;
	}
	branch.reverse();
	return branch;
}

async function formatPixDcpStats(
	state: PiSessionState,
	stats: PiSessionStats,
	branch: readonly Record<string, unknown>[],
): Promise<string | undefined> {
	try {
		const moduleUrl = new URL("../../../external/pi-tools-suite/src/dcp/statistics.js", import.meta.url).href;
		const dcp = await import(moduleUrl) as SharedDcpStatsModule;
		if (!dcp.formatDcpStatistics) return undefined;
		const historyStatus = branch.length > 0 && branch[0]?.parentId != null ? "unavailable" : "full";
		const text = dcp.formatDcpStatistics({
			branch: historyStatus === "full" ? branch : [],
			historyStatus,
			model: state.model,
			usage: stats.contextUsage,
		}).trim();
		return text || undefined;
	} catch {
		return undefined;
	}
}

async function formatPixAccountUsage(): Promise<string | undefined> {
	type AccountUsageModule = {
		queryAccountUsageReport?: () => Promise<unknown>;
		formatAccountUsageReport?: (report: unknown) => string;
	};
	try {
		// Pix Desktop builds the shared TUI package before pix-acp. Reuse the
		// exact account-quota implementation rather than duplicating provider
		// auth/refresh logic here. Standalone ACP builds safely fall back to
		// session token stats when the sibling Pix dist is unavailable.
		const moduleUrl = new URL("../../../dist/app/model/model-usage-status.js", import.meta.url).href;
		const usage = await import(moduleUrl) as AccountUsageModule;
		if (!usage.queryAccountUsageReport || !usage.formatAccountUsageReport) return undefined;
		const report = await usage.queryAccountUsageReport();
		const text = usage.formatAccountUsageReport(report).trim();
		return text || undefined;
	} catch {
		return undefined;
	}
}

function formatSettingsSummary(
	state: PiSessionState,
	pix: ReturnType<typeof loadPixCommandSettings>,
	enabledModels: readonly string[] | undefined,
	levels: readonly string[],
	theme: string | undefined,
	skillCommandsEnabled: boolean,
): string {
	const currentModel = state.model ? `${state.model.provider}/${state.model.id}` : "not selected";
	const defaultModel = pix.defaultModel
		? `${pix.defaultModel.provider}/${pix.defaultModel.modelId}${pix.defaultModel.thinkingLevel ? `:${pix.defaultModel.thinkingLevel}` : ""}`
		: "Pi default";
	return [
		"**Settings**",
		`- Model: ${currentModel}`,
		`- Thinking: ${state.thinkingLevel}`,
		`- Available thinking: ${levels.join(", ") || "none"}`,
		`- Default model: ${defaultModel}`,
		`- Autocomplete: ${pix.autocompleteModelRef || "disabled"}`,
		`- Scoped models: ${enabledModels?.length ? enabledModels.join(", ") : "all available models"}`,
		`- Theme: ${theme ?? "default"}`,
		`- Skill commands: ${skillCommandsEnabled ? "enabled" : "disabled"}`,
		`- Auto compaction: ${state.autoCompactionEnabled === undefined ? "unknown" : state.autoCompactionEnabled ? "enabled" : "disabled"}`,
		`- Steering mode: ${state.steeringMode ?? "unknown"}`,
		`- Follow-up mode: ${state.followUpMode ?? "unknown"}`,
	].join("\n");
}

function formatSessionTree(entries: readonly PiSessionEntry[], leafId: string | null): string {
	if (entries.length === 0) return "**Session tree**\n(empty)";
	const labels = new Map<string, string>();
	for (const entry of entries) {
		if (entry.type !== "label" || typeof entry.targetId !== "string") continue;
		const label = typeof entry.label === "string" ? entry.label : "";
		if (label.trim()) labels.set(entry.targetId, label);
		else labels.delete(entry.targetId);
	}
	type StackNode = { node: PiSessionEntry; depth: number };
	const childrenByParent = new Map<string, PiSessionEntry[]>();
	const roots: PiSessionEntry[] = [];
	const nodes = new Map<string, PiSessionEntry>();
	for (const entry of entries) {
		if (typeof entry.id !== "string") continue;
		nodes.set(entry.id, entry);
	}
	for (const entry of entries) {
		if (typeof entry.id !== "string") continue;
		const parentId = typeof entry.parentId === "string" ? entry.parentId : undefined;
		if (parentId !== undefined && nodes.has(parentId)) {
			const siblings = childrenByParent.get(parentId);
			if (siblings) siblings.push(entry);
			else childrenByParent.set(parentId, [entry]);
		} else {
			roots.push(entry);
		}
	}
	if (roots.length === 0) return "**Session tree**\n(empty)";
	const lines = ["**Session tree**"];
	const stack: StackNode[] = [];
	for (let i = roots.length - 1; i >= 0; i -= 1) stack.push({ node: roots[i]!, depth: 0 });
	while (stack.length > 0) {
		const { node, depth } = stack.pop()!;
		const id = typeof node.id === "string" ? node.id : "?";
		const type = typeof node.type === "string" ? node.type : "entry";
		const active = id === leafId ? "→" : "•";
		const label = labels.get(id)?.trim();
		lines.push(`${"  ".repeat(depth)}${active} ${id} · ${label || treeEntrySummary(node, type)}`);
		const children = childrenByParent.get(id) ?? [];
		for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ node: children[i]!, depth: depth + 1 });
	}
	return lines.join("\n");
}

function treeEntrySummary(entry: Record<string, unknown>, type: string): string {
	if (type !== "message") return type;
	const message = isRecord(entry.message) ? entry.message : undefined;
	const role = typeof message?.role === "string" ? message.role : "message";
	const content = message?.content;
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		text = content.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join(" ");
	}
	const compact = text.replace(/\s+/gu, " ").trim();
	return compact ? `${role}: ${compact.slice(0, 90)}${compact.length > 90 ? "…" : ""}` : role;
}

function commandPathArgument(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	const quote = trimmed[0];
	if (quote === "\"" || quote === "'") {
		const end = trimmed.indexOf(quote, 1);
		return end < 0 ? trimmed.slice(1) : trimmed.slice(1, end);
	}
	return trimmed.split(/\s+/u)[0];
}





/** Validate the registry extension's structured diff payload into ACP files. */
function desktopRegistryDiffFiles(payload: unknown): DesktopRegistryDiffFile[] {
	if (!isRecord(payload) || payload.version !== 1) {
		throw new RequestError(ERROR_SERVER, "resource registry published an invalid diff payload");
	}
	if (payload.error !== undefined && (typeof payload.error !== "string" || payload.error.length === 0)) {
		throw new RequestError(ERROR_SERVER, "resource registry published an invalid diff payload");
	}
	if (typeof payload.error === "string") {
		throw new RequestError(ERROR_SERVER, payload.error);
	}
	if (!Array.isArray(payload.files)) {
		throw new RequestError(ERROR_SERVER, "resource registry published an invalid diff payload");
	}
	const files: DesktopRegistryDiffFile[] = [];
	for (const entry of payload.files) {
		if (
			!isRecord(entry)
			|| typeof entry.path !== "string"
			|| entry.path.length === 0
			|| entry.path.includes("\0")
			|| (entry.oldText !== null && typeof entry.oldText !== "string")
			|| (entry.newText !== null && typeof entry.newText !== "string")
			|| (entry.notice !== undefined && (typeof entry.notice !== "string" || entry.notice.length === 0))
			|| (entry.notice !== undefined && (entry.oldText !== null || entry.newText !== null))
		) {
			throw new RequestError(ERROR_SERVER, "resource registry published an invalid diff file entry");
		}
		files.push({
			path: entry.path,
			oldText: entry.oldText,
			newText: entry.newText,
			...(entry.notice === undefined ? {} : { notice: entry.notice }),
		});
	}
	return files;
}

function cloneQueuedUserMessage(message: DesktopQueuedUserMessage): DesktopQueuedUserMessage {
	return {
		id: message.id,
		promptText: message.promptText,
		displayText: message.displayText,
		images: message.images.map((image) => ({ ...image })),
	};
}

function queueMessageImages(message: DesktopQueuedUserMessage): PiImageContent[] | undefined {
	return message.images.length > 0
		? message.images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }))
		: undefined;
}

function textOnlyQueuedMessage(text: string): DesktopQueuedUserMessage {
	return { id: randomUUID(), promptText: text, displayText: text, images: [] };
}

function queueItemMissingError(): RequestError {
	return new RequestError(ERROR_SERVER, "queued message is no longer available");
}

function queueSdkItemId(source: "sdk-steering" | "sdk-follow-up", index: number, text: string): string {
	const digest = createHash("sha256").update(text).digest("hex").slice(0, 10);
	return `${source}:${index}:${digest}`;
}

function trackedSteeringMessageAt(
	tracked: readonly DesktopQueuedUserMessage[],
	queue: readonly string[],
	index: number,
): DesktopQueuedUserMessage | undefined {
	const text = queue[index];
	if (text === undefined) return undefined;
	const occurrence = queue.slice(0, index).filter((candidate) => candidate === text).length;
	return tracked.filter((message) => message.promptText === text)[occurrence];
}

function takeTrackedSteeringMessage(
	tracked: DesktopQueuedUserMessage[],
	queue: readonly string[],
	index: number,
): DesktopQueuedUserMessage | undefined {
	const target = trackedSteeringMessageAt(tracked, queue, index);
	if (!target) return undefined;
	const targetIndex = tracked.indexOf(target);
	if (targetIndex < 0) return undefined;
	return tracked.splice(targetIndex, 1)[0];
}

function queuedUserMessageText(message: { readonly content: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => (
		isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []
	)).join("");
}

async function pathExists(path: string): Promise<boolean> {
	return await stat(path).then(() => true, () => false);
}

async function readRequestHistoryEntries(): Promise<string[]> {
	const path = join(getAgentDir(), "pix", "request-history.json");
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		const entries = Array.isArray(parsed)
			? parsed
			: isRecord(parsed) && Array.isArray(parsed.entries)
				? parsed.entries
				: [];
		return entries
			.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
			.slice(-500)
			.reverse();
	} catch {
		return [];
	}
}

async function saveRequestHistoryEntry(text: string): Promise<void> {
	const normalized = text.trimEnd();
	if (!normalized.trim() || Buffer.byteLength(normalized, "utf8") > 16 * 1024) return;
	const path = join(getAgentDir(), "pix", "request-history.json");
	const current = (await readRequestHistoryEntries()).reverse();
	const withoutDuplicate = current.filter((entry) => entry !== normalized);
	let entries = [...withoutDuplicate, normalized].slice(-200);
	let payload = JSON.stringify({ version: 1, entries }, null, 2);
	while (entries.length > 0 && Buffer.byteLength(payload, "utf8") > 128 * 1024) {
		entries = entries.slice(1);
		payload = JSON.stringify({ version: 1, entries }, null, 2);
	}
	await mkdir(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(tempPath, payload, "utf8");
		await rename(tempPath, path);
	} finally {
		await rm(tempPath, { force: true }).catch(() => undefined);
	}
}

function queueRequestHistoryEntry(text: string): Promise<void> {
	const pending = requestHistorySaveChain
		.catch(() => undefined)
		.then(() => saveRequestHistoryEntry(text));
	requestHistorySaveChain = pending.catch(() => undefined);
	return pending;
}

async function shareSessionAsGist(session: AgentSessionState): Promise<string> {
	const auth = await runExternalCommand("gh", ["auth", "status"], 32 * 1024);
	if (auth.status !== 0) {
		throw new RequestError(
			ERROR_SERVER,
			"GitHub CLI is not installed or is not logged in. Run `gh auth login` first.",
		);
	}

	const shareDir = join(getAgentDir(), "pix");
	await mkdir(shareDir, { recursive: true });
	const tmpFile = join(shareDir, `session-share-${randomUUID()}.html`);
	try {
		await session.pi.exportHtml(tmpFile);
		const gist = await runExternalCommand("gh", ["gist", "create", "--public=false", tmpFile], 64 * 1024);
		if (gist.status !== 0) {
			throw new RequestError(ERROR_SERVER, gist.stderr.trim() || gist.error || "Failed to create gist");
		}
		const url = gist.stdout.trim();
		if (!url) throw new RequestError(ERROR_SERVER, "GitHub CLI returned no gist URL");
		return `Shared session gist: ${url}`;
	} finally {
		await rm(tmpFile, { force: true }).catch(() => undefined);
	}
}

async function readPiChangelog(): Promise<string> {
	const path = join(getPackageDir(), "CHANGELOG.md");
	const raw = await readFile(path, "utf8");
	return raw.trim().split(/\r?\n/u).slice(0, 140).join("\n");
}

async function formatPixUpdateReport(argumentsText: string): Promise<string> {
	const moduleUrl = new URL("../../../dist/app/cli/update.js", import.meta.url);
	let update: {
		parsePixUpdateArgs(argv: readonly string[]): { help: boolean; force: boolean };
		pixUpdateUsage(): string;
		checkPixUpdate(): Promise<{ packageRoot: string }>;
		isReleaseInstall(packageRoot: string): boolean;
		checkGlobalPiInstall(packageRoot: string): unknown;
		formatPixUpdateCheck(result: unknown): string;
		formatGlobalPiCheck(result: unknown): string;
	};
	try {
		update = await import(moduleUrl.href) as typeof update;
	} catch (error) {
		throw new RequestError(ERROR_SERVER, `Pix update checker is unavailable: ${stringifyUnknown(error)}`);
	}
	const args = argumentsText.trim() ? argumentsText.trim().split(/\s+/u) : [];
	let options: { help: boolean; force: boolean };
	try {
		options = update.parsePixUpdateArgs(args);
	} catch (error) {
		throw new RequestError(ERROR_SERVER, stringifyUnknown(error));
	}
	if (options.help) return update.pixUpdateUsage();
	const result = await update.checkPixUpdate();
	if (update.isReleaseInstall(result.packageRoot)) return update.formatPixUpdateCheck(result);
	const globalPi = update.checkGlobalPiInstall(result.packageRoot);
	const forceHint = options.force
		? "\n\n/update is check-only. To force a reinstall, run `pix update --force` in your shell and restart Pix."
		: "";
	return `${update.formatPixUpdateCheck(result)}\n\n${update.formatGlobalPiCheck(globalPi)}${forceHint}`;
}

interface ExternalCommandResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: string;
}

function runExternalCommand(command: string, args: readonly string[], maxBytes: number): Promise<ExternalCommandResult> {
	return new Promise((resolveCommand) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: ExternalCommandResult): void => {
			if (settled) return;
			settled = true;
			resolveCommand(result);
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			finish({ status: null, stdout, stderr, error: stringifyUnknown(error) });
			return;
		}
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			if (stdout.length < maxBytes) stdout = `${stdout}${chunk}`.slice(0, maxBytes);
		});
		child.stderr?.on("data", (chunk: string) => {
			if (stderr.length < maxBytes) stderr = `${stderr}${chunk}`.slice(0, maxBytes);
		});
		child.on("error", (error) => finish({ status: null, stdout, stderr, error: error.message }));
		child.on("close", (status) => finish({ status, stdout, stderr }));
	});
}

function branchUserMessagesFromEntries(
	state: { entries: readonly PiSessionEntry[]; leafId: string | null },
): Array<{ entryId: string; text: string }> {
	const messages: Array<{ entryId: string; text: string }> = [];
	for (const entry of activeBranchEntries(state.entries, state.leafId)) {
		if (entry.type !== "message" || typeof entry.id !== "string") continue;
		const message = isRecord(entry.message) ? entry.message : undefined;
		if (message?.role !== "user") continue;
		messages.push({ entryId: entry.id, text: sessionUserMessageText(message.content) });
	}
	return messages;
}

function sessionUserMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const text: string[] = [];
	let imageCount = 0;
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "image") {
			imageCount += 1;
			continue;
		}
		if (part.type === "text" && typeof part.text === "string") text.push(part.text);
	}
	const rendered = text.join("\n").trimEnd();
	if (imageCount === 0) return rendered;
	const images = imageCount === 1
		? "[Image]"
		: Array.from({ length: imageCount }, (_, index) => `[Image ${index + 1}]`).join("\n");
	return rendered ? `${rendered}\n${images}` : images;
}

function normalizedRuntimeCommandName(name: string): string {
	return name.replace(/^\/+/, "");
}

function parseWorkspaceUndoBridgeResult(value: unknown): WorkspaceUndoBridgeResult | undefined {
	if (!isRecord(value) || typeof value.requestId !== "string" || value.requestId.length === 0) return undefined;
	if (!["ok", "warning", "cancelled", "error"].includes(String(value.status))) return undefined;
	const status = value.status as WorkspaceUndoBridgeResult["status"];
	const revertedChanges = typeof value.revertedChanges === "number" && Number.isSafeInteger(value.revertedChanges)
		? value.revertedChanges
		: undefined;
	const changedFiles = typeof value.changedFiles === "number" && Number.isSafeInteger(value.changedFiles)
		? value.changedFiles
		: undefined;
	const error = typeof value.error === "string" ? value.error : undefined;
	return {
		requestId: value.requestId,
		status,
		...(revertedChanges === undefined ? {} : { revertedChanges }),
		...(changedFiles === undefined ? {} : { changedFiles }),
		...(error === undefined ? {} : { error }),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function desktopPromptFileImages(params: PromptRequest): DesktopPromptFileImage[] {
	const meta = (params as { _meta?: Record<string, unknown> | null })._meta;
	const value = meta?.[PIX_FILE_IMAGES_META_KEY];
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > MAX_PROMPT_FILE_IMAGE_COUNT) {
		throw new RequestError(ERROR_SERVER, `${PIX_FILE_IMAGES_META_KEY} must contain at most ${MAX_PROMPT_FILE_IMAGE_COUNT} images`);
	}

	const images: DesktopPromptFileImage[] = [];
	const seen = new Set<string>();
	for (const [index, candidate] of value.entries()) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			throw new RequestError(ERROR_SERVER, `${PIX_FILE_IMAGES_META_KEY}[${index}] is invalid`);
		}
		const record = candidate as Record<string, unknown>;
		const uri = typeof record.uri === "string" ? record.uri : "";
		const mimeType = typeof record.mimeType === "string" ? record.mimeType.toLowerCase() : "";
		if (!uri.startsWith("file://") || !mimeType.startsWith("image/")) {
			throw new RequestError(ERROR_SERVER, `${PIX_FILE_IMAGES_META_KEY}[${index}] must be a local image resource`);
		}
		if (seen.has(uri)) {
			throw new RequestError(ERROR_SERVER, `${PIX_FILE_IMAGES_META_KEY} contains a duplicate URI`);
		}
		seen.add(uri);
		const size = record.size;
		if (size !== undefined && (typeof size !== "number" || !Number.isFinite(size) || size < 0)) {
			throw new RequestError(ERROR_SERVER, `${PIX_FILE_IMAGES_META_KEY}[${index}].size is invalid`);
		}
		const name = record.name;
		if (name !== undefined && typeof name !== "string") {
			throw new RequestError(ERROR_SERVER, `${PIX_FILE_IMAGES_META_KEY}[${index}].name is invalid`);
		}
		images.push({
			uri,
			mimeType,
			...(size === undefined ? {} : { size }),
			...(name === undefined ? {} : { name }),
		});
	}
	return images;
}

async function materializePromptFileImages(
	blocks: readonly ContentBlock[],
	descriptors: readonly DesktopPromptFileImage[],
): Promise<Map<string, PiImageContent>> {
	if (descriptors.length === 0) return new Map();
	const resources = new Map<string, Extract<ContentBlock, { type: "resource_link" }>>();
	for (const block of blocks) {
		if (block.type === "resource_link") resources.set(block.uri, block);
	}

	const images = new Map<string, PiImageContent>();
	let totalBytes = 0;
	for (const descriptor of descriptors) {
		const resource = resources.get(descriptor.uri);
		if (!resource) {
			throw new RequestError(ERROR_SERVER, `${PIX_FILE_IMAGES_META_KEY} references a resource that is not in the prompt`);
		}
		if (resource.mimeType && resource.mimeType.toLowerCase() !== descriptor.mimeType) {
			throw new RequestError(ERROR_SERVER, `${PIX_FILE_IMAGES_META_KEY} mime type does not match its prompt resource`);
		}

		let path: string;
		try {
			path = fileURLToPath(descriptor.uri);
		} catch {
			throw new RequestError(ERROR_SERVER, `${PIX_FILE_IMAGES_META_KEY} contains an invalid file URI`);
		}
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(path);
		} catch (error) {
			throw new RequestError(ERROR_SERVER, `failed to inspect attached image: ${stringifyUnknown(error)}`);
		}
		if (!info.isFile()) throw new RequestError(ERROR_SERVER, "attached image is not a regular file");
		if (info.size > MAX_PROMPT_FILE_IMAGE_BYTES) {
			throw new RequestError(ERROR_SERVER, "attached image is larger than 25 MB");
		}

		let bytes: Buffer;
		try {
			bytes = await readFile(path);
		} catch (error) {
			throw new RequestError(ERROR_SERVER, `failed to read attached image: ${stringifyUnknown(error)}`);
		}
		if (bytes.length > MAX_PROMPT_FILE_IMAGE_BYTES) {
			throw new RequestError(ERROR_SERVER, "attached image grew beyond the 25 MB limit");
		}
		totalBytes += bytes.length;
		if (totalBytes > MAX_PROMPT_FILE_IMAGES_TOTAL_BYTES) {
			throw new RequestError(ERROR_SERVER, "attached images exceed the 50 MB combined prompt limit");
		}
		images.set(descriptor.uri, {
			type: "image",
			data: bytes.toString("base64"),
			mimeType: descriptor.mimeType,
		});
	}
	return images;
}

async function collectPromptInput(
	blocks: readonly ContentBlock[],
	descriptors: readonly DesktopPromptFileImage[] = [],
): Promise<{ text: string; images: PiImageContent[] }> {
	const textParts: string[] = [];
	const images: PiImageContent[] = [];
	const fileImages = await materializePromptFileImages(blocks, descriptors);
	for (const block of blocks) {
		switch (block.type) {
			case "text":
				textParts.push(block.text);
				break;
			case "image":
				images.push({ type: "image", data: block.data, mimeType: block.mimeType });
				break;
			case "resource_link": {
				const image = fileImages.get(block.uri);
				if (image) {
					images.push(image);
					break;
				}
				textParts.push(block.uri.startsWith("file://")
					? `[Pix attachment: ${block.uri}]`
					: `[resource: ${block.name ?? block.uri}]`);
				break;
			}
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
