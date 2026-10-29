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

import { loadModelSetupStatus, parseSetupRequest, writeRoles } from "./model-setup.js";
import { createHash, randomUUID } from "node:crypto";
import { BTW_METHOD, BTW_CHANNEL, parseBtwEvent, type BtwRequest, type BtwState } from "../btw/contract.js";
import { parseDesktopBtwRequest } from "../btw/request.js";
import { SEARCH_QUERY_METHOD, SEARCH_CONFIG_METHOD, SEARCH_SYNC_METHOD, SEARCH_INDEX_METHOD, SEARCH_COMMITS_METHOD, SEARCH_INTENT_METHOD, SEARCH_TASKS_METHOD, type SearchIndexResponse } from "../search/contract.js";
import { parseSearchQueryRequest, parseSearchConfigRequest, parseSearchSyncRequest, parseSearchIndexRequest, parseSemanticTasksRequest } from "../search/request.js";
import { DesktopSearchService, SearchUnavailableError, type SearchServiceOptions } from "../search/service.js";
import { BackgroundSessionDiscovery, hydrateBackgroundTitle, type SessionCandidateSource } from "../search/background-session-discovery.js";
import { SessionCandidateCatalog } from "../search/session-discovery.js";
import { SessionSearchActivity } from "../search/session-activity.js";
import { parseCommitSearchRequest } from "../search/commit-contract.js";
import { DesktopCommitSearchService } from "../search/commit-service.js";
import { parseSearchIntentRequest, DesktopSearchIntentService } from "../search/intent.js";
import { TASK_TYPE_CLASSIFY_METHOD } from "../tasks/type-classification-contract.js";
import { DesktopTaskTypeClassifier, parseTaskTypeClassifyRequest } from "../tasks/type-classifier.js";
import { SEARCH_RAG_METHOD, SEARCH_RAG_DELTA_METHOD } from "../search/rag-contract.js";
import { parseRagRequest } from "../search/rag-request.js";
import { DesktopRagService } from "../search/rag-service.js";
import { collectRagEvidence } from "../search/rag-evidence.js";
import { NativeSessionCatalog } from "./native-session-catalog.js";
import { SessionRefreshScheduler } from "./session-refresh-scheduler.js";
import { PIX_SESSION_CATALOG_CHANGED_METHOD } from "./session-catalog-contract.js";
import { PIX_USAGE_STATS_CHANGED_METHOD, PIX_USAGE_STATS_METHOD, type UsageStatsChangedNotification } from "./usage-stats-contract.js";
import { parseUsageStatsRequest, UsageStatsHost } from "./usage-stats-host.js";
import { ProviderUsageCacheHost } from "./provider-usage-cache.js";
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setText as copyTextToClipboard } from "@mariozechner/clipboard";
import { TASK_RUN_METHOD, TASK_RUN_CANCEL_METHOD, type TaskRunRequest, type TaskRunResult } from "./task-run-contract.js";
import { forwardTaskRun } from "./task-run-bridge.js";
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
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type JsonAgentSessionEvent,
	type RpcExtensionUIRequest,
	type RpcExtensionUIResponse,
	type SessionInfo as PiSessionInfo,
} from "@earendil-works/pi-coding-agent";
import { acpFileLogger, withPixLogContext, type Logger } from "../logging.js";
import { reportRequestFailure, withLoggedRequest } from "./request-logging.js";
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
	PIX_LSP_CONTROL_METHOD,
	PIX_FORK_MESSAGES_METHOD,
	PIX_FORK_MESSAGE_METHOD,
	PIX_FORK_READY_METHOD,
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
	parseDesktopLspControlRequest,
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
	type DesktopLspControlRequest,
	type DesktopLspControlResponse,
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
	type DesktopForkReadyNotification,
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
import { SessionUpdateCoalescer } from "./session-update-coalescer.js";
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
	removeDesktopQueueTab,
	saveDesktopQueues,
	type PersistedDesktopQueues,
} from "./queue-store.js";
import { DesktopForkQueue } from "./desktop-fork-queue.js";
import { createDesktopForkSnapshot, type DesktopForkSnapshot, type DesktopForkChild } from "./desktop-fork-snapshot.js";
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
	PIX_SUBAGENT_FORK_SESSION_METHOD,
	PIX_SUBAGENT_META_KEY,
	PIX_SUBAGENT_OPEN_SESSION_METHOD,
	PIX_SUBAGENT_SESSION_STATE_METHOD,
	forkSubagentSession,
	isSubagentSessionPath,
	parseDesktopSubagentOpenSessionRequest,
	readSessionHeaderId,
	readSubagentSessionState,
	removeParentSubagentSessions,
	resolveSubagentSession,
	type DesktopSubagentForkSessionResponse,
	type DesktopSubagentOpenSessionRequest,
	type DesktopSubagentOpenSessionResponse,
	type DesktopSubagentSessionStateResponse,
	type SubagentSessionState,
} from "./subagent-sessions.js";
import { readSubagentSessionSummary } from "./subagent-session-summary.js";
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
import { CLAUDE_CODE_RATE_LIMIT_EVENT, CLAUDE_CODE_USAGE_CHANNEL, loadClaudeCodeRateLimitCache, type ClaudeCodeRateLimitCache } from "./claude-code-rate-limits.js";
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
	notify(method: typeof PIX_SESSION_CATALOG_CHANGED_METHOD, params: { cwd: string }): Promise<void>;
	notify(method: typeof PIX_USAGE_STATS_CHANGED_METHOD, params: UsageStatsChangedNotification): Promise<void>;
	notify(method: typeof PIX_SESSION_STATE_METHOD, params: PixSessionStateNotification): Promise<void>;
	notify(method: typeof PIX_QUEUE_STATE_METHOD, params: DesktopQueueStateResponse): Promise<void>;
	notify(method: typeof PIX_QUEUE_CONSUMED_METHOD, params: DesktopQueueConsumedNotification): Promise<void>;
	notify(method: typeof PIX_FORK_READY_METHOD, params: DesktopForkReadyNotification): Promise<void>;
	request(method: "elicitation/create", params: CreateElicitationRequest): Promise<CreateElicitationResponse>;
  request(method: typeof TASK_RUN_METHOD, params: TaskRunRequest): Promise<TaskRunResult>;
  notify(method: typeof TASK_RUN_CANCEL_METHOD, params: { requestId: string }): Promise<void>;
};

// JSON-RPC server-error range; plain `throw new Error(...)` would surface
// to the client as an opaque "Internal error".
const ERROR_SERVER = -32000;
/** Past the initialize/session-restore burst, so warmup does not compete with it. */
const USAGE_STATS_WARMUP_DELAY_MS = 3_000;
const ERROR_INVALID_PARAMS = -32602;
const WORKSPACE_UNDO_RPC_COMMAND = "__pix-workspace-undo";
const MESSAGE_REWIND_RPC_COMMAND = "__pix-message-rewind";
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

/**
 * Every notify/request issued through a session first flushes its coalesced
 * streamed updates, so merging never reorders them behind later messages.
 */
function orderedSessionClient(client: ClientCaller, updates: SessionUpdateCoalescer): ClientCaller {
	return {
		notify: ((method: string, params: unknown) => {
			updates.flush();
			return (client.notify as (method: string, params: unknown) => Promise<void>)(method, params);
		}) as ClientCaller["notify"],
		request: ((method: string, params: unknown) => {
			updates.flush();
			return (client.request as (method: string, params: unknown) => Promise<unknown>)(method, params);
		}) as ClientCaller["request"],
	};
}

interface AgentSessionState {
	readonly acpSessionId: string;
	activityOwner: string | undefined;
	readonly activitySnapshots: Map<string, PixSessionStateNotification>;
	cwd: string;
	readonly pi: PiClient;
	readonly client: ClientCaller;
	translator: EventTranslator;
	/** Streamed session/update coalescing; flushed before any other session notify. */
	readonly updates: SessionUpdateCoalescer;
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
	forks: DesktopForkQueue;
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
	claudeRateLimitGeneration: number;
	/** Runtime extension slash command names (without slash), lower-cased. */
	runtimeExtensionCommands: Set<string>;
	/** An extension slash command is executing outside the run lifecycle. */
	extensionCommandRunning: number;
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
	readonly headsUpExtensionPath?: string;
	/** Desktop-only extension: advertises inline HTML UI and serves a help tool. */
	readonly htmlSandboxExtensionPath?: string;
	/** Agent resource directory override for hermetic draft-catalog tests. */
	readonly agentDir?: string;
	readonly logger: Logger;
	/** Path of the persistent ACP↔pi session map file. */
	readonly sessionMapPath: string;
	/** Native Pi-session discovery (overridable for hermetic tests). */
	readonly listPiSessions?: (cwd?: string, signal?: AbortSignal) => Promise<readonly PiSessionInfo[]>;
	/** Search-only session candidate catalog (overridable for hermetic tests). */
	readonly sessionCandidates?: SessionCandidateSource;
	/** Filesystem catalog revision (injected only by isolated tests). */
	readonly nativeSessionRevision?: (cwd: string) => Promise<string>;
	/** Hermetic Desktop search backend override. */
	readonly searchService?: DesktopSearchService;
	/** Hermetic embedding preferences/auth/embedder for the default search backend (tests only). */
	readonly searchOverrides?: Pick<SearchServiceOptions, "preferences" | "auth" | "embed">;
	readonly commitSearchService?: Pick<DesktopCommitSearchService, "query" | "index" | "dispose"> & Partial<Pick<DesktopCommitSearchService, "watch">>;
	/** Stateless search-intent classifier; no session or project-source access. */
	readonly searchIntentService?: Pick<DesktopSearchIntentService, "classify">;
	/** Stateless Quick Add type classifier; never reads the task document. */
	readonly taskTypeClassifier?: Pick<DesktopTaskTypeClassifier, "classify">;
	readonly ragService?: Pick<DesktopRagService, "generate">;
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
	readonly queryModelUsage?: (state: PiSessionState, options?: { freshOnly?: boolean }) => Promise<ModelUsageRefreshResult>;
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
	/** Isolated native SDK snapshot creation (overridable for deterministic lifecycle tests). */
	readonly createDesktopForkSnapshot?: (snapshot: DesktopForkSnapshot) => Promise<DesktopForkChild>;
	/** Clipboard writer (overridable for hermetic tests). */
	readonly copyText?: (text: string) => Promise<void>;
}

/** Manual and background commit passes share one diagnostic shape. */
function logCommitIndexResult(cwd: string, result: SearchIndexResponse, durationMs: number, background: boolean): void {
	const phase = result.failurePhase;
	const safePhase = phase === "configuration" || phase === "authorization" || phase === "storage"
		|| phase === "provider" || phase === "history" ? phase : undefined;
	try {
		void acpFileLogger.log(result.complete ? "info" : "warn",
			result.complete ? "search:index-completed" : "search:index-incomplete",
			{ source: "commits", complete: result.complete, indexed: result.indexed, total: result.total, durationMs,
				...(background ? { background: true } : {}),
				...(safePhase ? { phase: safePhase } : {}),
				...(result.complete ? {} : { reason: "incomplete_coverage" }) },
			{ project: cwd, module: "search.index" });
	} catch { /* Diagnostic logging cannot change indexing outcomes. */ }
}

export class PixAcpAgent {
	private readonly sessions = new Map<string, AgentSessionState>();
	private readonly sessionRefreshes = new SessionRefreshScheduler((error) => {
		this.options.logger.warn(`session refresh failed: ${stringifyUnknown(error)}`);
	});
	/** Only runtime identity is retained here, never side-chat content. */
	private readonly btwOwners = new WeakMap<AgentSessionState, string>();
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
	/** Viewer polling is 2s; provider quotas need at most one query per route/minute. */
	private readonly viewerModelUsage = new Map<string, { at: number; result: Promise<ModelUsageRefreshResult> }>();
	/** Last successful quota snapshot per Claude Code route, resent as `stale` cache while the credential is absent. */
	private readonly claudeCodeQuotaCache = new Map<string, DesktopModelUsageStatus>();
	private claudeRateLimits: Promise<ClaudeCodeRateLimitCache | undefined> | undefined;
	/** Single-flight headless Claude CLI login nudge; at most one child at a time. */
	private claudeLoginNudgeInFlight: Promise<boolean> | undefined;
	/** Deduplicates concurrent manual Claude Code quota refreshes per session. */
	private readonly claudeQuotaRefreshes = new Map<string, Promise<DesktopClaudeQuotaRefreshResponse>>();
	private readonly app: AgentApp;
	private readonly options: PixAcpAgentOptions;
	private readonly sessionMap: SessionMapStore;
	private readonly nativeSessionCatalog: NativeSessionCatalog;
	private readonly searchService: DesktopSearchService;
	private readonly backgroundSearchSessions: BackgroundSessionDiscovery;
	private readonly searchActivity = new SessionSearchActivity(
		id => this.sessionMap.get(id),
		(cwd, id, running) => this.searchService.sessionActivity(cwd, id, running),
	);
	private readonly commitSearchService: Pick<DesktopCommitSearchService, "query" | "index" | "dispose"> & Partial<Pick<DesktopCommitSearchService, "watch">>;
	private readonly searchIntentService: Pick<DesktopSearchIntentService, "classify">;
	private readonly taskTypeClassifier: Pick<DesktopTaskTypeClassifier, "classify">;
	private readonly ragService: Pick<DesktopRagService, "generate">;
	private readonly usageStatsHost: UsageStatsHost;
	private readonly providerUsageCache: ProviderUsageCacheHost;
	private readonly listPiSessions: (cwd?: string, signal?: AbortSignal) => Promise<readonly PiSessionInfo[]>;
	private readonly loadTuiTabs: (cwd: string) => Promise<TuiTabSnapshot>;
	private readonly completeAutocomplete: AutocompleteCompleter;
	private readonly enhancePrompt: PromptEnhancer;
	/** Lazy local model catalogue for viewer display (context window, names). */
	private viewerModelRuntime: Promise<ModelRuntime | undefined> | undefined;
	private readonly gitAssistant: GitAssistant;
	private readonly queryModelUsage: (state: PiSessionState, options?: { freshOnly?: boolean }) => Promise<ModelUsageRefreshResult>;
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
	private readonly retiringForkQueues = new Set<Promise<void>>();
	private readonly retiringForkQueuePaths = new Map<string, Promise<void>>();
	/** Advertised by the client during `initialize`; gates dialog bridging. */
	private clientCapabilities: ClientCapabilities | null | undefined;
	private clientName: string | undefined;
	private usageStatsWarmupScheduled = false;

	constructor(options: PixAcpAgentOptions) {
		this.options = options;
		this.commitSearchService = options.commitSearchService ?? new DesktopCommitSearchService({
			onBackgroundResult: (cwd, result, durationMs) => logCommitIndexResult(cwd, result, durationMs, true),
		});
		this.searchIntentService = options.searchIntentService ?? new DesktopSearchIntentService();
		this.taskTypeClassifier = options.taskTypeClassifier ?? new DesktopTaskTypeClassifier();
		this.ragService = options.ragService ?? new DesktopRagService({
			collect: (request, signal) => collectRagEvidence(request, signal, async id => {
				const record = await this.sessionMap.get(id);
				return record && resolve(record.cwd) === resolve(request.cwd)
					? { id: record.piSessionId, path: record.piSessionPath } : undefined;
			}),
			createRuntime: (cwd) => {
				const extensionPath = desktopToolsSuiteExtensionPath({
					...(options.agentDir ? { agentDir: options.agentDir } : {}),
					...(options.toolsSuiteExtensionPath ? { bundledExtensionPath: options.toolsSuiteExtensionPath } : {}),
				});
				return createDesktopDraftModelRuntime({
					cwd,
					...(options.agentDir ? { agentDir: options.agentDir } : {}),
					...(extensionPath ? { additionalExtensionPaths: [extensionPath] } : {}),
				});
			},
		});
		this.sessionMap = new SessionMapStore(options.sessionMapPath, options.logger);
		this.nativeSessionCatalog = new NativeSessionCatalog(
			async (cwd, signal) => {
				const native = await this.listPiSessions(cwd, signal);
				signal.throwIfAborted();
				await this.sessionMap.mergeByPiSessionPath(native.flatMap((info) => {
					const record = nativeSessionRecord(info, cwd);
					return record ? [record] : [];
				}), { requireExistingFiles: true, keepNewerTitles: true });
			},
			(error) => this.options.logger.warn(`native session discovery failed: ${stringifyUnknown(error)}`),
			options.nativeSessionRevision,
		);
		// Sub-agent viewer sessions are ephemeral, parent-owned and already summarized
		// in the parent transcript; keep them out of project session search.
		const searchableSessionRecords = async (cwd: string) =>
			(await this.sessionMap.list(cwd)).filter((record) => !record.subagent);
		const backgroundSessions = new BackgroundSessionDiscovery(searchableSessionRecords,
			options.agentDir ?? getAgentDir(), options.sessionCandidates ?? new SessionCandidateCatalog());
		this.backgroundSearchSessions = backgroundSessions;
		this.searchService = options.searchService ?? new DesktopSearchService({
			...options.searchOverrides,
			onIndexDiagnostic: ({ cwd, source, complete, indexed, total, durationMs, phase, reason }) => {
				void acpFileLogger.log(complete ? "info" : "warn", complete ? "search:index-completed" : "search:index-incomplete",
					{ source, complete, indexed, total, durationMs, ...(phase ? { phase } : {}), ...(reason ? { reason } : {}) },
					{ project: cwd, module: "search.index" });
			},
			sessionRecords: searchableSessionRecords,
			discoverBackground: (cwd, signal) => backgroundSessions.list(cwd, signal),
			sessionSnapshot: (cwd, signal) => backgroundSessions.snapshot(cwd, signal),
			discover: async (cwd, signal, strict) => {
				const records: SessionMapRecord[] = [];
				for (const record of await backgroundSessions.list(cwd, signal)) {
                    const hydrated = await hydrateBackgroundTitle(cwd, record, signal);
					if (!hydrated && strict) throw new Error("Session title could not be read");
					if (hydrated) records.push(hydrated.record);
				}
				return records;
			},
		});
		this.usageStatsHost = new UsageStatsHost({ logger: this.options.logger, agentDir: options.agentDir ?? getAgentDir() });
		this.providerUsageCache = new ProviderUsageCacheHost({ logger: this.options.logger, ...(options.agentDir ? { agentDir: options.agentDir } : {}) });
		this.listPiSessions = options.listPiSessions
			?? ((cwd, signal) => cwd ? SessionManager.list(cwd, undefined, undefined, signal) : SessionManager.listAll(undefined, signal));
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
		this.queryModelUsage = options.queryModelUsage ?? ((state, queryOptions) => queryPixModelUsage(state, options.agentDir, queryOptions?.freshOnly));
		this.claudeCodeLoginNudge = options.claudeCodeLoginNudge ?? launchClaudeCodeLoginNudge;
		this.parseAnthropicUsageHeaders = options.parseAnthropicUsageHeaders ?? parsePixAnthropicUsageHeaders;
		this.app = agent({ name: "pix-acp" })
			.onRequest("initialize", (ctx) => this.withRequestLogging("initialize", ctx.params, ctx.signal, () => {
				this.clientCapabilities = ctx.params.clientCapabilities;
				this.clientName = typeof ctx.params.clientInfo?.name === "string"
					? ctx.params.clientInfo.name
					: undefined;
				if (this.clientName === "pix-desktop") this.scheduleUsageStatsWarmup();
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
			}))
			.onRequest("authenticate", () => ({}))
			.onRequest(SEARCH_COMMITS_METHOD, parseCommitSearchRequest, async (ctx) => this.withRequestLogging(SEARCH_COMMITS_METHOD, ctx.params, ctx.signal, async () => {
				if (this.clientName !== "pix-desktop") throw new RequestError(ERROR_SERVER, "Desktop search unavailable");
				try { return await this.commitSearchService.query(ctx.params, ctx.signal); }
				catch (error) {
					if (ctx.signal.aborted) throw error;
					throw new RequestError(ERROR_SERVER, "Commit search unavailable");
				}
			}))
			.onRequest(SEARCH_INTENT_METHOD, parseSearchIntentRequest, async (ctx) => this.withRequestLogging(SEARCH_INTENT_METHOD, ctx.params, ctx.signal, async () => {
				if (this.clientName !== "pix-desktop") throw new RequestError(ERROR_SERVER, "Desktop search unavailable");
				try { return await this.searchIntentService.classify(ctx.params.query, ctx.signal); }
				catch (error) {
					if (ctx.signal.aborted) throw error;
					reportRequestFailure(this.options.logger, SEARCH_INTENT_METHOD, error, ctx.signal);
					return { intent: "search" as const, fallback: true };
				}
			}))
			.onRequest(TASK_TYPE_CLASSIFY_METHOD, parseTaskTypeClassifyRequest, async (ctx) => this.withRequestLogging(TASK_TYPE_CLASSIFY_METHOD, ctx.params, ctx.signal, async () => {
				if (this.clientName !== "pix-desktop") throw new RequestError(ERROR_SERVER, "Desktop task classification unavailable");
				try { return await this.taskTypeClassifier.classify(ctx.params.text, ctx.signal); }
				catch (error) {
					if (ctx.signal.aborted) throw error;
					reportRequestFailure(this.options.logger, TASK_TYPE_CLASSIFY_METHOD, error, ctx.signal);
					return { type: "feature" as const, fallback: true };
				}
			}))
			.onRequest(SEARCH_RAG_METHOD, parseRagRequest, async (ctx) => this.withRequestLogging(SEARCH_RAG_METHOD, ctx.params, ctx.signal, async () => {
				if (this.clientName !== "pix-desktop") throw new RequestError(ERROR_SERVER, "Desktop search unavailable");
				try {
					return await this.ragService.generate(ctx.params, async update => {
						ctx.signal.throwIfAborted();
						await ctx.client.notify(SEARCH_RAG_DELTA_METHOD, { requestId: ctx.params.requestId, ...update });
					}, ctx.signal);
				} catch (error) {
					if (ctx.signal.aborted) throw error;
					throw new RequestError(ERROR_SERVER, error instanceof Error ? error.message : String(error));
				}
			}))
			.onRequest(SEARCH_QUERY_METHOD, parseSearchQueryRequest, async (ctx) => this.withRequestLogging(SEARCH_QUERY_METHOD, ctx.params, ctx.signal, async () => {
				if (this.clientName !== "pix-desktop") throw new RequestError(ERROR_SERVER, "Desktop search unavailable");
				try { return await this.searchService.query(ctx.params, ctx.signal); }
				catch (error) {
					if (error instanceof SearchUnavailableError) throw new RequestError(ERROR_SERVER, error.message);
					throw error;
				}
			}))
			.onRequest(SEARCH_TASKS_METHOD, parseSemanticTasksRequest, async (ctx) => this.withRequestLogging(SEARCH_TASKS_METHOD, ctx.params, ctx.signal, async () => {
				if (this.clientName !== "pix-desktop") throw new RequestError(ERROR_SERVER, "Desktop search unavailable");
				try { return await this.searchService.queryTasks(ctx.params, ctx.signal); }
				catch (error) {
					if (ctx.signal.aborted) throw error;
					throw new RequestError(ERROR_SERVER, "Semantic task search unavailable; local task search remains available");
				}
			}))
			.onRequest(SEARCH_CONFIG_METHOD, parseSearchConfigRequest, async (ctx) => this.withRequestLogging(SEARCH_CONFIG_METHOD, ctx.params, ctx.signal, async () => {
				if (this.clientName !== "pix-desktop") throw new RequestError(ERROR_SERVER, "Desktop search unavailable");
				try { return await this.searchService.config(ctx.params, ctx.signal); }
				catch (error) {
					if (error instanceof SearchUnavailableError) throw new RequestError(ERROR_SERVER, error.message);
					throw error;
				}
			}))
			.onRequest(SEARCH_SYNC_METHOD, parseSearchSyncRequest, async (ctx) => this.withRequestLogging(SEARCH_SYNC_METHOD, ctx.params, ctx.signal, async () => {
				if (this.clientName !== "pix-desktop") throw new RequestError(ERROR_SERVER, "Desktop search unavailable");
				try {
					const result = await this.searchService.sync(ctx.params, ctx.signal);
					// Change-driven background commit indexing for the synced workspace.
					this.commitSearchService.watch?.(ctx.params.cwd);
					return result;
				}
				catch (error) {
					if (error instanceof SearchUnavailableError) throw new RequestError(ERROR_SERVER, error.message);
					throw error;
				}
			}))
			.onRequest(SEARCH_INDEX_METHOD, parseSearchIndexRequest, async (ctx) => this.withRequestLogging(SEARCH_INDEX_METHOD, ctx.params, ctx.signal, async () => {
				if (this.clientName !== "pix-desktop") throw new RequestError(ERROR_SERVER, "Desktop search unavailable");
				try {
					if (ctx.params.source !== "commits") return await this.searchService.index(ctx.params, ctx.signal);
					const startedAt = Date.now();
					const result = await this.commitSearchService.index(ctx.params, ctx.signal);
					if (!ctx.signal.aborted) logCommitIndexResult(ctx.params.cwd, result, Date.now() - startedAt, false);
					return result;
				} catch (error) {
					if (ctx.signal.aborted) throw error;
					reportRequestFailure(this.options.logger, SEARCH_INDEX_METHOD, error, ctx.signal);
					return { source: ctx.params.source, complete: false, message: "Document indexing unavailable; retry this source" };
				}
			}))
			.onRequest("session/new", (ctx) => this.withRequestLogging("session/new", ctx.params, ctx.signal, () => this.newSession(ctx.params, ctx.client)))
			.onRequest("session/load", (ctx) => this.withRequestLogging("session/load", ctx.params, ctx.signal, () => this.withSessionLifecycle(ctx.params.sessionId, () => this.loadSession(ctx.params, ctx.client))),
			)
			.onRequest("session/resume", (ctx) => this.withRequestLogging("session/resume", ctx.params, ctx.signal, () => this.withSessionLifecycle(ctx.params.sessionId, () => this.resumeSession(ctx.params, ctx.client))),
			)
			.onRequest("session/list", (ctx) => this.withRequestLogging("session/list", ctx.params, ctx.signal, () => this.listSessions(ctx.params, ctx.client)))
			.onRequest("session/delete", (ctx) => this.withRequestLogging("session/delete", ctx.params, ctx.signal, () => this.withSessionLifecycle(ctx.params.sessionId, () => this.deleteSession(ctx.params.sessionId))),
			)
			.onRequest("session/fork", (ctx) => this.withRequestLogging("session/fork", ctx.params, ctx.signal, () => this.withSessionLifecycle(ctx.params.sessionId, () => this.forkSession(ctx.params, ctx.client))),
			)
			.onRequest("session/set_config_option", (ctx) => this.withRequestLogging("session/set_config_option", ctx.params, ctx.signal, () => this.setConfigOption(ctx.params)))
			.onRequest("session/set_mode", async (ctx) => this.withRequestLogging("session/set_mode", ctx.params, ctx.signal, async () => { await this.assertSessionWritable(ctx.params.sessionId); return {}; }))
			.onRequest("session/prompt", (ctx) => this.withRequestLogging("session/prompt", ctx.params, ctx.signal, () => this.prompt(ctx.params)))
			.onRequest(PIX_AGENT_CONTROL_METHOD, parseDesktopAgentControlRequest, (ctx) => this.withRequestLogging(PIX_AGENT_CONTROL_METHOD, ctx.params, ctx.signal, () => this.desktopAgentControl(ctx.params)),
			)
			.onRequest(PIX_RUNTIME_STATUS_METHOD, parseDesktopRuntimeStatusRequest, (ctx) => this.withRequestLogging(PIX_RUNTIME_STATUS_METHOD, ctx.params, ctx.signal, () => this.desktopRuntimeStatus(ctx.params)),
			)
			.onRequest(PIX_DCP_STATS_METHOD, parseDesktopSessionRequest, (ctx) => this.withRequestLogging(PIX_DCP_STATS_METHOD, ctx.params, ctx.signal, () => this.desktopDcpStats(ctx.params)),
			)
			.onRequest(PIX_USAGE_STATS_METHOD, parseUsageStatsRequest, (ctx) => this.withRequestLogging(PIX_USAGE_STATS_METHOD, ctx.params, ctx.signal, () => {
				const client = ctx.client;
				return this.usageStatsHost.stats(ctx.params, (notification) => client.notify(PIX_USAGE_STATS_CHANGED_METHOD, notification));
			}))
			.onRequest(PIX_SESSION_USAGE_METHOD, parseDesktopSessionRequest, (ctx) => this.withRequestLogging(PIX_SESSION_USAGE_METHOD, ctx.params, ctx.signal, () => this.desktopSessionUsage(ctx.params)),
			)
			.onRequest(PIX_CLAUDE_QUOTA_REFRESH_METHOD, parseDesktopSessionRequest, (ctx) => this.withRequestLogging(PIX_CLAUDE_QUOTA_REFRESH_METHOD, ctx.params, ctx.signal, () => this.desktopClaudeQuotaRefresh(ctx.params)),
			)
			.onRequest(PIX_DRAFT_CONFIG_METHOD, parseDesktopDraftConfigRequest, (ctx) => this.withRequestLogging(PIX_DRAFT_CONFIG_METHOD, ctx.params, ctx.signal, () => this.desktopDraftConfig(ctx.params)),
			)
			.onRequest(PIX_MODEL_ROUTING_STATUS_METHOD, parseDesktopModelRoutingStatusRequest, (ctx) => this.withRequestLogging(PIX_MODEL_ROUTING_STATUS_METHOD, ctx.params, ctx.signal, () => this.desktopModelRoutingStatus(ctx.params)),
			)
			.onRequest(PIX_MODEL_ROUTE_METHOD, parseDesktopModelRouteRequest, (ctx) => this.withRequestLogging(PIX_MODEL_ROUTE_METHOD, ctx.params, ctx.signal, () => this.desktopRouteModel(ctx.params, ctx.signal)),
			)
			.onRequest(PIX_BASH_METHOD, parseDesktopBashRequest, (ctx) => this.withRequestLogging(PIX_BASH_METHOD, ctx.params, ctx.signal, () => this.desktopBash(ctx.params)),
			)
			.onRequest(PIX_CLEAR_TODOS_METHOD, parseDesktopSessionRequest, (ctx) => this.withRequestLogging(PIX_CLEAR_TODOS_METHOD, ctx.params, ctx.signal, () => this.desktopClearTodos(ctx.params)),
			)
			.onRequest(PIX_LSP_CONTROL_METHOD, parseDesktopLspControlRequest, (ctx) => this.withRequestLogging(PIX_LSP_CONTROL_METHOD, ctx.params, ctx.signal, () => this.desktopLspControl(ctx.params)),
			)
			.onRequest("pix/setup/models", (value: unknown) => value, (ctx) => this.withRequestLogging("pix/setup/models", ctx.params, ctx.signal, () => loadModelSetupStatus()),
			)
			.onRequest("pix/setup/models/apply", parseSetupRequest, (ctx) => this.withRequestLogging("pix/setup/models/apply", ctx.params, ctx.signal, () => ({ written: writeRoles(ctx.params.roles, undefined, ctx.params.overrides, ctx.params.search) })),
			)
			.onRequest("pix/autocomplete", parseAutocompleteRequest, (ctx) => this.withRequestLogging("pix/autocomplete", ctx.params, ctx.signal, () => this.autocomplete(ctx.params, ctx.signal)),
			)
			.onRequest("pix/autocomplete/config", parseAutocompleteSettingsRequest, (ctx) => this.withRequestLogging("pix/autocomplete/config", ctx.params, ctx.signal, () => this.autocompleteConfig(ctx.params)),
			)
			.onRequest(PIX_ENHANCE_PROMPT_METHOD, parseDesktopEnhancePromptRequest, (ctx) => this.withRequestLogging(PIX_ENHANCE_PROMPT_METHOD, ctx.params, ctx.signal, () => this.desktopEnhancePrompt(ctx.params, ctx.signal)),
			)
			.onRequest(BTW_METHOD, parseDesktopBtwRequest, (ctx) => this.withRequestLogging(BTW_METHOD, ctx.params, ctx.signal, () => this.desktopBtw(ctx.params)))
			.onRequest(PIX_GIT_ASSIST_METHOD, parseDesktopGitAssistantRequest, (ctx) => this.withRequestLogging(PIX_GIT_ASSIST_METHOD, ctx.params, ctx.signal, () => this.desktopGitAssist(ctx.params, ctx.signal)),
			)
			.onRequest(PIX_FORK_MESSAGES_METHOD, parseDesktopSessionRequest, (ctx) => this.withRequestLogging(PIX_FORK_MESSAGES_METHOD, ctx.params, ctx.signal, () => this.forkMessages(ctx.params)),
			)
			.onRequest(PIX_BRANCH_USER_MESSAGES_METHOD, parseDesktopSessionRequest, (ctx) => this.withRequestLogging(PIX_BRANCH_USER_MESSAGES_METHOD, ctx.params, ctx.signal, () => this.branchUserMessages(ctx.params)),
			)
			.onRequest(PIX_USER_MESSAGE_ACTION_METHOD, parseDesktopUserMessageActionRequest, (ctx) => this.withRequestLogging(PIX_USER_MESSAGE_ACTION_METHOD, ctx.params, ctx.signal, () => this.withSessionLifecycle(ctx.params.sessionId, () => this.desktopUserMessageAction(ctx.params))),
			)
			.onRequest(PIX_IMPORT_SESSION_METHOD, parseDesktopImportSessionRequest, (ctx) => this.withRequestLogging(PIX_IMPORT_SESSION_METHOD, ctx.params, ctx.signal, () => this.withSessionLifecycle(ctx.params.sessionId, () => this.importSession(ctx.params))),
			)
			.onRequest(PIX_QUEUE_STATE_METHOD, parseDesktopSessionRequest, (ctx) => this.withRequestLogging(PIX_QUEUE_STATE_METHOD, ctx.params, ctx.signal, () => this.desktopQueueState(ctx.params)),
			)
			.onRequest(PIX_QUEUE_MESSAGE_METHOD, parseDesktopQueueSubmitRequest, (ctx) => this.withRequestLogging(PIX_QUEUE_MESSAGE_METHOD, ctx.params, ctx.signal, () => this.desktopQueueMessage(ctx.params)),
			)
			.onRequest(PIX_DEFER_MESSAGE_METHOD, parseDesktopQueueSubmitRequest, (ctx) => this.withRequestLogging(PIX_DEFER_MESSAGE_METHOD, ctx.params, ctx.signal, () => this.desktopDeferMessage(ctx.params)),
			)
			.onRequest(PIX_FORK_MESSAGE_METHOD, parseDesktopQueueSubmitRequest, (ctx) => this.withRequestLogging(PIX_FORK_MESSAGE_METHOD, ctx.params, ctx.signal, () => this.desktopForkMessage(ctx.params)),
			)
			.onRequest(PIX_QUEUE_ACTION_METHOD, parseDesktopQueueActionRequest, (ctx) => this.withRequestLogging(PIX_QUEUE_ACTION_METHOD, ctx.params, ctx.signal, () => this.desktopQueueAction(ctx.params)),
			)
			.onRequest(PIX_REGISTRY_ACTION_METHOD, parseDesktopRegistryActionRequest, (ctx) => this.withRequestLogging(PIX_REGISTRY_ACTION_METHOD, ctx.params, ctx.signal, () => this.desktopRegistryAction(ctx.params, ctx.client)),
			)
			.onRequest(PIX_REGISTRY_DIFF_METHOD, parseDesktopRegistryDiffRequest, (ctx) => this.withRequestLogging(PIX_REGISTRY_DIFF_METHOD, ctx.params, ctx.signal, () => this.desktopRegistryDiff(ctx.params)),
			)
			.onRequest(PIX_TAKE_AUTO_MESSAGE_METHOD, parseDesktopSessionRequest, (ctx) => this.withRequestLogging(PIX_TAKE_AUTO_MESSAGE_METHOD, ctx.params, ctx.signal, () => this.desktopTakeAutoMessage(ctx.params)),
			)
			.onRequest(PIX_RELOAD_SESSION_METHOD, parseDesktopSessionRequest, (ctx) => this.withRequestLogging(PIX_RELOAD_SESSION_METHOD, ctx.params, ctx.signal, () => this.withSessionLifecycle(ctx.params.sessionId, () => this.reloadSession(ctx.params, ctx.client))),
			)
			.onRequest(PIX_REQUEST_HISTORY_METHOD, parseDesktopSessionRequest, (ctx) => this.withRequestLogging(PIX_REQUEST_HISTORY_METHOD, ctx.params, ctx.signal, () => this.desktopRequestHistory(ctx.params)),
			)
			.onRequest(PIX_RESUME_PATH_METHOD, parseDesktopResumePathRequest, (ctx) => this.withRequestLogging(PIX_RESUME_PATH_METHOD, ctx.params, ctx.signal, () => this.withSessionLifecycle(ctx.params.sessionId, () => this.resumePath(ctx.params))),
			)
			.onRequest(PIX_SESSION_HISTORY_METHOD, parseDesktopSessionHistoryRequest, (ctx) => this.withRequestLogging(PIX_SESSION_HISTORY_METHOD, ctx.params, ctx.signal, () => this.desktopSessionHistory(ctx.params)),
			)
			.onRequest(PIX_TOOL_RESULT_METHOD, parseDesktopToolResultRequest, (ctx) => this.withRequestLogging(PIX_TOOL_RESULT_METHOD, ctx.params, ctx.signal, () => this.desktopToolResult(ctx.params)),
			)
			.onRequest(PIX_SESSION_IMAGE_METHOD, parseDesktopSessionImageRequest, (ctx) => this.withRequestLogging(PIX_SESSION_IMAGE_METHOD, ctx.params, ctx.signal, () => this.desktopSessionImage(ctx.params)),
			)
			.onRequest(PIX_SUBAGENT_OPEN_SESSION_METHOD, parseDesktopSubagentOpenSessionRequest, (ctx) => this.withRequestLogging(PIX_SUBAGENT_OPEN_SESSION_METHOD, ctx.params, ctx.signal, () => this.subagentOpenSession(ctx.params)),
			)
			.onRequest(PIX_SUBAGENT_FORK_SESSION_METHOD, parseDesktopSessionRequest, (ctx) => this.withRequestLogging(PIX_SUBAGENT_FORK_SESSION_METHOD, ctx.params, ctx.signal, () => this.subagentForkSession(ctx.params)),
			)
			.onRequest(PIX_SUBAGENT_SESSION_STATE_METHOD, parseDesktopSessionRequest, (ctx) => this.withRequestLogging(PIX_SUBAGENT_SESSION_STATE_METHOD, ctx.params, ctx.signal, () => this.subagentSessionState(ctx.params)),
			)
			.onRequest("session/close", (ctx) => this.withRequestLogging("session/close", ctx.params, ctx.signal, () => this.withSessionLifecycle(ctx.params.sessionId, () => this.closeSession(ctx.params.sessionId))),
			)
			.onNotification("session/cancel", (ctx) => this.withRequestLogging("session/cancel", ctx.params, ctx.signal, () => this.cancel(ctx.params.sessionId)));
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
		this.backgroundSearchSessions.dispose();
		this.disposed = true;
		await this.nativeSessionCatalog.dispose();
		await this.searchActivity.dispose();
		await Promise.all([this.searchService.dispose(), this.commitSearchService.dispose()]);
		await this.usageStatsHost.dispose();
		this.claudeCodeQuotaCache.clear();
		this.claudeQuotaRefreshes.clear();
		this.viewerModelUsage.clear();
		await Promise.allSettled([...this.pendingSpawns]);
		await Promise.allSettled([...this.sessionLifecycle.values()]);
		await Promise.all([...this.sessions.values()].map((session) => this.teardownSession(session)));
		await Promise.all([...this.retiringForkQueues]);
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

	private async desktopBtw(params: BtwRequest): Promise<BtwState> {
		const session = this.requireDesktopSession(params.sessionId);
		if (!session.pi.btw) throw new RequestError(ERROR_SERVER, "BTW requires an updated Desktop runtime");
		// Side controls never take the parent run lock or enter its prompt/queue path.
		const state = await session.pi.btw(params);
		if (this.sessions.get(params.sessionId) !== session) throw new RequestError(ERROR_SERVER, "BTW runtime was replaced");
		this.btwOwners.set(session, state.runtimeId);
		return state;
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
		if (params.action !== "copy") await this.assertSessionWritable(params.sessionId);
		const session = this.requireDesktopSession(params.sessionId);
		if (params.action === "copy") return this.performDesktopUserMessageAction(session, params);
		if (session.activeRun || session.builtinRunning) throw new RequestError(ERROR_SERVER, "message actions are unavailable while the agent is running");
		if (params.action === "rewind" && (session.autoUserMessages.length || session.deferredUserMessages.length)) {
			throw new RequestError(ERROR_SERVER, "editing is unavailable with queued messages");
		}
		// Claim before any RPC awaits: another submission must not race navigation.
		session.builtinRunning = true;
		try { return await this.performDesktopUserMessageAction(session, params); }
		finally { session.builtinRunning = false; }
	}

	private async performDesktopUserMessageAction(
		session: AgentSessionState,
		params: DesktopUserMessageActionRequest,
	): Promise<DesktopUserMessageActionResponse> {
		const entries = await session.pi.getEntries();
		const messages = branchUserMessagesFromEntries(entries);
		let selected = messages.find((message) => message.entryId === params.entryId);
		if (!selected && params.action === "rewind") {
			// A previous rewind may have committed before its RPC reported an
			// error. Only the bridge can authorize this retry: it must prove that
			// the live leaf is still the exact parent (plus neutral metadata), and
			// must not navigate an inactive entry. Copy/Undo remain branch-only.
			const entry = entries.entries.find((candidate) => candidate.id === params.entryId);
			const message = entry?.type === "message" && isRecord(entry.message) ? entry.message : undefined;
			if (message?.role === "user") selected = { entryId: params.entryId, text: sessionUserMessageText(message.content) };
		}
		if (!selected) {
			throw new RequestError(ERROR_SERVER, `user message ${params.entryId} is not on the active session branch`);
		}

		if (params.action === "copy") {
			await this.copyText(selected.text);
			return { status: "ok" };
		}

		if (session.activeRun) {
			throw new RequestError(ERROR_SERVER, "undo changes is unavailable while the agent is running");
		}
		const state = await session.pi.getState();
		if (state.isStreaming || state.isCompacting) {
			throw new RequestError(ERROR_SERVER, "undo changes is unavailable while the session is busy");
		}

		const bridgeCommand = params.action === "rewind" ? MESSAGE_REWIND_RPC_COMMAND : WORKSPACE_UNDO_RPC_COMMAND;
		if (params.action === "rewind" && ((state.pendingMessageCount ?? 0) > 0
			|| session.steeringQueue.length > 0 || session.followUpQueue.length > 0)) {
			throw new RequestError(ERROR_SERVER, "edit is unavailable while messages are queued");
		}
		const commands = await session.pi.getCommands();
		if (!commands.some((command) => normalizedRuntimeCommandName(command.name) === bridgeCommand)) {
			throw new RequestError(ERROR_SERVER, "workspace undo bridge is unavailable in this session");
		}

		const requestId = randomUUID();
		session.workspaceUndoResults.delete(requestId);
		try {
			await session.pi.prompt(`/${bridgeCommand} ${JSON.stringify({ requestId, targetEntryId: params.entryId })}`);
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
			session.workspaceUndoResults.delete(requestId);
		}
	}

	private async desktopRequestHistory(params: DesktopSessionRequest): Promise<DesktopRequestHistoryResponse> {
		if (!this.sessions.has(params.sessionId)) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		return { entries: await readRequestHistoryEntries() };
	}

	private async desktopBash(params: DesktopBashRequest): Promise<Record<string, never>> {
		await this.assertSessionWritable(params.sessionId);
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
		await this.assertSessionWritable(params.sessionId);
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

	private async desktopLspControl(params: DesktopLspControlRequest): Promise<DesktopLspControlResponse> {
		if (params.action !== "status") await this.assertSessionWritable(params.sessionId);
		const session = this.requireDesktopSession(params.sessionId);
		try {
			if (!session.pi.lspControl) throw new Error("LSP control is unavailable in this pi client");
			return await session.pi.lspControl(params.action, params.id, params.root);
		} catch (error) {
			throw new RequestError(ERROR_SERVER, `LSP control failed: ${stringifyUnknown(error)}`);
		}
	}

	private async desktopQueueState(params: DesktopSessionRequest): Promise<DesktopQueueStateResponse> {
		const session = this.requireDesktopSession(params.sessionId);
		await this.ensureDesktopQueuesLoaded(session);
		return this.desktopQueueSnapshot(session);
	}

	private async desktopQueueMessage(params: DesktopQueueSubmitRequest): Promise<DesktopQueueSubmitResponse> {
		await this.assertSessionWritable(params.sessionId);
		const session = this.requireDesktopSession(params.sessionId);
		await this.ensureDesktopQueuesLoaded(session);
		const message = await this.desktopQueuedMessage(params);
		if (this.clientName === "pix-desktop" && message.displayText.trim()) {
			void queueRequestHistoryEntry(message.displayText).catch(() => undefined);
		}
		const state = await session.pi.getState();
		if (state.isStreaming && !state.isCompacting) {
			const revision = session.queueRevision;
			const steerText = sdkSteeringMessageText(message);
			const tracked = cloneQueuedUserMessage(message);
			session.trackedSteeringMessages.push(tracked);
			try {
				await session.pi.steer(steerText, queueMessageImages(message));
			} catch (error) {
				const index = session.trackedSteeringMessages.indexOf(tracked);
				if (index >= 0) session.trackedSteeringMessages.splice(index, 1);
				throw error;
			}
			// queue_update normally arrives before the RPC response. Keep an
			// optimistic copy only when it did not, so the Desktop never shows a
			// missing row after Enter during streaming.
			if (session.queueRevision === revision && session.trackedSteeringMessages.includes(tracked)) {
				session.steeringQueue.push(steerText);
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
		await this.assertSessionWritable(params.sessionId);
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

	private async desktopForkMessage(params: DesktopQueueSubmitRequest): Promise<DesktopQueueSubmitResponse> {
		await this.assertSessionWritable(params.sessionId);
		const session = this.requireDesktopSession(params.sessionId);
		await this.ensureDesktopQueuesLoaded(session);
		const message = await this.desktopQueuedMessage(params);
		await session.forks.admit(message);
		if (this.clientName === "pix-desktop" && message.displayText.trim()) {
			void queueRequestHistoryEntry(message.displayText).catch(() => undefined);
		}
		return { disposition: "fork", itemId: message.id };
	}

	private createForkQueue(owner: () => AgentSessionState): DesktopForkQueue {
		const childIds = new Map<string, string>();
		return new DesktopForkQueue({
			isLive: () => !this.disposed && this.sessions.get(owner().acpSessionId) === owner(),
			captureIdle: async () => {
				const session = owner();
				const busy = (state: PiSessionState) => session.activeRun || session.builtinRunning
					|| state.isStreaming || state.isCompacting;
				const state = await session.pi.getState();
				if (busy(state)) return undefined;
				if (!state.sessionFile) throw new Error("fork requires a persistent source session");
				const entries = await session.pi.getEntries();
				const checked = await session.pi.getState();
				if (busy(checked) || checked.sessionFile !== state.sessionFile) return undefined;
				const hasConversation = entries.entries.some((entry) => entry.type === "message" && isRecord(entry.message)
					&& (entry.message.role === "user" || entry.message.role === "assistant"));
				return { sessionPath: resolve(state.sessionFile), leafId: entries.leafId, cwd: session.cwd,
					...(!hasConversation ? { unflushedEntries: entries.entries } : {}) };
			},
			create: this.options.createDesktopForkSnapshot ?? createDesktopForkSnapshot,
			saveChild: async (child, message) => {
				const session = owner();
				const sessionId = randomUUID();
				childIds.set(child.sessionPath, sessionId);
				await this.saveDesktopQueues(session.cwd, child.sessionPath, { auto: [message], deferred: [], fork: [] });
				await this.sessionMap.put({ sessionId, piSessionPath: child.sessionPath,
					piSessionId: child.piSessionId, cwd: session.cwd, updatedAt: new Date().toISOString() });
			},
			announce: async (child) => {
				const session = owner();
				const sessionId = childIds.get(child.sessionPath);
				if (!sessionId) throw new Error("fork child registration missing");
				await session.client.notify(PIX_FORK_READY_METHOD, {
					sourceSessionId: session.acpSessionId, sessionId, cwd: session.cwd,
				});
				childIds.delete(child.sessionPath);
			},
			cleanup: async (child) => {
				const sessionId = childIds.get(child.sessionPath);
				childIds.delete(child.sessionPath);
				const results = await Promise.allSettled([
					this.options.saveDesktopQueues
						? this.saveDesktopQueues(owner().cwd, child.sessionPath, { auto: [], deferred: [], fork: [] })
						: removeDesktopQueueTab(owner().cwd, child.sessionPath),
					...(sessionId ? [this.sessionMap.delete(sessionId)] : []),
					rm(child.sessionPath, { force: true }),
				]);
				for (const result of results) if (result.status === "rejected") {
					this.options.logger.warn(`fork orphan cleanup failed: ${stringifyUnknown(result.reason)}`);
				}
			},
			persist: () => this.saveDesktopQueues(owner().cwd, owner().queueSessionPath, {
				auto: owner().autoUserMessages, deferred: owner().deferredUserMessages, fork: owner().forks.messages,
			}),
			changed: () => this.notifyDesktopQueueState(owner()),
			report: (error) => this.options.logger.warn(`queued fork failed: ${stringifyUnknown(error)}`),
		});
	}

	private retireForkQueue(session: AgentSessionState): void {
		session.forks.close();
		const pending = session.forks.settled();
		this.retiringForkQueues.add(pending);
		const path = session.queueSessionPath;
		if (path) this.retiringForkQueuePaths.set(path, pending);
		void pending.finally(() => {
			this.retiringForkQueues.delete(pending);
			if (path && this.retiringForkQueuePaths.get(path) === pending) this.retiringForkQueuePaths.delete(path);
		}).catch(() => {});
	}

	private async desktopTakeAutoMessage(params: DesktopSessionRequest): Promise<DesktopQueueActionResponse> {
		await this.assertSessionWritable(params.sessionId);
		const session = this.requireDesktopSession(params.sessionId);
		await this.ensureDesktopQueuesLoaded(session);
		const state = await session.pi.getState();
		if (session.activeRun || session.builtinRunning || state.isStreaming || state.isCompacting) return {};
		const message = session.autoUserMessages.shift();
		if (!message) return {};
		try {
			await this.persistDesktopQueues(session);
		} catch (error) {
			session.autoUserMessages.unshift(message);
			throw error;
		}
		await this.notifyDesktopQueueState(session);
		return { message: cloneQueuedUserMessage(message) };
	}

	private async desktopQueueAction(params: DesktopQueueActionRequest): Promise<DesktopQueueActionResponse> {
		await this.assertSessionWritable(params.sessionId);
		const session = this.requireDesktopSession(params.sessionId);
		await this.ensureDesktopQueuesLoaded(session);
		if (params.source === "fork") {
			if (params.action === "send-now") throw new RequestError(ERROR_INVALID_PARAMS, "send-now is not supported for fork messages");
			const removed = await session.forks.take(params.index, params.text);
			if (!removed) throw queueItemMissingError();
			await this.notifyDesktopQueueState(session);
			return params.action === "edit" ? { message: cloneQueuedUserMessage(removed) } : {};
		}
		const state = await session.pi.getState();
		const interruptRequired = params.action === "send-now"
			&& (Boolean(session.activeRun) || state.isStreaming || state.isCompacting === true);

		let removed: DesktopQueuedUserMessage;
		if (params.source === "auto" || params.source === "deferred") {
			const source = params.source === "auto" ? session.autoUserMessages : session.deferredUserMessages;
			const candidate = source[params.index];
			if (!candidate || candidate.displayText !== params.text) throw queueItemMissingError();
			removed = source.splice(params.index, 1)[0]!;
			try {
				await this.persistDesktopQueues(session);
			} catch (error) {
				source.splice(params.index, 0, removed);
				throw error;
			}
			if (interruptRequired) {
				let queued: Awaited<ReturnType<typeof session.pi.clearQueue>>;
				try {
					queued = await session.pi.clearQueue();
				} catch (error) {
					source.splice(params.index, 0, removed);
					await this.persistDesktopQueues(session);
					throw error;
				}
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
			try {
				await this.interruptForQueuedSend(session);
			} catch (error) {
				// The client never received this payload. Keep it manually queued
				// instead of losing it (or automatically retrying an uncertain send).
				session.deferredUserMessages.push(removed);
				await this.persistDesktopQueues(session);
				await this.notifyDesktopQueueState(session);
				throw error;
			}
		}
		return {
			message: cloneQueuedUserMessage(removed),
		};
	}

	private async interruptForQueuedSend(session: AgentSessionState): Promise<void> {
		const run = session.activeRun;
		const hadActiveRun = Boolean(run);
		const wasCancelled = run?.cancelled;
		if (run) run.cancelled = true;
		try {
			await session.pi.abort();
		} catch (error) {
			if (run && session.activeRun === run && !run.settlement) run.cancelled = wasCancelled ?? false;
			throw error;
		}
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
		// A closed owner may still be restoring a consumed fork item after its
		// worker was invalidated. Do not hydrate a replacement from an interim state.
		if (sessionPath) await this.retiringForkQueuePaths.get(sessionPath);
		const persisted = await this.loadDesktopQueues(session.cwd, sessionPath);
		session.queueSessionPath = sessionPath;
		session.autoUserMessages = persisted.auto.map(cloneQueuedUserMessage);
		session.deferredUserMessages = persisted.deferred.map(cloneQueuedUserMessage);
		session.forks.load(persisted.fork ?? []);
		void session.forks.tryIdle();
	}

	private async persistDesktopQueues(session: AgentSessionState): Promise<void> {
		await this.ensureDesktopQueuesLoaded(session);
		await this.saveDesktopQueues(session.cwd, session.queueSessionPath, {
			auto: session.autoUserMessages,
			deferred: session.deferredUserMessages,
			fork: session.forks.messages,
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
		return { sessionId: session.acpSessionId, items: [...steering, ...followUp, ...auto, ...deferred, ...session.forks.items()] };
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
		if ((!params.full || (record?.subagent && !session)) && record?.piSessionPath) {
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
		await this.assertSessionWritable(params.sessionId);
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
		await this.assertSessionWritable(params.sessionId);
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
		await this.assertSessionPathAvailable(sessionPath);
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
		await this.assertSessionWritable(params.sessionId);
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
		await this.assertSessionPathAvailable(sourcePath);
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
				if (this.pendingDesktopNewSessions.get(acpSessionId)?.promise === pending) {
					this.pendingDesktopNewSessions.delete(acpSessionId);
				}
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
		const viewer = await this.loadSubagentViewer(params.sessionId);
		if (viewer) return viewer;
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
		const viewer = await this.loadSubagentViewer(params.sessionId);
		if (viewer) return viewer;
		return this.loadOrResumeSession(params, client, { replay: false });
	}

	/** Viewers never spawn Pi: return the link/state so Desktop renders persisted history read-only. */
	private async loadSubagentViewer(sessionId: string): Promise<LoadSessionResponse | undefined> {
		if (this.sessions.has(sessionId)) return undefined;
		const record = await this.sessionMap.get(sessionId);
		if (!record?.subagent) return undefined;
		const state = await this.readSubagentRecordState(record);
		return { _meta: { [PIX_SUBAGENT_META_KEY]: { ...record.subagent, ...state } } };
	}

	private async readSubagentRecordState(record: SessionMapRecord): Promise<SubagentSessionState> {
		if (!record.subagent) throw new RequestError(ERROR_SERVER, `session ${record.sessionId} is not a sub-agent viewer`);
		const resolved = await resolveSubagentSession(record.cwd, record.subagent.runDir, record.subagent.agentId);
		const [state, summary] = await Promise.all([
			readSubagentSessionState(resolved),
			readSubagentSessionSummary(resolved.sessionFile),
		]);
		const displayState = { ...state, ...(summary.todo ? { todo: summary.todo } : {}) };
		if (!summary.provider || !summary.modelId) return displayState;
		const runtime = await this.getViewerModelRuntime();
		let model: { name?: string; contextWindow?: number } | undefined;
		try {
			model = runtime?.getModel(summary.provider, summary.modelId) as typeof model;
		} catch {
			model = undefined;
		}
		const contextWindow = typeof model?.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : undefined;
		const tokens = summary.contextTokens ?? null;
		const recordedModel = { provider: summary.provider, id: summary.modelId };
		const modelUsage = await this.queryViewerModelUsage({
			model: recordedModel, thinkingLevel: summary.thinking ?? "off",
			sessionId: record.piSessionId, isStreaming: false,
		});
		return {
			...displayState,
			modelUsageRefresh: modelUsage.refresh,
			...this.modelUsageResponseFields(recordedModel, modelUsage),
			model: {
				provider: summary.provider,
				modelId: summary.modelId,
				name: typeof model?.name === "string" && model.name.trim() ? model.name : summary.modelId,
				...(summary.thinking ? { thinking: summary.thinking } : {}),
			},
			...(contextWindow ? {
				context: { tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 },
			} : {}),
		};
	}

	private getViewerModelRuntime(): Promise<ModelRuntime | undefined> {
		this.viewerModelRuntime ??= (async () => {
			try {
				const agentDir = this.options.agentDir ?? getAgentDir();
				const runtime = await ModelRuntime.create({
					authPath: join(agentDir, "auth.json"),
					modelsPath: join(agentDir, "models.json"),
					refreshOnCreate: false,
				});
				await runtime.refresh({ allowNetwork: false }).catch(() => undefined);
				return runtime;
			} catch (error) {
				this.options.logger.warn(`sub-agent viewer model catalogue unavailable: ${stringifyUnknown(error)}`);
				return undefined;
			}
		})();
		return this.viewerModelRuntime;
	}

	private queryViewerModelUsage(state: PiSessionState): Promise<ModelUsageRefreshResult> {
		const key = `${state.model?.provider}/${state.model?.id}/${state.thinkingLevel}`;
		const cached = this.viewerModelUsage.get(key);
		if (cached && Date.now() - cached.at < 60_000) return cached.result;
		const result = this.querySessionModelUsage("viewer", state).catch((error: unknown) => {
			this.options.logger.warn(`sub-agent viewer quota unavailable: ${stringifyUnknown(error)}`);
			return { refresh: "failed" as const };
		});
		this.viewerModelUsage.delete(key);
		this.viewerModelUsage.set(key, { at: Date.now(), result });
		while (this.viewerModelUsage.size > 32) this.viewerModelUsage.delete(this.viewerModelUsage.keys().next().value!);
		return result;
	}

	private async subagentOpenSession(params: DesktopSubagentOpenSessionRequest): Promise<DesktopSubagentOpenSessionResponse> {
		const parent = this.sessions.get(params.sessionId);
		const parentRecord = parent ? undefined : await this.sessionMap.get(params.sessionId);
		const cwd = parent?.cwd ?? parentRecord?.cwd;
		if (!cwd) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		const resolved = await resolveSubagentSession(cwd, params.runDir, params.agentId);
		const link = { runDir: resolved.runDir, agentId: resolved.agentId, parentSessionId: params.sessionId };
		const existing = (await this.sessionMap.list(cwd)).find((record) => resolve(record.piSessionPath) === resolved.sessionFile);
		if (existing && !existing.subagent) {
			throw new RequestError(ERROR_SERVER, "sub-agent session file is already registered as an ordinary session");
		}
		const sessionId = existing?.sessionId ?? randomUUID();
		const record: SessionMapRecord = {
			sessionId,
			piSessionPath: resolved.sessionFile,
			piSessionId: (await readSessionHeaderId(resolved.sessionFile)) ?? sessionId,
			cwd,
			title: existing?.title ?? `Sub-agent ${resolved.agentId}`,
			subagent: link,
			updatedAt: existing?.updatedAt ?? new Date().toISOString(),
		};
		await this.sessionMap.put(record);
		const state = await this.readSubagentRecordState(record);
		this.options.logger.info(`subagents/open_session: ${resolved.agentId} → ${sessionId}`);
		return { sessionId, link, ...state };
	}

	private async subagentSessionState(params: DesktopSessionRequest): Promise<DesktopSubagentSessionStateResponse> {
		const record = await this.sessionMap.get(params.sessionId);
		if (!record) throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		return await this.readSubagentRecordState(record);
	}

	private async subagentForkSession(params: DesktopSessionRequest): Promise<DesktopSubagentForkSessionResponse> {
		const record = await this.sessionMap.get(params.sessionId);
		if (!record?.subagent) throw new RequestError(ERROR_SERVER, `session ${params.sessionId} is not a sub-agent viewer`);
		const resolved = await resolveSubagentSession(record.cwd, record.subagent.runDir, record.subagent.agentId);
		const forked = await forkSubagentSession(resolved.sessionFile, record.cwd);
		const sessionId = randomUUID();
		await this.sessionMap.put({
			sessionId,
			piSessionPath: forked.sessionFile,
			piSessionId: forked.piSessionId,
			cwd: record.cwd,
			parentSessionPath: resolved.sessionFile,
			title: `${record.title ?? `Sub-agent ${resolved.agentId}`} (continued)`,
			updatedAt: new Date().toISOString(),
		});
		this.searchService.changed(record.cwd);
		this.options.logger.info(`subagents/fork_session: ${params.sessionId} → ${sessionId}`);
		return { sessionId };
	}

	private async assertSessionWritable(sessionId: string): Promise<void> {
		const record = await this.sessionMap.get(sessionId);
		if (record?.subagent) throw new RequestError(ERROR_SERVER, "sub-agent session is read-only; continue it in a new session instead");
	}

	private async assertSessionPathAvailable(path: string): Promise<void> {
		const canonical = await realpath(path).catch(() => resolve(path));
		if (isSubagentSessionPath(canonical)) throw new RequestError(ERROR_SERVER, "sub-agent session history is owned by its parent; a second writer is disabled");
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
		await this.assertSessionPathAvailable(record.piSessionPath);
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
		return configOptions ? { configOptions } : {};
	}

	private async listSessions(params: ListSessionsRequest, client: ClientCaller): Promise<ListSessionsResponse> {
		if (params.cwd && this.clientName === "pix-desktop") {
			// SessionManager.list() reads every JSONL body. Return the persisted map
			// immediately and notify Desktop once the slow native reconciliation settles.
			const discovery = this.nativeSessionCatalog.refresh(params.cwd, () => {
				if (this.disposed) return;
				void client.notify(PIX_SESSION_CATALOG_CHANGED_METHOD, { cwd: params.cwd! }).catch(() => {});
			});
			// Only a missing saved Desktop tab needs the slow, authoritative list.
			// Failed discovery must not turn a partial map into a destructive snapshot.
			if (params._meta?.["pix.waitForDiscovery"] === true && !await discovery) {
				throw new RequestError(ERROR_SERVER, "native session discovery did not complete; saved tabs were retained");
			}
		} else {
			// Other ACP clients retain the synchronous, fully reconciled list contract.
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
		}

		const records = await this.sessionMap.list(params.cwd ?? undefined);
		const sessionIdByPath = new Map(records
			.map((record) => [resolve(record.piSessionPath), record.sessionId]));
		const sessions: SessionInfo[] = records.map((record) => {
			const info: SessionInfo = { sessionId: record.sessionId, cwd: record.cwd, updatedAt: record.updatedAt,
				_meta: { "pix.sessionFile": resolve(record.piSessionPath) } };
			if (record.title !== undefined) info.title = record.title;
			if (record.subagent) info._meta = { ...info._meta, [PIX_SUBAGENT_META_KEY]: record.subagent };
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
		const viewer = await this.sessionMap.get(sessionId);
		if (viewer?.subagent) {
			// Forget the viewer only; the parent-owned JSONL is never deleted from Desktop.
			await this.sessionMap.delete(sessionId);
			this.options.logger.info(`session/delete: forgot sub-agent viewer ${sessionId}`);
			return;
		}
		await this.assertSessionWritable(sessionId);
		const record = await this.sessionMap.get(sessionId);
		this.desktopDeferredToolResults.delete(sessionId);
		this.desktopDeferredImages.delete(sessionId);
		if (this.pendingDesktopNewSessions.has(sessionId) || this.sessions.has(sessionId)) {
			await this.closeSession(sessionId);
		}
		if (record?.piSessionPath) {
			const parentPiSessionId = await readSessionHeaderId(record.piSessionPath).catch(() => undefined);
			await rm(record.piSessionPath, { force: true }).catch((error: unknown) => {
				throw new RequestError(ERROR_SERVER, `failed to delete session file: ${stringifyUnknown(error)}`);
			});
			if (parentPiSessionId) await this.removeChildSubagentSessions(record.cwd, parentPiSessionId);
		}
		await this.sessionMap.delete(sessionId);
		if (record) this.searchService.changed(record.cwd);
		this.options.logger.info(`session/delete: ${sessionId}`);
	}

	/** Cascade: a deleted parent session takes its `.pi/subagents/<id>/` children along (decision 0072). */
	private async removeChildSubagentSessions(cwd: string, parentPiSessionId: string): Promise<void> {
		try {
			const outcome = await removeParentSubagentSessions(cwd, parentPiSessionId);
			if (outcome === "removed") this.options.logger.info(`session/delete: removed sub-agent sessions of ${parentPiSessionId}`);
			else if (outcome !== "absent") this.options.logger.warn(`session/delete: kept sub-agent sessions of ${parentPiSessionId} (${outcome})`);
		} catch (error) {
			// The parent is already gone; background cleanup reclaims the orphan later.
			this.options.logger.warn(`session/delete: failed to remove sub-agent sessions of ${parentPiSessionId}: ${stringifyUnknown(error)}`);
		}
	}

	private async forkSession(params: ForkSessionRequest, client: ClientCaller): Promise<{ sessionId: string; configOptions?: SessionConfigOption[]; _meta?: Record<string, unknown> }> {
		await this.assertSessionWritable(params.sessionId);
		const record = await this.sessionMap.get(params.sessionId);
		if (!record?.piSessionPath) {
			throw new RequestError(ERROR_SERVER, `unknown session ${params.sessionId}`);
		}
		await this.assertSessionPathAvailable(record.piSessionPath);
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
		await this.assertSessionWritable(params.sessionId);
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
		const ignoreContextFiles = this.loadIgnoreContextFiles(cwd);
		const privateAgentsPath = !ignoreContextFiles && !startupOverride?.args?.includes("--no-context-files")
			? projectAgentsContextPath(cwd, this.options.logger)
			: undefined;
		const startup = startupOverride ?? piClientOptions(
			this.options.piEntry,
			cwd,
			defaultModel,
			this.options.questionExtensionPath,
			this.options.sessionTitleExtensionPath,
			this.options.workspaceUndoExtensionPath,
			toolsSuiteExtensionPath,
			this.options.quotaWaitExtensionPath,
			ignoreContextFiles,
			this.options.headsUpExtensionPath,
			this.clientName === "pix-desktop" ? this.options.htmlSandboxExtensionPath : undefined,
		);
		const pi = this.options.createPiClient({
			...startup,
			env: { ...startup.env, ...(privateAgentsPath ? { PIX_PROJECT_AGENTS_FILE: privateAgentsPath } : {}) },
		});
		const translator = new EventTranslator({ sessionId: acpSessionId, cwd });
		const updates = new SessionUpdateCoalescer((notification) => {
			void client.notify("session/update", notification).catch((error: unknown) => {
				this.options.logger.warn(`session/update failed: ${stringifyUnknown(error)}`);
			});
		});
		const session: AgentSessionState = {
			acpSessionId,
			activityOwner,
			activitySnapshots: new Map(),
			cwd,
			pi,
			client: orderedSessionClient(client, updates),
			translator,
			updates,
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
			forks: this.createForkQueue(() => session),
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
			claudeRateLimitGeneration: 0,
			runtimeExtensionCommands: new Set(),
			extensionCommandRunning: 0,
			quotaWaitStateRequested: false,
		};
		// Register routing before start so session_start extension state emitted
		// during RPC startup is delivered instead of being dropped.
		this.sessions.set(acpSessionId, session);
		const unsubscribeEvents = pi.onEvent((event) => withPixLogContext(
			{ project: session.cwd, sessionId: session.acpSessionId, module: "rpc-events" },
			() => this.onPiEvent(session, event),
		));
		session.unsubscribeEvents = unsubscribeEvents;
		try {
			await pi.start();
			if (this.disposed || this.sessions.get(acpSessionId) !== session) {
				throw new RequestError(ERROR_SERVER, "adapter is shutting down");
			}
			session.unsubscribeExit = pi.onExit((error) => withPixLogContext(
				{ project: session.cwd, sessionId: session.acpSessionId, module: "rpc-process" },
				() => this.onPiExit(session, error),
			));
			// Spawning is not readiness: the SDK returns before the first RPC
			// response. Retire failed hydration before a model fallback can replace it.
			if (!startupOverride) await this.ensureDesktopQueuesLoaded(session);
			if (this.disposed || this.sessions.get(acpSessionId) !== session) {
				throw new RequestError(ERROR_SERVER, "session closed during startup");
			}
		} catch (error) {
			await this.teardownSession(session);
			throw new RequestError(
				ERROR_SERVER,
				`failed to start pi (${this.options.piEntry}): ${stringifyUnknown(error)}`,
			);
		}
		void session.forks.tryIdle();
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
			this.searchService.changed(cwd);
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
			// Live sessionName can be the bundled first-prompt fallback. Only the
			// native session_info + firstMessage comparison may authorize embedding.
			const nextNamedTitle = record.namedTitle === nextTitle ? record.namedTitle : undefined;
			const titleChanged = nextTitle !== record.title;
			if (piSessionPath === record.piSessionPath && nextTitle === record.title && nextNamedTitle === record.namedTitle) {
				await this.sessionMap.touch(session.acpSessionId);
				this.searchService.changed(session.cwd);
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
				...(nextNamedTitle ? { namedTitle: nextNamedTitle } : { namedTitle: undefined }),
				updatedAt: new Date().toISOString(),
			});
			this.searchService.changed(session.cwd);
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
    // A retiring runtime still owns cancellation of its random request ids.
    if (event.type === "pix_task_run_cancel") {
      void session.client.notify(TASK_RUN_CANCEL_METHOD, { requestId: event.requestId })
        .catch(() => this.options.logger.warn("task launch cancellation delivery failed"));
      return;
    }
		// A replaced process may still flush events while it is stopping. Never
		// route those events into the newer process registered under the same id.
		if (this.sessions.get(session.acpSessionId) !== session) return;
    if (event.type === "pix_task_run_request") {
      void forwardTaskRun(session, event, () => this.sessions.get(session.acpSessionId) === session, this.options.logger);
      return;
    }
		if (event.type === "pix_btw_event") {
			const data = parseBtwEvent(event.data);
			if (data) this.btwOwners.set(session, data.runtimeId);
			if (data) void session.client.notify(PIX_SESSION_STATE_METHOD, {
				sessionId: session.acpSessionId, channel: BTW_CHANNEL, data,
			}).catch(() => { /* Ephemeral progress must never leak through transcript/error logging. */ });
			return;
		}
		// Observe terminal failures only: never persist streamed content, tool args/results,
		// or an ordinary user abort. message_end avoids duplicate update+end diagnostics.
		if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
			this.options.logger.error(`model:failed ${event.message.errorMessage ?? "Request failed"}`, { module: "session.events" });
		} else if (event.type === "compaction_end" && !event.result && !event.aborted) {
			this.options.logger.error(`compaction:failed ${event.errorMessage ?? "Compaction failed"}`, { module: "session.events" });
		} else if (event.type === "auto_retry_end" && !event.success && event.finalError !== "Retry cancelled") {
			this.options.logger.error(`retry:failed ${event.finalError ?? "Retry failed"}`, { module: "session.events" });
		} else if (event.type === "tool_execution_end" && event.isError) {
			this.options.logger.warn(`tool:failed ${event.toolName}`, { module: "session.events" });
		}
		if ((event.type === "turn_end" || event.type === "compaction_end" || event.type === "agent_settled")
			&& typeof event.pixForkSessionPath === "string" && event.pixForkLeafId !== undefined) {
			session.forks.boundary({ sessionPath: event.pixForkSessionPath, leafId: event.pixForkLeafId, cwd: session.cwd });
		}
		if (event.type === "turn_end" || event.type === "compaction_end" || event.type === "agent_settled"
			|| (event.type === "message_end" && (event.message.role === "user" || event.message.role === "assistant"))) {
			this.searchService.changed(session.cwd);
		}

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
			const index = session.trackedSteeringMessages.findIndex((message) => sdkSteeringMessageText(message) === text);
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
		this.sessionRefreshes.schedule(session, "context", () => this.pushContextUsage(session, generation));
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
		this.sessionRefreshes.schedule(session, "config", () => this.pushConfigOptions(session, generation));
	}

	private scheduleModelUsagePush(session: AgentSessionState): void {
		const generation = ++session.modelUsagePushGeneration;
		this.sessionRefreshes.schedule(session, "model", () => this.pushModelUsage(session, generation));
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
		this.sessionRefreshes.forget(session);
		this.resetBtw(session);
		this.retireForkQueue(session);
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
			if (state.channel === CLAUDE_CODE_RATE_LIMIT_EVENT) {
				await this.observeClaudeCodeRateLimit(session, state.data);
				return;
			}
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
				|| state.channel === "pi-tools-suite:async-subagents:live-state";
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
		if (request.method === "notify" && (session.activeRun?.slashPrompt || session.extensionCommandRunning
			|| request.notifyType === "warning" || request.notifyType === "error")) {
			// ACP has no toast equivalent. Keep command feedback and background
			// warnings/errors (including startup preflight failures) visible as
			// system rows, even when no prompt is running.
			await this.notifyAgentMessage(session, request.message, request.notifyType);
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
			if (this.disposed || this.sessions.get(session.acpSessionId) !== session) {
				// A pending elicitation is rejected when its session/transport is
				// retired. This is a normal consequence of shutdown, not a user error.
				this.options.logger.debug("elicitation/create abandoned after session teardown");
			} else {
				this.options.logger.warn(`elicitation/create failed: ${stringifyUnknown(error)}`);
			}
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

	/** Only known bundled control commands may bypass the parent run lifecycle. */
	private runtimeExtensionCommandMatches(session: AgentSessionState, text: string): boolean {
		const name = /^\/(\S+)/.exec(text.trim())?.[1]?.toLowerCase();
		return (name === "wait" || name === "quota-wait" || name === "heads-up") && session.runtimeExtensionCommands.has(name);
	}

	/**
	 * Execute a runtime extension slash command without creating an ActiveRun.
	 *
	 * pi dispatches extension commands in prompt preflight even while the
	 * agent is streaming, so this stays safe mid-run; the command result
	 * reaches the transcript through the `notify` UI bridge.
	 */
	private async runExtensionSlashCommand(session: AgentSessionState, text: string): Promise<PromptResponse> {
		session.extensionCommandRunning++;
		try {
			await session.pi.prompt(text);
		} catch (error) {
			throw new RequestError(ERROR_SERVER, `extension command failed: ${stringifyUnknown(error)}`);
		} finally {
			session.extensionCommandRunning--;
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
		if (event.type === "agent_start" || event.type === "agent_settled" || event.type === "message_end") {
			const running = event.type !== "agent_settled" && (event.type === "agent_start" || Boolean(session.activeRun));
			void this.searchActivity.update(session.acpSessionId, running).catch(() => {
				this.options.logger.warn("Search session activity could not be persisted");
			});
		}
		for (const notification of session.translator.translate(event, session.activeRun?.cancelled === true)) {
			session.updates.push(notification);
		}
		// Lifecycle events (agent_end/agent_settled/...) translate to nothing;
		// never let streamed chunks trail behind their run's settlement.
		if (event.type !== "message_update" && event.type !== "tool_execution_update") session.updates.flush();

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
		if (params.action !== "state") await this.assertSessionWritable(params.sessionId);
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

		if (params.action === "cancel-pause") {
			const run = session.activeRun;
			// A terminal boundary must settle normally, not be resumed by undoing
			// the button. Pi independently guards the earlier finishTurn boundary.
			if (!run || run.cancelled || run.settlement || session.agentControlState !== "pause-requested") {
				return { sessionId: session.acpSessionId, state: session.agentControlState };
			}
			try {
				await session.pi.cancelPause();
			} catch (error) {
				throw new RequestError(ERROR_SERVER, `pi cancel pause failed: ${stringifyUnknown(error)}`);
			}
			if (this.sessions.get(session.acpSessionId) === session && session.activeRun === run
				&& !run.cancelled && !run.settlement && session.agentControlState === "pause-requested") {
				// idle is a terminal signal for adopted runs; cancellation keeps the
				// same busy owner and must not drain Desktop's queued prompts.
				await this.setAgentControlState(session, "running");
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
			const usageCache = params.includeUsageCache && !params.refreshModelUsage ? await this.providerUsageCache.read(models) : undefined;
			if (!current) return { configOptions: [], modelUsageRefresh: "unavailable", modelRoutingEnabled, modelRoutingDefault, ...(usageCache ? { usageCache } : {}) };

			const levels = supportedThinkingLevels(current);
			if (params.thinkingLevel && !levels.includes(params.thinkingLevel)) {
				throw new RequestError(ERROR_INVALID_PARAMS, `${params.modelRef ?? `${current.provider}/${current.id}`} does not support ${params.thinkingLevel} thinking`);
			}
			const thinkingLevel = params.thinkingLevel ?? selectedDefault?.thinkingLevel ?? levels[0] ?? "off";
			const state = { model: current, thinkingLevel, sessionId: "draft", isStreaming: false };
			let modelUsage: (ModelUsageRefreshResult & { cacheInvalidated?: true; cacheScope?: string }) | { refresh: "skipped" } = { refresh: "skipped" };
			if (params.refreshModelUsage) {
				// Panel quotas must not merge route-only telemetry from another login.
				modelUsage = params.includeUsageCache
					? await this.providerUsageCache.query(current, () => this.queryModelUsage(state, { freshOnly: true }))
					: await this.querySessionModelUsage(`draft:${params.cwd}`, state);
			}
			const usageFields = params.includeUsageCache ? {
				...(modelUsage.refresh === "ready" && modelUsage.status ? { modelUsage: modelUsage.status } : {}),
				...("credentialPending" in modelUsage && modelUsage.credentialPending ? { modelUsageCredentialPending: true as const } : {}),
			} : this.modelUsageResponseFields(current, modelUsage);
			return {
				configOptions: [
					modelOption(current, models),
					thoughtLevelOption(thinkingLevel, levels),
				],
				modelUsageRefresh: modelUsage.refresh,
				...usageFields,
				...(usageCache ? { usageCache } : {}),
				...("cacheInvalidated" in modelUsage && modelUsage.cacheInvalidated ? { usageCacheInvalidated: true } : {}),
				...("cacheScope" in modelUsage && modelUsage.cacheScope ? { usageCacheScope: modelUsage.cacheScope } : {}),
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

		const pending = this.queryModelUsage(state).then(async (queried) => {
			// Account polling is route-wide; streamed samples are account-wide.
			this.rememberClaudeCodeQuota(model, queried);
			return this.mergeObservedClaudeCodeUsage(sessionId, model, queried);
		}).finally(() => {
			if (this.modelUsageRefreshes.get(key) === pending) this.modelUsageRefreshes.delete(key);
		});
		this.modelUsageRefreshes.set(key, pending);
		return pending;
	}

	private rateLimitCache(): Promise<ClaudeCodeRateLimitCache | undefined> {
		return this.claudeRateLimits ??= loadClaudeCodeRateLimitCache().catch((error: unknown) => {
			this.options.logger.warn(`Claude Code quota telemetry unavailable: ${stringifyUnknown(error)}`);
			return undefined;
		});
	}

	private async mergeObservedClaudeCodeUsage(
		sessionId: string, model: PiSessionState["model"], result: ModelUsageRefreshResult,
	): Promise<ModelUsageRefreshResult> {
		if (!isClaudeCodeRoute(model) || !this.claudeRateLimits) return result;
		const cache = await this.rateLimitCache();
		if (!cache) return result;
		const key = claudeCodeRouteKey(model);
		// Without a live sample, retain the endpoint's ordinary failure and
		// credential-pending semantics rather than reviving an old cache.
		if (!cache.merge(undefined, key)) return result;
		const status = cache.merge(result.status ?? this.claudeCodeQuotaCache.get(key), key);
		return status ? { refresh: "ready", status } : result;
	}

	private async observeClaudeCodeRateLimit(session: AgentSessionState, value: unknown): Promise<void> {
		const generation = session.claudeRateLimitGeneration;
		try {
			const cache = await this.rateLimitCache();
			if (!cache) return;
			const state = await session.pi.getState();
			if (this.sessions.get(session.acpSessionId) !== session
				|| session.claudeRateLimitGeneration !== generation || !isClaudeCodeRoute(state.model)) return;
			const key = claudeCodeRouteKey(state.model);
			// The transport owner validates provenance; the sample itself is
			// account-wide quota once accepted.
			if (!isRecord(value) || value.modelRef !== key || value.sessionId !== state.sessionId) return;
			if (!cache.observe(value)) return;
		} catch (error) {
			this.options.logger.warn(`Claude Code quota telemetry failed: ${stringifyUnknown(error)}`);
			return;
		}
		await this.pushClaudeCodeQuotaToSessions();
	}

	/** Fan account-wide Claude Code quota out to every live session on a Claude Code route. */
	private async pushClaudeCodeQuotaToSessions(): Promise<void> {
		const cache = await this.rateLimitCache();
		if (!cache) return;
		await Promise.allSettled([...this.sessions.values()].map(async (target) => {
			const generation = target.claudeRateLimitGeneration;
			try {
				const model = (await target.pi.getState()).model;
				if (this.sessions.get(target.acpSessionId) !== target
					|| target.claudeRateLimitGeneration !== generation || !isClaudeCodeRoute(model)) return;
				const key = claudeCodeRouteKey(model);
				const status = cache.merge(this.claudeCodeQuotaCache.get(key), key);
				if (!status) return;
				await target.client.notify(PIX_SESSION_STATE_METHOD, {
					sessionId: target.acpSessionId, channel: CLAUDE_CODE_USAGE_CHANNEL, data: status,
				});
			} catch (error) {
				this.options.logger.warn(`Claude Code quota push failed: ${stringifyUnknown(error)}`);
			}
		}));
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
		const queried = await this.queryModelUsage(state);
		const result = await this.mergeObservedClaudeCodeUsage(session.acpSessionId, state.model, queried);
		// An account/model switch during the endpoint request invalidates its
		// reply just as a switch during the headless nudge does.
		if (this.sessions.get(session.acpSessionId) !== session
			|| claudeCodeRouteKey((await session.pi.getState()).model) !== claudeCodeRouteKey(state.model)) {
			throw new RequestError(ERROR_SERVER, "Claude Code route changed while refreshing limits");
		}
		this.rememberClaudeCodeQuota(state.model, queried);
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

	private async prompt(params: PromptRequest): Promise<PromptResponse> {
		await this.assertSessionWritable(params.sessionId);
		const session = this.sessions.get(params.sessionId);
		if (!session) {
			throw new RequestError(ERROR_SERVER, `session ${params.sessionId} not found`);
		}
		const fileImages = desktopPromptFileImages(params);
		if (fileImages.length > 0 && this.clientName !== "pix-desktop") {
			throw new RequestError(ERROR_SERVER, `${PIX_FILE_IMAGES_META_KEY} is reserved for Pix Desktop`);
		}
		const input = await collectPromptInput(params.prompt, fileImages);
		const isSlashPrompt = input.images.length === 0 && /^\/\S/.test(input.text);

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
		const builtin = parseBuiltinCommand(input.text);
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
		const rendererCommand = rendererCommandName(input.text);
		if (rendererCommand) {
			throw new RequestError(
				ERROR_SERVER,
				`/${rendererCommand} requires Pix renderer UI and is not available as an ACP prompt command`,
			);
		}
		const unsupportedCommand = unsupportedCommandName(input.text);
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
					|| normalizedRuntimeCommandName(name) === MESSAGE_REWIND_RPC_COMMAND
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
	private async notifyAgentMessage(session: AgentSessionState, text: string, notifyType?: string): Promise<void> {
		// Extension errors do not imply the agent stopped. Keep their namespace
		// distinct from the provider-failure pix-system:error: rows.
		const prefix = notifyType === "warning" || notifyType === "error"
			? `pix-system:notification:${notifyType}:` : "pix-system:";
		const notification: SessionNotification = {
			sessionId: session.acpSessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				messageId: `${prefix}${randomUUID()}`,
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
		void this.setAgentControlState(session, "idle");
		this.options.logger.debug(`session/cancel for ${sessionId}`);
		void session.pi.abort().catch((error: unknown) => {
			this.options.logger.warn(`pi abort failed: ${stringifyUnknown(error)}`);
		});
	}

	private async closeSession(sessionId: string): Promise<void> {
		// Viewers have no Pi process; closing the tab has nothing to tear down.
		if (!this.sessions.has(sessionId) && (await this.sessionMap.get(sessionId))?.subagent) return;
		await this.assertSessionWritable(sessionId);
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
		this.sessionRefreshes.forget(session);
		this.resetBtw(session);
		this.retireForkQueue(session);
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
		await this.searchActivity.update(session.acpSessionId, false, true).catch(() => {
			this.options.logger.warn("Search session activity could not be persisted during teardown");
		});
		this.unsubscribeSessionEvents(session);
	}

	private unsubscribeSessionEvents(session: AgentSessionState): void {
		// Quota samples are account-wide and outlive any one session.
		session.claudeRateLimitGeneration++;
		session.unsubscribeExit?.();
		session.unsubscribeExit = undefined;
		const unsubscribe = session.unsubscribeEvents;
		session.unsubscribeEvents = undefined;
		unsubscribe?.();
		session.updates.dispose();
	}

	private resetBtw(session: AgentSessionState): void {
		const runtimeId = this.btwOwners.get(session);
		this.btwOwners.delete(session);
		if (!runtimeId) return;
		// Old process events are deliberately ignored once the session map changes;
		// send the identity-only reset ourselves before retiring that runtime.
		void session.client.notify(PIX_SESSION_STATE_METHOD, { sessionId: session.acpSessionId,
			channel: BTW_CHANNEL, data: { version: 1, runtimeId, requestId: "runtime-reset", sequence: 0,
				phase: "reset", text: "", busyRequestId: null } }).catch(() => {});
	}

	private resolveActiveRun(session: AgentSessionState, stopReason: StopReason): boolean {
		const run = session.activeRun;
		if (!run) return false;
		// The prompt response must follow every streamed update of its run.
		session.updates.flush();
		session.activeRun = undefined;
		run.resolve(stopReason);
		return true;
	}

	private rejectActiveRun(session: AgentSessionState, error: Error): boolean {
		const run = session.activeRun;
		if (!run) return false;
		session.updates.flush();
		session.activeRun = undefined;
		run.reject(error);
		return true;
	}

	/** Resolve attribution per operation, never from the adapter's own cwd. */
	private withRequestLogging<T>(method: string, params: unknown, signal: AbortSignal, operation: () => T | Promise<T>): Promise<T> {
		const value = params as { sessionId?: unknown; cwd?: unknown; workspace?: unknown };
		const sessionId = typeof value?.sessionId === "string" ? value.sessionId : undefined;
		const project = (sessionId ? this.sessions.get(sessionId)?.cwd : undefined)
			?? (typeof value?.cwd === "string" ? value.cwd : typeof value?.workspace === "string" ? value.workspace : null);
		return withLoggedRequest(this.options.logger, method,
			{ project, ...(sessionId ? { sessionId } : {}), module: "requests" }, signal, operation);
	}

	/**
	 * Desktop's Usage panel otherwise pays the usage module import and disk
	 * restore on first open. Defer past the initialize burst, once per process.
	 */
	private scheduleUsageStatsWarmup(): void {
		if (this.usageStatsWarmupScheduled) return;
		this.usageStatsWarmupScheduled = true;
		const timer = setTimeout(() => {
			if (!this.disposed) void this.usageStatsHost.warm();
		}, USAGE_STATS_WARMUP_DELAY_MS);
		timer.unref?.();
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
	headsUpExtensionPath?: string,
	htmlSandboxExtensionPath?: string,
): PiRpcClientOptions {
	const args = [
		...(questionExtensionPath ? ["--extension", questionExtensionPath] : []),
		...(sessionTitleExtensionPath ? ["--extension", sessionTitleExtensionPath] : []),
		...(workspaceUndoExtensionPath ? ["--extension", workspaceUndoExtensionPath] : []),
		...(toolsSuiteExtensionPath ? ["--extension", toolsSuiteExtensionPath] : []),
		...(quotaWaitExtensionPath ? ["--extension", quotaWaitExtensionPath] : []),
		...(headsUpExtensionPath ? ["--extension", headsUpExtensionPath] : []),
		...(htmlSandboxExtensionPath ? ["--extension", htmlSandboxExtensionPath] : []),
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

function projectAgentsContextPath(cwd: string, logger: Logger): string | undefined {
	const file = join(cwd, ".pi", "AGENTS.md");
	try {
		return statSync(file).isFile() ? file : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			logger.warn(`could not inspect project-local AGENTS.md: ${stringifyUnknown(error)}`);
		}
		return undefined;
	}
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
	// The bundled first-prompt naming hook can save the user's first message
	// as session_info.name. Such a fallback remains lexical-only even though
	// native name is populated. Never send it as an embedding input.
	const nativeName = session.name?.trim();
	const originalPrompt = session.firstMessage.trim();
	const nameWithoutEllipsis = nativeName?.replace(/(?:\.\.\.|…)+$/u, "").trim();
	if (nativeName && nameWithoutEllipsis && !originalPrompt.startsWith(nameWithoutEllipsis)) {
		record.namedTitle = nativeName;
	}
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
	queryModelUsageStatus?: (descriptor: unknown, options?: { agentDir?: string; freshOnly?: boolean }) => Promise<DesktopModelUsageStatus | undefined>;
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

async function queryPixModelUsage(state: PiSessionState, agentDir?: string, freshOnly = false): Promise<ModelUsageRefreshResult> {
	try {
		const moduleUrl = new URL("../../../dist/app/model/model-usage-status.js", import.meta.url).href;
		const usage = await import(moduleUrl) as SharedModelUsageModule;
		if (!usage.modelUsageDescriptor || !usage.queryModelUsageStatus) return { refresh: "unavailable" };
		const descriptor = usage.modelUsageDescriptor(state.model, state.thinkingLevel);
		if (!descriptor) return { refresh: "unavailable" };
		const status = await usage.queryModelUsageStatus(descriptor, { ...(agentDir ? { agentDir } : {}), ...(freshOnly ? { freshOnly } : {}) });
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

function sdkSteeringMessageText(message: DesktopQueuedUserMessage): string {
	// SDK 1.3 only consumes queued messages with nonempty text. Keep this
	// compatibility marker out of the original payload used by edit/fork/send-now.
	return message.promptText || (message.images.length > 0 ? "(image message)" : "");
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
	return tracked.filter((message) => sdkSteeringMessageText(message) === text)[occurrence];
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
