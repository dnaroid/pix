import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { BROWSER_QA_RUNNER_ENV, getBrowserQaRunnerPath, getUiQaRunnerPath, isUiQaType, UI_QA_RUNNER_ENV } from "./ui-qa.js";
import { ownedAgentDir, parseRunKey, scopeDir, validateBasename } from "./paths.js";
import { getPiInvocation } from "./pi-invocation.js";
import { generatePrompt } from "./prompt.js";
import { PROJECT_ARTIFACTS_DIR } from "../../artifact-paths.js";
import { getLive, getRecord, updateLive, updateRecord } from "./store.js";
import { terminateProcessTree } from "./process.js";
import { getAgentSessionDir, getParentSubagentSessionDir } from "./sessions.js";
import { SUBAGENT_META_ENV, type SubagentMeta } from "./subagent-meta.js";
import { isPathInside } from "../../model-tools/path-utils.js";
import { getAgentState } from "./state.js";
import { settleStructuredResult } from "./structured-result.js";
import { resolveSubagentLogLimits } from "./log-limits.js";
import { filterSubagentTools } from "./tool-guard.js";
import { selectSubagentToolsForModel, subagentWorkTools, SUBAGENT_WORK_TOOLS_ENV, withSubagentCapabilities } from "./child-tools.js";
import type { AgentCompletionHandler, AgentState, AgentTask, RpcEventHandler, RpcEventRecord, SpawnedAgent } from "./types.js";
import { isRecord, isoNow, serializeJsonLine } from "./utils.js";
import { forgetOwnedHandle, launchPreparedOwnedAgent, ownedOutcomeSync, readOwnedMetadata, requestOwnedCancel, writeOwnedBootstrapFailureResult, OWNED_METADATA, type OwnedLaunchBinaries, type OwnedLaunchHandle } from "./owned-launch-integration.js";
import { ownedArtifactsPresentSync, ownedDeletableSync, verifyOwnedRetirementAsync } from "./owned-retirement.js";
import {
	normalizeProviderArgs,
	resolveFinalModel,
	resolveProviderExtensions,
	selectsClaudeProvider,
	subagentEnvModel,
	type InstalledPackageLocator,
} from "./provider-extensions.js";
import { fenceOwnedLaunchRunAsync, ownedLaunchClaimProtocolSync, readOwnedLaunchClaimSync } from "./owned-launch/marker.js";
import { RPC_SESSION_STATE_ENV } from "../../lib/rpc-session-state.js";
import { todoProgressFromRpcEvent } from "./todo-progress.js";
import { LiveChannelClosingError, registerLiveChannel, unregisterLiveChannel, type LiveAgentChannel, type LiveSendMode, type LiveSendResult } from "./live-channel.js";

export interface SpawnAgentResumeOptions {
	/** Message that starts the resumed turn (sent instead of the generated prompt). */
	message: string;
	/** Existing pi session file to continue. */
	sessionFile: string;
}

export interface SpawnAgentOptions {
	/** Continue an existing persisted session instead of starting a fresh one. */
	resume?: SpawnAgentResumeOptions;
	parentSession?: string;
	/** Parent session id; selects `.pi/subagents/<parentSessionId>/` for the child session (decision 0072). */
	parentSessionId?: string;
	timeoutMs?: number;
	maxResultBytes?: number;
	ownedBinaries?: OwnedLaunchBinaries;
	/** launchd jobs cannot access the project/run directories: skip owned launch. */
	ownedLaunchUnavailable?: boolean;
	/** Test seam for Pi's installed-package lookup (provider dependency resolution). */
	locateProviderPackagesForTest?: InstalledPackageLocator;
	/** Unit-test-only native boundary; production tool never supplies this. */
	ownedLaunchForTest?: (request: { agentDir: string; command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; binaries: OwnedLaunchBinaries; timeouts?: { watchdogSeconds: number } }) => OwnedLaunchHandle;
}

export const DEFAULT_AGENT_TIMEOUT_MS = 3 * 60 * 60 * 1000;
const UI_QA_WORKSPACE_DIR = "ui-qa";
const UI_QA_BROWSER_WORKSPACE_DIR = "browser";
const SUBAGENT_AGENT_DIR_ENV = "PI_SUBAGENT_AGENT_DIR";
const AGENT_TIMEOUT_EXIT_CODE = 124;
const AGENT_TIMEOUT_KILL_GRACE_MS = 5_000;
const AGENT_SETTLED_TERMINATE_GRACE_MS = 50;
const AGENT_SETTLED_COMPLETION_FALLBACK_MS = 1_000;
const LIVE_SEND_RESPONSE_TIMEOUT_MS = 30_000;
const INITIAL_PROMPT_ID = "sub_prompt";
const SETTLE_CHECK_ID_PREFIX = "sub_settle_check_";
const LIVE_SEND_ID_PREFIX = "sub_live_send_";
const EXIT_STDIO_FLUSH_GRACE_MS = 10;
/** In-memory stderr tail per agent (never written to disk). */
const STDERR_TAIL_MAX_CHARS = 256 * 1024;
/** Bound of a parent-authored result message persisted in the parent session. */
const RESULT_MESSAGE_MAX_CHARS = 64 * 1024;
/** Background drain-settlement poll interval; bounded so the loop stays off the hot path. */
const OWNED_SETTLE_INTERVAL_MS = 1_000;
/** Grace after the bridge ended before a never-released run may be probed for absent jobs. */
const OWNED_BRIDGE_END_GRACE_MS = 2_000;
/** Bounded launchctl budget while settling a completion (retirement marker caching). */
const OWNED_SETTLE_RETIREMENT_BUDGET_MS = 10_000;

export function spawnAgent(
	runDir: string,
	task: AgentTask,
	cwd: string,
	extraArgs: string[] = [],
	onRpcEvent?: RpcEventHandler,
	onComplete?: AgentCompletionHandler,
	options: SpawnAgentOptions = {},
): SpawnedAgent {
	validateBasename(task.id, "task.id");
	// The only per-agent directory: the owned-launch base, created only for
	// owned launches. Everything else lives in the parent session (decision 0072).
	const agentDir = ownedAgentDir(runDir, task.id);
	// Sub-agent roles are self-contained. Never inherit/discover skills, and do
	// not allow profile/user extra args to re-enable or inject them. Model and
	// provider override spellings the child CLI rejects are normalized first,
	// so ownership, provider dependencies, and the child agree on one model.
	const forwardedExtraArgs = normalizeProviderArgs(withoutSkillArgs(extraArgs));
	const configuredModel = task.model?.trim() || subagentEnvModel();
	const selectedModel = resolveFinalModel(configuredModel, forwardedExtraArgs);
	const explicitModel = resolveFinalModel(task.model, forwardedExtraArgs);
	const claudeSelected = selectsClaudeProvider(selectedModel, forwardedExtraArgs);
	// launchd cannot reach the project (TCC/external volume, no GUI domain):
	// the Claude provider then uses the ordinary process-group launch.
	const owned = claudeSelected && !options.ownedLaunchUnavailable;
	// This check MUST precede reuse cleanup and any child spawn, including direct
	// spawnAgent calls that bypass the asynchronous tool preflight.
	if (owned && (process.platform !== "darwin" || !options.ownedBinaries))
		throw new Error("pi-claude-code-provider requires prepared macOS owned-launch binaries");
	// Extension-backed providers are resolved before any artifact changes or
	// child exists; a ProviderExtensionError is permanent (a synchronous throw
	// is never retried and never falls back).
	const providerExtensions = resolveProviderExtensions({
		selectedModel, explicitModel, claudeSelected, forwardedArgs: forwardedExtraArgs, cwd,
		locateInstalled: options.locateProviderPackagesForTest,
	});
	// Kernel drain and launchd retirement are distinct facts: reuse is refused
	// until every owned-launch UUID directory (including any left from older
	// generations, even without a readable pointer) is both terminal and retired.
	if (ownedArtifactsPresentSync(agentDir) && !ownedDeletableSync(agentDir))
		throw new Error("previous owned sub-agent is not verified drained and retired; refusing reuse");

	const resume = options.resume;
	const parsedRun = parseRunKey(runDir);
	const subagentSessionDir = parsedRun
		? scopeDir(parsedRun.cwd, parsedRun.scope)
		: getParentSubagentSessionDir(cwd, options.parentSessionId) ?? getAgentSessionDir(path.join(runDir, task.id));
	if (!resume) {
		// A fresh attempt drops only its own previous transcript, never the
		// shared parent-scoped child directory.
		const previousSessionFile = getRecord(runDir, task.id)?.childSessionFile;
		if (previousSessionFile && isPathInside(subagentSessionDir, previousSessionFile)) fs.rmSync(previousSessionFile, { force: true });
	}
	// Owned control markers of a previous attempt (the owned base is reused
	// only after the guard above proved it drained and retired).
	for (const f of ["exit_code", "finished_at", "result.md", "timeout_ms", "timed_out_at", "stop_requested", "stop_signal", OWNED_METADATA]) {
		try {
			fs.unlinkSync(path.join(agentDir, f));
		} catch {
			/* absent */
		}
	}
	if (owned) fs.mkdirSync(agentDir, { recursive: true });
	const uiQaWorkspace = isUiQaType(task.subagentType) ? prepareUiQaWorkspace(cwd, runDir, task.id) : undefined;

	// Build pi args. By default sub-agents use the parent/default model.
	// E2E/live deployments can pin the real model explicitly through env so
	// detached subprocesses do not depend on persisted local pi settings.
	// Every child is a full persisted Pi session (needed for `send` resume,
	// session navigation and Desktop viewer tabs).
	// Children of a persisted parent live in the standard Pi store, nested under
	// the parent's session directory (decision 0072); otherwise the legacy dir.
	const sessionDir = subagentSessionDir;
	fs.mkdirSync(sessionDir, { recursive: true });
	let piArgs: string[] = ["--mode", "rpc", "--session-dir", sessionDir];
	if (resume) piArgs.push("--session", resume.sessionFile);
	piArgs.push("--no-extensions");
	piArgs.push("--extension", getModelToolsExtensionPath());
	piArgs.push("--extension", getSubagentTodoExtensionPath());
	piArgs.push("--extension", getSubagentRepoExtensionPath());
	piArgs.push("--extension", getSubagentDcpExtensionPath());
	// `--no-extensions` stays; only the allowlisted provider dependencies of
	// the final selected model are added (see provider-extensions.ts).
	for (const extension of providerExtensions) piArgs.push("--extension", extension);
	piArgs.push("--no-skills");
	if (configuredModel) piArgs.push("--model", configuredModel);
	const selectedTools = task.tools ? filterSubagentTools(selectSubagentToolsForModel(selectedModel, task.tools)) : undefined;
	if (selectedTools) {
		if (selectedTools.length > 0) piArgs.push("--tools", selectedTools.join(","));
		else piArgs.push("--no-tools");
	}
	if (task.thinking) piArgs.push("--thinking", task.thinking);

	// User-supplied extra args (e.g. --thinking high)
	piArgs.push(...forwardedExtraArgs);
	piArgs = withSubagentCapabilities(piArgs);
	const workTools = subagentWorkTools(piArgs);
	if (workTools.optional.length) {
		piArgs.push("--extension", path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "work-tools.ts"));
	}
	// The child always runs one explicitly selected model. Override persisted
	// enabledModels (and any extra --models value) so isolated children do not
	// resolve unrelated provider patterns before their limited extensions load.
	if (selectedModel) piArgs.push("--models", selectedModel);
	// Keep recursive/interactive parent-only tools disabled even if explicit
	// sub-agent extraArgs load additional extensions or override --tools.
	piArgs.push("--extension", getSubagentToolGuardExtensionPath());

	const promptContent = resume ? resume.message : generatePrompt(task);
	const promptImages = !resume && task.imagePaths && task.imagePaths.length > 0 ? readPromptImages(task.imagePaths, cwd) : undefined;

	// Durable launch facts go to the parent session; a fresh attempt resets
	// every outcome field of a reused agent id.
	updateRecord(runDir, task.id, {
		...(resume ? {} : { ...(getRecord(runDir, task.id)?.task === task ? {} : { task }), extraArgs, timeoutMs: options.timeoutMs, maxResultBytes: options.maxResultBytes, turn: 1, childSessionFile: null }),
		cwd,
		subagentType: task.subagentType,
		model: task.model,
		parentSession: options.parentSession,
		status: "running",
		startedAt: isoNow(),
		exitCode: null, finishedAt: null, nextRetryAt: null, pid: null, processGroup: null,
		stopRequested: null, stopSignal: null, timedOut: null, structured: null, message: null, stderrPreview: null,
	});
	updateLive(runDir, task.id, { active: true, resultText: undefined, stderrTail: undefined, lastActivity: undefined, todoProgress: undefined, launchArgs: [...piArgs] });

	const logLimits = resolveSubagentLogLimits();
	const invocation = getPiInvocation(piArgs);
	const stderrMaxChars = Math.max(1024, Math.min(logLimits.stderrMaxBytes || STDERR_TAIL_MAX_CHARS, STDERR_TAIL_MAX_CHARS));
	const appendStderr = (text: string) => {
		const next = `${getLive(runDir, task.id)?.stderrTail ?? ""}${text}`;
		updateLive(runDir, task.id, { stderrTail: next.length > stderrMaxChars ? next.slice(-stderrMaxChars) : next });
	};
	/** Final result text; `persist` stores a bounded copy for parent-authored outcomes the child session lacks. */
	const setResult = (text: string, persist: boolean) => {
		updateLive(runDir, task.id, { resultText: text });
		if (persist) updateRecord(runDir, task.id, { message: text.length > RESULT_MESSAGE_MAX_CHARS ? `${text.slice(0, RESULT_MESSAGE_MAX_CHARS)}\n…[truncated]` : text });
	};
	const resultUnset = () => getLive(runDir, task.id)?.resultText === undefined;
	const stopRequested = () => getRecord(runDir, task.id)?.stopRequested === true || fs.existsSync(path.join(agentDir, "stop_requested"));

	const env = subagentEnvironment(process.env, uiQaWorkspace);
	// Always overwrite inherited state so retries/nested test processes cannot
	// carry another child's capability selection into this attempt.
	env[SUBAGENT_WORK_TOOLS_ENV] = JSON.stringify(workTools);
	const meta: SubagentMeta = {
		version: 1,
		agentId: task.id,
		batch: parsedRun?.batch ?? path.basename(runDir),
		...(parsedRun ? { scope: parsedRun.scope } : {}),
		runDir,
		cwd,
		...(task.subagentType ? { subagentType: task.subagentType } : {}),
		...(options.parentSession ? { parentSession: options.parentSession } : {}),
		...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
	};
	env[SUBAGENT_META_ENV] = JSON.stringify(meta);
	const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
	const ownedHandle = owned ? (options.ownedLaunchForTest ?? launchPreparedOwnedAgent)({
		agentDir, command: invocation.command, args: invocation.args, cwd, env, binaries: options.ownedBinaries!,
		timeouts: timeoutMs > 0 ? { watchdogSeconds: Math.ceil(timeoutMs / 1000) } : undefined,
	}) : undefined;
	// The prepared bridge guarantees three piped stdio streams, just as spawn() does.
	const proc: ChildProcessWithoutNullStreams = (ownedHandle?.process as ChildProcessWithoutNullStreams | undefined) ?? spawn(invocation.command, invocation.args, {
		cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	proc.stdin.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") return;
		appendStderr(`${String(error)}\n`);
	});
	let completedFromAgentEnd = false;
	let completionNotified = false;
	let lastAssistantResult = "";
	let lastAgentEndError = "";
	let timedOut = false;
	let agentSettledRequested = false;
	let shouldKeepStderr = false;
	let timeoutTimer: NodeJS.Timeout | undefined;
	let timeoutKillTimer: NodeJS.Timeout | undefined;
	let agentSettledKillTimer: NodeJS.Timeout | undefined;
	let agentSettledCompletionFallbackTimer: NodeJS.Timeout | undefined;
	let processExitTreeKillTimer: NodeJS.Timeout | undefined;
	let exitFinalizationTimer: NodeJS.Timeout | undefined;
	let processTermination: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	let stdoutEnded = false;
	// Live channel: the parent may queue follow-up/steer prompts into this
	// running RPC child. agent_settled only terminates once no accepted or
	// pending live send could start another run in the same process.
	let liveSendSeq = 0;
	let settleCheckSeq = 0;
	let runGeneration = 0;
	let liveSendSinceRunStart = false;
	let settledAwaitingCheck = false;
	let channelClosing = false;
	let channelReleased = false;
	const pendingLiveSends = new Map<string, { resolve: (result: LiveSendResult) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
	let resolveInitialPromptAccepted!: () => void;
	const initialPromptAccepted = new Promise<void>((resolve) => { resolveInitialPromptAccepted = resolve; });
	let resolveChannelFinished!: () => void;
	const channelFinished = new Promise<void>((resolve) => { resolveChannelFinished = resolve; });
	const releaseLiveChannel = () => {
		channelClosing = true;
		if (channelReleased) return;
		channelReleased = true;
		resolveInitialPromptAccepted();
		for (const pending of pendingLiveSends.values()) {
			clearTimeout(pending.timer);
			pending.reject(new LiveChannelClosingError());
		}
		pendingLiveSends.clear();
		unregisterLiveChannel(liveChannel);
		resolveChannelFinished();
	};
	const sendLive = async (message: string, mode: LiveSendMode): Promise<LiveSendResult> => {
		if (channelClosing) throw new LiveChannelClosingError();
		// Never race the initial prompt's preflight: two idle prompts would both start runs.
		await initialPromptAccepted;
		if (channelClosing) throw new LiveChannelClosingError();
		const id = `${LIVE_SEND_ID_PREFIX}${++liveSendSeq}`;
		liveSendSinceRunStart = true;
		return await new Promise<LiveSendResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				pendingLiveSends.delete(id);
				reject(new Error("timed out waiting for the sub-agent to accept the message"));
				requestSettleCheck();
			}, LIVE_SEND_RESPONSE_TIMEOUT_MS);
			timer.unref?.();
			pendingLiveSends.set(id, { resolve, reject, timer });
			try {
				proc.stdin.write(serializeJsonLine({ id, type: "prompt", message, streamingBehavior: mode }));
			} catch (error) {
				clearTimeout(timer);
				pendingLiveSends.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	};
	const liveChannel: LiveAgentChannel = {
		agentDir,
		isClosing: () => channelClosing,
		finished: channelFinished,
		send: sendLive,
	};
	/** After agent_settled with live sends involved, ask the child whether it is truly idle. */
	const requestSettleCheck = () => {
		if (!settledAwaitingCheck || pendingLiveSends.size > 0 || completionNotified) return;
		const id = `${SETTLE_CHECK_ID_PREFIX}${runGeneration}_${++settleCheckSeq}`;
		liveSendSinceRunStart = false;
		try {
			proc.stdin.write(serializeJsonLine({ id, type: "get_state" }));
		} catch {
			settledAwaitingCheck = false;
			scheduleAgentSettledTermination();
		}
	};
	const handleSettleCheckResponse = (event: RpcEventRecord) => {
		const id = String(event.id);
		const generation = Number(id.slice(SETTLE_CHECK_ID_PREFIX.length).split("_")[0]);
		// A newer run started after this check was requested; its own agent_settled decides.
		if (!settledAwaitingCheck || generation !== runGeneration) return;
		if (pendingLiveSends.size > 0 || liveSendSinceRunStart) {
			requestSettleCheck();
			return;
		}
		const data = isRecord(event.data) ? event.data : {};
		const busy = data.isStreaming === true || (typeof data.pendingMessageCount === "number" && data.pendingMessageCount > 0);
		if (busy) {
			settledAwaitingCheck = false;
			return;
		}
		settledAwaitingCheck = false;
		scheduleAgentSettledTermination();
	};
	const scheduleProcessTreeKill = (reason: string) => {
		if (processExitTreeKillTimer) return;
		processExitTreeKillTimer = setTimeout(() => {
			try {
				terminateChildProcessTree(proc, "SIGKILL");
			} catch {
				/* process group may already be gone */
			}
		}, AGENT_SETTLED_COMPLETION_FALLBACK_MS);
		processExitTreeKillTimer.unref?.();
	};

	const notifyComplete = (exitCode: number) => {
		if (completionNotified) return;
		releaseLiveChannel();
		if (ownedHandle) {
			// Do not release the semaphore or enter retry/fallback while cleanup is
			// uncertain. Poll tiny durable receipts off the hot path until a
			// terminal proof exists; a missing receipt leaves ownership explicitly
			// pending, never terminal, and the background poll never gives up.
			if (ownedCompletionPending) return;
			ownedCompletionPending = true;
			ownedPendingExitCode = exitCode;
			scheduleOwnedSettle();
			return;
		}
		commitCompletion(exitCode);
	};
	let ownedCompletionPending = false;
	let ownedPendingExitCode = 0;
	let ownedSettleScheduled = false;
	let ownedSettleStopped = false;
	let ownedBridgeEndedAt: number | undefined;
	const markOwnedBridgeEnded = () => { ownedBridgeEndedAt ??= Date.now(); };
	const finishOwnedCompletion = (exitCode: number) => {
		ownedSettleStopped = true;
		ownedCompletionPending = false;
		forgetOwnedHandle(agentDir);
		commitCompletion(exitCode);
	};
	const settleOwnedCompletion = async () => {
		if (ownedSettleStopped || completionNotified) return;
		// The agent directory (or its ownership pointer) can disappear through
		// cleanup or external action; never settle a stale run.
		if (!fs.existsSync(agentDir) || !fs.existsSync(path.join(agentDir, OWNED_METADATA))) {
			finishOwnedCompletion(ownedPendingExitCode);
			return;
		}
		const outcome = ownedOutcomeSync(agentDir);
		if (outcome.kind === "drained-ok" || outcome.kind === "drained-fail" || outcome.kind === "launch-failed" ||
			outcome.kind === "never-launched") {
			// Kernel drainage proves the receipt, but the attempt may only
			// FINISH at the safe retirement/reuse boundary: the supervisor
			// historically wrote receipts before booting out its jobs, and a
			// completion that fires early lets retry/fallback relaunch the same
			// agent directory straight into the reuse guard ("not verified
			// drained and retired"), terminating the whole retry chain
			// spuriously. The bounded verifier caches the durable retirement
			// marker once the exact UUID labels are confirmed absent; until
			// then keep this attempt open and keep polling off the hot path.
			if (await verifyOwnedRetirementAsync(agentDir, { overallDeadlineMs: OWNED_SETTLE_RETIREMENT_BUDGET_MS }).catch(() => false)) {
				finishOwnedCompletion(ownedPendingExitCode);
				return;
			}
		} else if (outcome.kind === "unproven-fail") {
			// The receipt claims terminal failure without kernel proof: settle
			// only once the exact launchd targets are confirmed absent.
			if (await verifyOwnedRetirementAsync(agentDir, { overallDeadlineMs: OWNED_SETTLE_RETIREMENT_BUDGET_MS })) {
				writeOwnedBootstrapFailureResult(agentDir);
				try {
					if (resultUnset()) setResult(fs.readFileSync(path.join(agentDir, "result.md"), "utf-8").trim(), true);
				} catch {
					/* bootstrap failure text absent */
				}
				finishOwnedCompletion(ownedPendingExitCode);
				return;
			}
		} else if (ownedBridgeEndedAt !== undefined && Date.now() - ownedBridgeEndedAt >= OWNED_BRIDGE_END_GRACE_MS) {
			// Our own bridge ended (exit/close, or a spawn-level error) without
			// any verdict; even a still-live bridge that has not claimed simply
			// loses the fence below. If it never took the exclusive launch claim, it never
			// bound or bootstrapped anything; fencing the run makes that a
			// durable never-launched outcome that the next settle iteration
			// retires. A bridge-claimed run stays pending until its receipt.
			const meta = readOwnedMetadata(agentDir);
			if (meta && ownedLaunchClaimProtocolSync(meta.runDir) && readOwnedLaunchClaimSync(meta.runDir) === "none")
				await fenceOwnedLaunchRunAsync(meta.runDir);
		}
		scheduleOwnedSettle();
	};
	const scheduleOwnedSettle = () => {
		if (ownedSettleScheduled || ownedSettleStopped || completionNotified) return;
		ownedSettleScheduled = true;
		const timer = setTimeout(() => {
			ownedSettleScheduled = false;
			// The settle loop is fire-and-forget: a transient error must never
			// surface as an unhandled rejection nor abandon receipt recovery.
			settleOwnedCompletion().catch(() => scheduleOwnedSettle());
		}, OWNED_SETTLE_INTERVAL_MS);
		timer.unref?.();
	};
	const commitCompletion = (exitCode: number) => {
		if (completionNotified) return;
		if (exitCode !== 0) shouldKeepStderr = true;
		releaseLiveChannel();
		completionNotified = true;
		if (timeoutTimer) clearTimeout(timeoutTimer);
		if (agentSettledKillTimer) clearTimeout(agentSettledKillTimer);
		if (exitFinalizationTimer) clearTimeout(exitFinalizationTimer);
		const stopped = stopRequested();
		const fallbackState: AgentState = stopped
			? { id: task.id, status: "stopped" }
			: { id: task.id, status: exitCode === 0 ? "done" : "failed", exitCode };
		if (!getRecord(runDir, task.id)) {
			// The record was removed (cleanup) while the process ran.
			onComplete?.({ runDir, agentId: task.id, agentDir, exitCode, state: fallbackState });
			return;
		}
		const finishedAt = isoNow();
		if (ownedHandle && fs.existsSync(agentDir)) {
			// Owned recovery reads its exit record from the owned base.
			fs.writeFileSync(path.join(agentDir, "exit_code"), stopped ? "stopped" : String(exitCode), "utf-8");
			fs.writeFileSync(path.join(agentDir, "finished_at"), finishedAt, "utf-8");
		}
		updateLive(runDir, task.id, { active: false, process: undefined });
		updateRecord(runDir, task.id, stopped
			? { status: "stopped", exitCode: null, finishedAt }
			: { status: exitCode === 0 ? "done" : "failed", exitCode, finishedAt });
		const state = getAgentState(runDir, task.id) ?? fallbackState;
		try {
			settleStructuredResult(runDir, task.id, { state, subagentType: task.subagentType, model: task.model, maxResultBytes: options.maxResultBytes });
		} catch {
			/* non-critical: do not block completion */
		}
		onComplete?.({ runDir, agentId: task.id, agentDir, exitCode, state });
	};

	const finalizeCompletion = (code: number | null, signal: NodeJS.Signals | null) => {
		if (completionNotified) return;
		if (!ownedHandle && !timeoutKillTimer && !agentSettledCompletionFallbackTimer) scheduleProcessTreeKill("process_exit");
		let exitCode = resolveAgentExitCode({
			timedOut,
			completedFromAgentEnd,
			lastAgentEndError,
			code,
			signal,
		});
		if (ownedHandle) {
			// A successful RPC event does not override the payload's actual exit
			// status relayed by the native bridge. Cancellation after agent_settled
			// is intentional after RPC completion; preserve an RPC error as failure.
			if (timedOut) exitCode = AGENT_TIMEOUT_EXIT_CODE;
			else if (code === 143 && agentSettledRequested && (completedFromAgentEnd || lastAgentEndError) &&
				!stopRequested()) exitCode = lastAgentEndError ? 1 : 0;
			else if (code !== 0) exitCode = code ?? 1;
			else if (!completedFromAgentEnd || lastAgentEndError) exitCode = 1;
		}
		if (resultUnset()) {
			if (exitCode === 0 && lastAssistantResult.trim()) setResult(lastAssistantResult.trim(), false);
			else if (exitCode !== 0 && lastAgentEndError) setResult(lastAgentEndError, true);
		}
		// A clean run keeps no stderr; failures/debug keep the bounded tail.
		if (!shouldKeepStderr && exitCode === 0 && !logLimits.debugLogs) updateLive(runDir, task.id, { stderrTail: undefined });
		notifyComplete(exitCode);
	};

	const scheduleAgentSettledTermination = () => {
		if (agentSettledKillTimer) return;
		agentSettledRequested = true;
		channelClosing = true;
		if (ownedHandle) {
			agentSettledKillTimer = setTimeout(() => {
				try { requestOwnedCancel(agentDir); } catch (error) { appendStderr(`owned cancel pending: ${String(error)}\n`); }
			}, AGENT_SETTLED_TERMINATE_GRACE_MS);
			agentSettledKillTimer.unref?.();
			return;
		}
		agentSettledKillTimer = setTimeout(() => {
			agentSettledKillTimer = undefined;
			try {
				terminateChildProcessTree(proc, "SIGTERM");
			} catch {
				/* process may have exited before the graceful termination timer fired */
			}
		}, AGENT_SETTLED_TERMINATE_GRACE_MS);
		agentSettledKillTimer.unref?.();
		agentSettledCompletionFallbackTimer = setTimeout(() => {
			try {
				terminateChildProcessTree(proc, "SIGKILL");
			} catch {
				/* process may already be gone */
			}
			if (completionNotified) return;
			proc.stdin.destroy();
			proc.stdout?.destroy();
			proc.stderr?.destroy();
			proc.unref();
			finalizeCompletion(0, null);
		}, AGENT_SETTLED_COMPLETION_FALLBACK_MS);
		agentSettledCompletionFallbackTimer.unref?.();
	};

	if (timeoutMs > 0) {
		timeoutTimer = setTimeout(() => {
			if (completionNotified) return;
			timedOut = true;
			const timeoutMessage = `Sub-agent timed out after ${Math.round(timeoutMs / 1000)} seconds.`;
			if (ownedHandle && fs.existsSync(agentDir)) {
				// Owned recovery derives exit 124 from these markers.
				fs.writeFileSync(path.join(agentDir, "timeout_ms"), String(timeoutMs), "utf-8");
				fs.writeFileSync(path.join(agentDir, "timed_out_at"), isoNow(), "utf-8");
			}
			updateRecord(runDir, task.id, { timedOut: true });
			if (resultUnset()) setResult(timeoutMessage, true);
			appendStderr(`${timeoutMessage}\n`);
			try {
				if (ownedHandle) requestOwnedCancel(agentDir);
				else terminateChildProcessTree(proc, "SIGTERM");
			} catch {
				/* process may have exited between the timer and signal */
			}
			if (!ownedHandle) {
				timeoutKillTimer = setTimeout(() => {
				try {
					terminateChildProcessTree(proc, "SIGKILL");
				} catch {
					/* process may have exited after SIGTERM */
				}
				}, AGENT_TIMEOUT_KILL_GRACE_MS);
				timeoutKillTimer.unref?.();
			}
		}, timeoutMs);
		timeoutTimer.unref?.();
	}

	proc.stderr.on("data", (chunk) => appendStderr(String(chunk)));
	attachJsonlLineReader(proc.stdout, (line) => {
		const suppressedEventType = onRpcEvent ? undefined : suppressedRpcEventType(line);
		if (suppressedEventType) {
			return;
		}
		try {
			const event = JSON.parse(line) as RpcEventRecord;
			const todoProgress = todoProgressFromRpcEvent(event);
			if (todoProgress) updateLive(runDir, task.id, { todoProgress });
			onRpcEvent?.(event);
			const sessionFile = extractSessionFileFromEvent(event);
			if (sessionFile && getRecord(runDir, task.id)?.childSessionFile !== sessionFile) updateRecord(runDir, task.id, { childSessionFile: sessionFile });
			const assistantResult = extractAssistantResultFromEvent(event);
			if (assistantResult.trim()) lastAssistantResult = assistantResult;
			const messageEndError = extractMessageEndErrorMessage(event);
			if (messageEndError) lastAgentEndError = messageEndError;
			const responseId = event.type === "response" && typeof event.id === "string" ? event.id : undefined;
			if (responseId?.startsWith(LIVE_SEND_ID_PREFIX)) {
				const pending = pendingLiveSends.get(responseId);
				if (pending) {
					pendingLiveSends.delete(responseId);
					clearTimeout(pending.timer);
					if (event.success === false) pending.reject(new Error(typeof event.error === "string" ? event.error : "sub-agent rejected the message"));
					else pending.resolve({ disposition: isRecord(event.data) && typeof event.data.disposition === "string" ? event.data.disposition : "queued" });
				}
				requestSettleCheck();
				return;
			}
			if (responseId?.startsWith(SETTLE_CHECK_ID_PREFIX)) {
				handleSettleCheckResponse(event);
				return;
			}
			if (event.type === "response" && event.command === "prompt" && (responseId === INITIAL_PROMPT_ID || responseId === undefined) && event.success !== false) {
				resolveInitialPromptAccepted();
			}
			if (event.type === "agent_start") {
				runGeneration += 1;
				settledAwaitingCheck = false;
				if (runGeneration > 1) {
					// A live send started another run in this process: drop the previous run's outcome.
					completedFromAgentEnd = false;
					lastAgentEndError = "";
					lastAssistantResult = "";
					updateLive(runDir, task.id, { resultText: undefined });
					if (getRecord(runDir, task.id)?.message !== undefined) updateRecord(runDir, task.id, { message: null });
				}
			}
			if (event.type === "response" && event.command === "prompt" && event.success === false) {
				const errorText = typeof event.error === "string" ? event.error : "RPC prompt failed";
				setResult(errorText, true);
				try {
					if (ownedHandle) requestOwnedCancel(agentDir);
					else terminateChildProcessTree(proc, "SIGTERM");
				} catch {
					/* process may have exited immediately after emitting the failure */
				}
				if (!ownedHandle) scheduleProcessTreeKill("prompt_failed");
				notifyComplete(1);
				return;
			}
			if (event.type === "agent_end") {
				const errorMessage = extractAgentEndErrorMessage(event);
				if (errorMessage) {
					lastAgentEndError = errorMessage;
					return;
				}
				completedFromAgentEnd = true;
				const result = extractAgentEndResult(event);
				if (result.trim()) setResult(result, false);
			}
			if (event.type === "agent_settled") {
				if (pendingLiveSends.size > 0 || liveSendSinceRunStart) {
					// A live send may have started (or queued) another run: confirm idleness first.
					settledAwaitingCheck = true;
					requestSettleCheck();
				} else {
					scheduleAgentSettledTermination();
				}
			}
		} catch (error) {
			appendStderr(`Invalid RPC JSON line: ${String(error)}\n${previewLine(line)}\n`);
		}
	}, {
		maxLineChars: logLimits.rpcEventLineMaxChars,
		onLineTooLongStart: (linePrefix) => {
			const suppressedEventType = onRpcEvent ? undefined : suppressedRpcEventType(linePrefix);
			if (suppressedEventType) {
				return true;
			}
			if (!onRpcEvent && isAgentEndLine(linePrefix)) {
				if (lastAgentEndError) {
					setResult(lastAgentEndError, true);
				} else if (lastAssistantResult.trim()) {
					completedFromAgentEnd = true;
					setResult(lastAssistantResult.trim(), false);
				} else {
					lastAgentEndError = "Sub-agent produced an oversized agent_end RPC event before a final result could be captured.";
					setResult(lastAgentEndError, true);
				}
				return true;
			}
			return false;
		},
		onLineTooLong: (lineChars) => {
			const message = `RPC JSON line exceeded ${logLimits.rpcEventLineMaxChars} chars; dropped oversized event (${lineChars} chars).`;
			appendStderr(`${message}\n`);
		},
	});

	// Bun on Windows may emit the ChildProcess `close` event before the stdout
	// Readable has delivered its final buffered `data`/`end` events. Gate process
	// finalization on stdout itself so a trailing RPC failure cannot be mistaken
	// for a clean exit.
	const finalizeAfterStdout = () => {
		if (!processTermination || !stdoutEnded || completionNotified || exitFinalizationTimer) return;
		const { code, signal } = processTermination;
		exitFinalizationTimer = setTimeout(
			() => finalizeCompletion(code, signal),
			EXIT_STDIO_FLUSH_GRACE_MS,
		);
		exitFinalizationTimer.unref?.();
	};
	const recordProcessTermination = (code: number | null, signal: NodeJS.Signals | null) => {
		if (ownedHandle) markOwnedBridgeEnded();
		processTermination ??= { code, signal };
		finalizeAfterStdout();
	};
	proc.stdout.once("end", () => {
		stdoutEnded = true;
		finalizeAfterStdout();
	});
	proc.once("exit", recordProcessTermination);
	proc.once("close", recordProcessTermination);

	proc.once("error", (error) => {
		if (ownedHandle) markOwnedBridgeEnded();
		const message = String(error);
		appendStderr(`${message}\n`);
		shouldKeepStderr = true;
		if (resultUnset()) setResult(message, true);
		if (ownedHandle) {
			try { requestOwnedCancel(agentDir); } catch { /* supervisor may still be starting; receipt remains required */ }
		}
		notifyComplete(1);
	});

	const pid = proc.pid!;
	updateRecord(runDir, task.id, {
		pid,
		...(!ownedHandle && process.platform !== "win32" ? { processGroup: true } : {}),
		...(ownedHandle ? { owned: true } : {}),
	});
	updateLive(runDir, task.id, { process: proc });
	if (!channelReleased) registerLiveChannel(liveChannel);

	proc.stdin.write([
		serializeJsonLine({
			id: "sub_get_state",
			type: "get_state",
		}),
		serializeJsonLine({
			id: INITIAL_PROMPT_ID,
			type: "prompt",
			message: promptContent,
			...(promptImages ? { images: promptImages } : {}),
		}),
	].join(""));
	// Keep stdin open while the RPC prompt is running. pi RPC mode treats stdin
	// EOF as a shutdown request, while the prompt command itself is handled
	// asynchronously after preflight. Closing stdin here can therefore terminate
	// the child before message_end/agent_end/agent_settled events are emitted,
	// producing exit 0 with no result. The child is terminated explicitly after agent_settled,
	// timeout, stop, or process error.

	return { pid, agentDir, process: proc };
}

function withoutSkillArgs(args: string[]): string[] {
	const filtered: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--skill") {
			index += 1;
			continue;
		}
		if (arg === "--no-skills" || arg.startsWith("--skill=")) continue;
		filtered.push(arg);
	}
	return filtered;
}



function getModelToolsExtensionPath(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "model-tools", "index.ts");
}

function getSubagentTodoExtensionPath(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "todo", "subagent.ts");
}

function getSubagentRepoExtensionPath(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "repo-discovery", "subagent.ts");
}

function getSubagentDcpExtensionPath(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dcp", "subagent.ts");
}

function terminateChildProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
	if (proc.pid) {
		terminateProcessTree(proc.pid, signal as "SIGTERM" | "SIGINT" | "SIGKILL");
		return;
	}
	proc.kill(signal);
}

function getSubagentToolGuardExtensionPath(): string {
	return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "tool-guard.ts");
}

function resolveAgentExitCode(options: {
	timedOut: boolean;
	completedFromAgentEnd: boolean;
	lastAgentEndError: string;
	code: number | null;
	signal: NodeJS.Signals | null;
}): number {
	if (options.timedOut) return AGENT_TIMEOUT_EXIT_CODE;
	if (options.completedFromAgentEnd) return 0;
	if (options.lastAgentEndError) return 1;
	if (typeof options.code === "number") return options.code;
	if (options.signal) return 128;
	return 1;
}

function readPromptImages(imagePaths: string[], cwd: string): Array<{ type: "image"; data: string; mimeType: string }> {
	return imagePaths.map((imagePath) => {
		const resolved = resolveImagePath(imagePath, cwd);
		const mimeType = imageMimeType(resolved);
		if (!mimeType) throw new Error(`Unsupported image type for sub-agent attachment: ${imagePath}`);
		return {
			type: "image" as const,
			data: fs.readFileSync(resolved).toString("base64"),
			mimeType,
		};
	});
}

function resolveImagePath(imagePath: string, cwd: string): string {
	const normalized = imagePath.startsWith("@") ? imagePath.slice(1) : imagePath;
	return path.resolve(cwd, normalized);
}

function imageMimeType(filePath: string): string | undefined {
	switch (path.extname(filePath).toLowerCase()) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".gif":
			return "image/gif";
		case ".webp":
			return "image/webp";
		default:
			return undefined;
	}
}

function extractSessionFileFromEvent(event: RpcEventRecord): string | undefined {
	if (event.type !== "response" || event.command !== "get_state" || event.success !== true)
		return undefined;
	if (!isRecord(event.data)) return undefined;
	const sessionFile = event.data.sessionFile;
	return typeof sessionFile === "string" && sessionFile.trim() ? sessionFile : undefined;
}

function attachJsonlLineReader(
	stream: NodeJS.ReadableStream,
	onLine: (line: string) => void,
	options: {
		maxLineChars?: number;
		onLineTooLongStart?: (linePrefix: string) => boolean;
		onLineTooLong?: (lineChars: number) => void;
	} = {},
): void {
	let buffer = "";
	let droppingOversizedLine: false | "handled" | "report" = false;
	let droppedChars = 0;
	const maxLineChars = options.maxLineChars && options.maxLineChars > 0 ? options.maxLineChars : undefined;

	stream.on("data", (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				if (maxLineChars !== undefined && buffer.length > maxLineChars) {
					droppingOversizedLine = options.onLineTooLongStart?.(buffer) ? "handled" : "report";
					droppedChars += buffer.length;
					buffer = "";
				}
				return;
			}

			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
			if (droppingOversizedLine) {
				droppedChars += normalized.length;
				if (droppingOversizedLine === "report") options.onLineTooLong?.(droppedChars);
				droppingOversizedLine = false;
				droppedChars = 0;
				continue;
			}
			if (maxLineChars !== undefined && normalized.length > maxLineChars) {
				if (!options.onLineTooLongStart?.(normalized)) options.onLineTooLong?.(normalized.length);
				continue;
			}
			onLine(normalized);
		}
	});

	stream.on("end", () => {
		if (droppingOversizedLine) {
			droppedChars += buffer.length;
			if (droppingOversizedLine === "report") options.onLineTooLong?.(droppedChars);
			buffer = "";
			droppingOversizedLine = false;
			droppedChars = 0;
			return;
		}
		if (buffer.length > 0) {
			const normalized = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
			if (maxLineChars !== undefined && normalized.length > maxLineChars) {
				if (!options.onLineTooLongStart?.(normalized)) options.onLineTooLong?.(normalized.length);
			} else {
				onLine(normalized);
			}
			buffer = "";
		}
	});
}

function suppressedRpcEventType(line: string): string | undefined {
	if (line.includes('"type":"message_update"') || line.includes('"type": "message_update"')) return "message_update";
	if (line.includes('"type":"tool_execution_update"') || line.includes('"type": "tool_execution_update"')) return "tool_execution_update";
	return undefined;
}

function isAgentEndLine(line: string): boolean {
	return line.includes('"type":"agent_end"') || line.includes('"type": "agent_end"');
}

function previewLine(text: string, maxChars = 4096): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}… [truncated ${text.length - maxChars} chars]`;
}


function extractAgentEndErrorMessage(event: RpcEventRecord): string {
	const messages = Array.isArray(event.messages) ? event.messages : [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		const errorMessage = extractAssistantErrorMessage(message);
		if (errorMessage) return errorMessage;
		if (isRecord(message) && message.role === "assistant") return "";
	}
	return "";
}

function extractMessageEndErrorMessage(event: RpcEventRecord): string {
	if (event.type !== "message_end") return "";
	return extractAssistantErrorMessage(event.message);
}

function extractAssistantErrorMessage(message: unknown): string {
	if (!isRecord(message) || message.role !== "assistant" || message.stopReason !== "error") return "";
	return typeof message.errorMessage === "string" && message.errorMessage.trim()
		? message.errorMessage.trim()
		: "Sub-agent ended with an error.";
}

function extractAgentEndResult(event: RpcEventRecord): string {
	const messages = Array.isArray(event.messages) ? event.messages : [];
	const parts: string[] = [];

	for (const message of messages) {
		const text = extractAssistantMessageText(message);
		if (text) parts.push(text);
	}

	return parts.join("\n\n").trim();
}

function extractAssistantResultFromEvent(event: RpcEventRecord): string {
	const parts: string[] = [];
	if (isRecord(event.message)) {
		const text = extractAssistantMessageText(event.message);
		if (text) parts.push(text);
	}
	if (isRecord(event.assistantMessageEvent)) {
		const partial = event.assistantMessageEvent.partial;
		if (isRecord(partial)) {
			const text = extractAssistantMessageText(partial);
			if (text) parts.push(text);
		}
	}
	return parts.join("\n\n").trim();
}

function extractAssistantMessageText(message: unknown): string {
	if (!isRecord(message)) return "";
	if (message.role !== "assistant") return "";
	const content = message.content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (!isRecord(item)) continue;
		if (item.type === "text" && typeof item.text === "string")
			parts.push(item.text);
	}
	return parts.join("\n\n").trim();
}

function subagentEnvironment(env: NodeJS.ProcessEnv, agentDir?: string): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = {
		...env,
		PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION: "1",
		PI_TERMINAL_BELL_DISABLED: "1",
		[RPC_SESSION_STATE_ENV]: "1",
		PI_TOOLS_SUITE_DISABLED_MODULES: appendEnvList(env.PI_TOOLS_SUITE_DISABLED_MODULES, [
			"async-subagents",
			"coding-discipline",
			"question",
		]),
	};
	delete result[SUBAGENT_AGENT_DIR_ENV];
	delete result[BROWSER_QA_RUNNER_ENV];
	delete result[UI_QA_RUNNER_ENV];
	if (agentDir) {
		result[SUBAGENT_AGENT_DIR_ENV] = fs.realpathSync(agentDir);
		result[BROWSER_QA_RUNNER_ENV] = getBrowserQaRunnerPath();
		result[UI_QA_RUNNER_ENV] = getUiQaRunnerPath();
	}
	return result;
}

/**
 * UI/browser QA workspace `.pi/artifacts/subagents/<batch>-<agentId>/` (the
 * runner's PI_SUBAGENT_AGENT_DIR); created only for ui-qa types.
 */
function prepareUiQaWorkspace(cwd: string, runDir: string, agentId: string): string {
	const batch = parseRunKey(runDir)?.batch ?? path.basename(runDir);
	const root = path.join(cwd, PROJECT_ARTIFACTS_DIR, "subagents", `${batch}-${agentId}`);
	const workspace = path.join(root, UI_QA_WORKSPACE_DIR);
	fs.rmSync(workspace, { recursive: true, force: true });
	const uiFlows = path.join(workspace, "flows");
	const browserWorkspace = path.join(workspace, UI_QA_BROWSER_WORKSPACE_DIR);
	const browserFlows = path.join(browserWorkspace, "flows");
	for (const dir of [workspace, uiFlows, browserWorkspace, browserFlows]) {
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
	}
	// Workspace identity markers checked by the ui-qa/browser runners (not run state).
	fs.writeFileSync(path.join(root, "project_cwd"), `${cwd}\n`, "utf-8");
	fs.writeFileSync(path.join(root, "subagent_type"), "ui-qa\n", "utf-8");
	return root;
}

function appendEnvList(value: string | undefined, items: readonly string[]): string {
	const existing = value?.trim();
	return existing ? `${existing},${items.join(",")}` : items.join(",");
}

