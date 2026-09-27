import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { selectSuitableToolsForModel } from "../../lib/tool-args.js";
import { BROWSER_QA_RUNNER_ENV, getBrowserQaRunnerPath, getUiQaRunnerPath, isUiQaType, UI_QA_RUNNER_ENV } from "./ui-qa.js";
import { validateBasename } from "./paths.js";
import { getPiInvocation } from "./pi-invocation.js";
import { writePromptFile } from "./prompt.js";
import { terminateProcessTree } from "./process.js";
import { getAgentSessionDir, SUBAGENT_PARENT_SESSION_FILE, SUBAGENT_RETURN_SESSION_FILE, SUBAGENT_SESSION_FILE, writeParentSessionLink, writeSessionFileLink } from "./sessions.js";
import { getAgentState } from "./state.js";
import { writeStructuredResult } from "./structured-result.js";
import { createBoundedFileWriter, createDeferredFileWriter, resolveSubagentLogLimits } from "./log-limits.js";
import { filterSubagentTools } from "./tool-guard.js";
import type { AgentCompletionHandler, AgentTask, RpcEventHandler, RpcEventRecord, SpawnedAgent } from "./types.js";
import { isRecord, isoNow, serializeJsonLine } from "./utils.js";
import { forgetOwnedHandle, launchPreparedOwnedAgent, ownedOutcomeSync, readOwnedMetadata, requestOwnedCancel, OWNED_METADATA, type OwnedLaunchBinaries, type OwnedLaunchHandle } from "./owned-launch-integration.js";
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

export interface SpawnAgentOptions {
	parentSession?: string;
	timeoutMs?: number;
	maxResultBytes?: number;
	ownedBinaries?: OwnedLaunchBinaries;
	/** Test seam for Pi's installed-package lookup (provider dependency resolution). */
	locateProviderPackagesForTest?: InstalledPackageLocator;
	/** Unit-test-only native boundary; production tool never supplies this. */
	ownedLaunchForTest?: (request: { agentDir: string; command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; binaries: OwnedLaunchBinaries }) => OwnedLaunchHandle;
}

export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;
const BROWSER_QA_WORKSPACE_DIR = "browser-qa";
const UI_QA_WORKSPACE_DIR = "ui-qa";
const SUBAGENT_AGENT_DIR_ENV = "PI_SUBAGENT_AGENT_DIR";
const AGENT_TIMEOUT_EXIT_CODE = 124;
const AGENT_TIMEOUT_KILL_GRACE_MS = 5_000;
const AGENT_SETTLED_TERMINATE_GRACE_MS = 50;
const AGENT_SETTLED_COMPLETION_FALLBACK_MS = 1_000;
const EXIT_STDIO_FLUSH_GRACE_MS = 10;
const PROGRESS_LOG_MAX_BYTES = 1024 * 1024;
/** Background drain-settlement poll interval; bounded so the loop stays off the hot path. */
const OWNED_SETTLE_INTERVAL_MS = 1_000;
/** Grace after the bridge ended before a never-released run may be probed for absent jobs. */
const OWNED_BRIDGE_END_GRACE_MS = 2_000;
/** Bounded launchctl budget while settling a completion (retirement marker caching). */
const OWNED_SETTLE_RETIREMENT_BUDGET_MS = 10_000;

export function shouldPersistSubagentSessions(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnv(env.ASYNC_SUBAGENTS_ENABLE_SESSIONS);
}

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
	const agentDir = path.join(runDir, task.id);
	fs.mkdirSync(agentDir, { recursive: true });
	// Sub-agent roles are self-contained. Never inherit/discover skills, and do
	// not allow profile/user extra args to re-enable or inject them. Model and
	// provider override spellings the child CLI rejects are normalized first,
	// so ownership, provider dependencies, and the child agree on one model.
	const forwardedExtraArgs = normalizeProviderArgs(withoutSkillArgs(extraArgs));
	const configuredModel = task.model?.trim() || subagentEnvModel();
	const selectedModel = resolveFinalModel(configuredModel, forwardedExtraArgs);
	const explicitModel = resolveFinalModel(task.model, forwardedExtraArgs);
	const owned = selectsClaudeProvider(selectedModel, forwardedExtraArgs);
	// This check MUST precede reuse cleanup and any child spawn, including direct
	// spawnAgent calls that bypass the asynchronous tool preflight.
	if (owned && (process.platform !== "darwin" || !options.ownedBinaries))
		throw new Error("pi-claude-code-provider requires prepared macOS owned-launch binaries");
	// Extension-backed providers are resolved before any artifact changes or
	// child exists; a ProviderExtensionError is permanent (a synchronous throw
	// is never retried and never falls back).
	const providerExtensions = resolveProviderExtensions({
		selectedModel, explicitModel, claudeSelected: owned, forwardedArgs: forwardedExtraArgs, cwd,
		locateInstalled: options.locateProviderPackagesForTest,
	});
	// Kernel drain and launchd retirement are distinct facts: reuse is refused
	// until every owned-launch UUID directory (including any left from older
	// generations, even without a readable pointer) is both terminal and retired.
	if (ownedArtifactsPresentSync(agentDir) && !ownedDeletableSync(agentDir))
		throw new Error("previous owned sub-agent is not verified drained and retired; refusing reuse");
	prepareUiQaWorkspace(agentDir, task.subagentType);

	// Clean previous state when reusing a run directory/agent id.
	for (const f of [
		"exit_code",
		"finished_at",
		"result.md",
		"result.json",
		"events.jsonl",
		"stderr.log",
		"session_dir",
		"image_paths",
		SUBAGENT_SESSION_FILE,
		SUBAGENT_PARENT_SESSION_FILE,
		SUBAGENT_RETURN_SESSION_FILE,
		"timeout_ms",
		"timed_out_at",
		"stop_requested",
		"stop_signal",
		"retry_pending",
		"next_retry_at",
		"process_group",
		OWNED_METADATA,
	]) {
		try {
			fs.unlinkSync(path.join(agentDir, f));
		} catch {
			/* ignore */
		}
	}
	fs.rmSync(getAgentSessionDir(agentDir), { recursive: true, force: true });

	// Write prompt file (also to prompts/ dir for planned status)
	const promptPath = writePromptFile(runDir, task);
	fs.copyFileSync(promptPath, path.join(agentDir, "prompt.md"));

	// Build pi args. By default sub-agents use the parent/default model.
	// E2E/live deployments can pin the real model explicitly through env so
	// detached subprocesses do not depend on persisted local pi settings.
	const persistSessions = shouldPersistSubagentSessions();
	const sessionDir = persistSessions ? getAgentSessionDir(agentDir) : undefined;
	if (sessionDir) fs.mkdirSync(sessionDir, { recursive: true });
	const piArgs: string[] = ["--mode", "rpc"];
	if (sessionDir) piArgs.push("--session-dir", sessionDir);
	else piArgs.push("--no-session");
	piArgs.push("--no-extensions");
	piArgs.push("--extension", getModelToolsExtensionPath());
	// `--no-extensions` stays; only the allowlisted provider dependencies of
	// the final selected model are added (see provider-extensions.ts).
	for (const extension of providerExtensions) piArgs.push("--extension", extension);
	piArgs.push("--no-skills");
	if (configuredModel) piArgs.push("--model", configuredModel);
	const selectedTools = task.tools ? filterSubagentTools(selectSuitableToolsForModel(selectedModel, task.tools)) : undefined;
	if (selectedTools) {
		if (selectedTools.length > 0) piArgs.push("--tools", selectedTools.join(","));
		else piArgs.push("--no-tools");
	}
	if (task.thinking) piArgs.push("--thinking", task.thinking);

	// User-supplied extra args (e.g. --thinking high)
	piArgs.push(...forwardedExtraArgs);
	// The child always runs one explicitly selected model. Override persisted
	// enabledModels (and any extra --models value) so isolated children do not
	// resolve unrelated provider patterns before their limited extensions load.
	if (selectedModel) piArgs.push("--models", selectedModel);
	// Keep recursive/interactive parent-only tools disabled even if explicit
	// sub-agent extraArgs load additional extensions or override --tools.
	piArgs.push("--extension", getSubagentToolGuardExtensionPath());

	// Read prompt content for stdin
	const promptContent = fs.readFileSync(promptPath, "utf-8");
	const promptImages = task.imagePaths && task.imagePaths.length > 0 ? readPromptImages(task.imagePaths, cwd) : undefined;

	// Write metadata
	fs.writeFileSync(path.join(agentDir, "project_cwd"), cwd, "utf-8");
	fs.writeFileSync(path.join(agentDir, "pi_args"), piArgs.join("\n"), "utf-8");
	if (sessionDir) fs.writeFileSync(path.join(agentDir, "session_dir"), sessionDir, "utf-8");
	writeParentSessionLink(agentDir, options.parentSession);
	if (task.subagentType) fs.writeFileSync(path.join(agentDir, "subagent_type"), task.subagentType, "utf-8");
	if (task.model) fs.writeFileSync(path.join(agentDir, "model"), task.model, "utf-8");
	if (task.imagePaths && task.imagePaths.length > 0) fs.writeFileSync(path.join(agentDir, "image_paths"), task.imagePaths.join("\n"), "utf-8");
	fs.writeFileSync(path.join(agentDir, "started_at"), isoNow(), "utf-8");

	const transcriptFile = path.join(agentDir, "events.jsonl");
	const stderrFile = path.join(agentDir, "stderr.log");
	const logLimits = resolveSubagentLogLimits();

	const invocation = getPiInvocation(piArgs);
	const stderrStream = createDeferredFileWriter(stderrFile, logLimits.stderrMaxBytes, "stderr.log");
	const transcriptStream = createBoundedFileWriter(transcriptFile, logLimits.eventsMaxBytes, "events.jsonl");
	const progressStream = createBoundedFileWriter(path.join(agentDir, "progress.jsonl"), PROGRESS_LOG_MAX_BYTES, "progress.jsonl");
	const writeProgress = (stage: string, details: Record<string, unknown> = {}) => {
		progressStream.write(serializeJsonLine({ at: isoNow(), stage, ...details }));
	};

	const env = subagentEnvironment(process.env, isUiQaType(task.subagentType) ? agentDir : undefined);
	const ownedHandle = owned ? (options.ownedLaunchForTest ?? launchPreparedOwnedAgent)({ agentDir, command: invocation.command, args: invocation.args, cwd, env, binaries: options.ownedBinaries! }) : undefined;
	// The prepared bridge guarantees three piped stdio streams, just as spawn() does.
	const proc: ChildProcessWithoutNullStreams = (ownedHandle?.process as ChildProcessWithoutNullStreams | undefined) ?? spawn(invocation.command, invocation.args, {
		cwd,
		env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	proc.stdin.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code === "EPIPE") return;
		stderrStream.write(`${String(error)}\n`);
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
	const suppressedRpcEventCounts = new Map<string, number>();
	const scheduleProcessTreeKill = (reason: string) => {
		if (processExitTreeKillTimer) return;
		processExitTreeKillTimer = setTimeout(() => {
			try {
				writeProgress("shutdown_signal", { reason, signal: "SIGKILL" });
				terminateChildProcessTree(proc, "SIGKILL");
			} catch {
				/* process group may already be gone */
			}
		}, AGENT_SETTLED_COMPLETION_FALLBACK_MS);
		processExitTreeKillTimer.unref?.();
	};

	const notifyComplete = (exitCode: number) => {
		if (completionNotified) return;
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
	let ownedPendingReported = false;
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
		if (!ownedPendingReported) {
			// Report pending exactly once and keep the progress stream open for
			// the final completion record.
			ownedPendingReported = true;
			writeProgress("owned_drain_pending", { reason: outcome.kind });
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
		completionNotified = true;
		if (timeoutTimer) clearTimeout(timeoutTimer);
		if (agentSettledKillTimer) clearTimeout(agentSettledKillTimer);
		if (exitFinalizationTimer) clearTimeout(exitFinalizationTimer);
		writeProgress("completed", { exitCode });
		progressStream.end();
		if (!fs.existsSync(agentDir)) {
			onComplete?.({
				runDir,
				agentId: task.id,
				agentDir,
				exitCode,
				state: { id: task.id, status: exitCode === 0 ? "done" : "failed", exitCode },
			});
			return;
		}
		fs.writeFileSync(
			path.join(agentDir, "exit_code"),
			fs.existsSync(path.join(agentDir, "stop_requested")) ? "stopped" : String(exitCode),
			"utf-8",
		);
		fs.writeFileSync(path.join(agentDir, "finished_at"), isoNow(), "utf-8");
		const state = getAgentState(runDir, task.id) ?? {
			id: task.id,
			status: exitCode === 0 ? "done" : "failed",
			exitCode,
		};
		// Write structured result.json alongside result.md
		try {
			writeStructuredResult({
				agentDir,
				agentId: task.id,
				state,
				subagentType: task.subagentType,
				model: task.model,
				maxResultBytes: options.maxResultBytes,
			});
		} catch {
			/* non-critical: do not block completion */
		}
		onComplete?.({ runDir, agentId: task.id, agentDir, exitCode, state });
	};

	const finalizeCompletion = (code: number | null, signal: NodeJS.Signals | null) => {
		if (completionNotified) return;
		if (!ownedHandle && !timeoutKillTimer && !agentSettledCompletionFallbackTimer) scheduleProcessTreeKill("process_exit");
		writeSuppressedRpcEventSummary(transcriptStream, suppressedRpcEventCounts);
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
				!fs.existsSync(path.join(agentDir, "stop_requested"))) exitCode = lastAgentEndError ? 1 : 0;
			else if (code !== 0) exitCode = code ?? 1;
			else if (!completedFromAgentEnd || lastAgentEndError) exitCode = 1;
		}
		if (fs.existsSync(agentDir)) {
			if (exitCode === 0 && !fs.existsSync(path.join(agentDir, "result.md")) && lastAssistantResult.trim()) {
				fs.writeFileSync(path.join(agentDir, "result.md"), lastAssistantResult.trim(), "utf-8");
			} else if (exitCode !== 0 && !fs.existsSync(path.join(agentDir, "result.md")) && lastAgentEndError) {
				fs.writeFileSync(path.join(agentDir, "result.md"), lastAgentEndError, "utf-8");
			}
		}
		if (shouldKeepStderr || exitCode !== 0 || logLimits.debugLogs) stderrStream.flush();
		else stderrStream.discard();
		transcriptStream.end();
		notifyComplete(exitCode);
	};

	const scheduleAgentSettledTermination = () => {
		if (agentSettledKillTimer) return;
		agentSettledRequested = true;
		if (ownedHandle) {
			agentSettledKillTimer = setTimeout(() => {
				try { requestOwnedCancel(agentDir); } catch (error) { writeProgress("owned_cancel_pending", { error: String(error) }); }
			}, AGENT_SETTLED_TERMINATE_GRACE_MS);
			agentSettledKillTimer.unref?.();
			return;
		}
		agentSettledKillTimer = setTimeout(() => {
			agentSettledKillTimer = undefined;
			try {
				writeProgress("shutdown_signal", { reason: "agent_settled", signal: "SIGTERM" });
				terminateChildProcessTree(proc, "SIGTERM");
			} catch {
				/* process may have exited before the graceful termination timer fired */
			}
		}, AGENT_SETTLED_TERMINATE_GRACE_MS);
		agentSettledKillTimer.unref?.();
		agentSettledCompletionFallbackTimer = setTimeout(() => {
			try {
				writeProgress("shutdown_signal", { reason: "agent_settled", signal: "SIGKILL" });
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

	const timeoutMs = options.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
	if (timeoutMs > 0) {
		timeoutTimer = setTimeout(() => {
			if (completionNotified) return;
			timedOut = true;
			const timeoutMessage = `Sub-agent timed out after ${Math.round(timeoutMs / 1000)} seconds.`;
			writeProgress("timeout", { timeoutMs });
			if (fs.existsSync(agentDir)) {
				fs.writeFileSync(path.join(agentDir, "timeout_ms"), String(timeoutMs), "utf-8");
				fs.writeFileSync(path.join(agentDir, "timed_out_at"), isoNow(), "utf-8");
				if (!fs.existsSync(path.join(agentDir, "result.md")))
					fs.writeFileSync(path.join(agentDir, "result.md"), timeoutMessage, "utf-8");
				stderrStream.write(`${timeoutMessage}\n`);
			}
			try {
				writeProgress("shutdown_signal", { reason: "timeout", signal: "SIGTERM" });
				if (ownedHandle) requestOwnedCancel(agentDir);
				else terminateChildProcessTree(proc, "SIGTERM");
			} catch {
				/* process may have exited between the timer and signal */
			}
			if (!ownedHandle) {
				timeoutKillTimer = setTimeout(() => {
				try {
					writeProgress("shutdown_signal", { reason: "timeout", signal: "SIGKILL" });
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

	proc.stderr.on("data", (chunk) => stderrStream.write(chunk));
	attachJsonlLineReader(proc.stdout, (line) => {
		const suppressedEventType = onRpcEvent ? undefined : suppressedRpcEventType(line);
		if (suppressedEventType) {
			suppressedRpcEventCounts.set(suppressedEventType, (suppressedRpcEventCounts.get(suppressedEventType) ?? 0) + 1);
			return;
		}
		try {
			const event = JSON.parse(line) as RpcEventRecord;
			const storedEvent = compactRpcEventForTranscript(event, Buffer.byteLength(line, "utf8"));
			if (storedEvent) transcriptStream.write(serializeJsonLine(storedEvent));
			const progressEvent = compactRpcEventForProgress(event);
			if (progressEvent) writeProgress("rpc_event", progressEvent);
			onRpcEvent?.(event);
			const sessionFile = extractSessionFileFromEvent(event);
			if (sessionFile) writeSessionFileLink(agentDir, sessionFile);
			const assistantResult = extractAssistantResultFromEvent(event);
			if (assistantResult.trim()) lastAssistantResult = assistantResult;
			const messageEndError = extractMessageEndErrorMessage(event);
			if (messageEndError) lastAgentEndError = messageEndError;
			if (event.type === "response" && event.command === "prompt" && event.success === false) {
				const errorText = typeof event.error === "string" ? event.error : "RPC prompt failed";
				fs.writeFileSync(path.join(agentDir, "result.md"), errorText, "utf-8");
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
				if (result.trim())
					fs.writeFileSync(path.join(agentDir, "result.md"), result, "utf-8");
			}
			if (event.type === "agent_settled") {
				scheduleAgentSettledTermination();
			}
		} catch (error) {
			stderrStream.write(`Invalid RPC JSON line: ${String(error)}\n${previewLine(line)}\n`);
			transcriptStream.write(serializeJsonLine({ type: "invalid_json", bytes: Buffer.byteLength(line, "utf8") }));
		}
	}, {
		maxLineChars: logLimits.rpcEventLineMaxChars,
		onLineTooLongStart: (linePrefix) => {
			const suppressedEventType = onRpcEvent ? undefined : suppressedRpcEventType(linePrefix);
			if (suppressedEventType) {
				suppressedRpcEventCounts.set(suppressedEventType, (suppressedRpcEventCounts.get(suppressedEventType) ?? 0) + 1);
				return true;
			}
			if (!onRpcEvent && isAgentEndLine(linePrefix)) {
				transcriptStream.write(serializeJsonLine({ type: "agent_end", oversized: true, bufferedChars: linePrefix.length }));
				if (lastAgentEndError) {
					fs.writeFileSync(path.join(agentDir, "result.md"), lastAgentEndError, "utf-8");
				} else if (lastAssistantResult.trim()) {
					completedFromAgentEnd = true;
					fs.writeFileSync(path.join(agentDir, "result.md"), lastAssistantResult.trim(), "utf-8");
				} else {
					lastAgentEndError = "Sub-agent produced an oversized agent_end RPC event before a final result could be captured.";
					fs.writeFileSync(path.join(agentDir, "result.md"), lastAgentEndError, "utf-8");
				}
				return true;
			}
			return false;
		},
		onLineTooLong: (lineChars) => {
			const message = `RPC JSON line exceeded ${logLimits.rpcEventLineMaxChars} chars; dropped oversized event (${lineChars} chars).`;
			stderrStream.write(`${message}\n`);
			transcriptStream.write(serializeJsonLine({ type: "oversized_rpc_event", chars: lineChars }));
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
		stderrStream.write(`${message}\n`);
		shouldKeepStderr = true;
		if (fs.existsSync(agentDir) && !fs.existsSync(path.join(agentDir, "result.md"))) {
			fs.writeFileSync(path.join(agentDir, "result.md"), message, "utf-8");
		}
		stderrStream.flush();
		transcriptStream.end();
		if (ownedHandle) {
			try { requestOwnedCancel(agentDir); } catch { /* supervisor may still be starting; receipt remains required */ }
		}
		notifyComplete(1);
	});

	const pid = proc.pid!;
	fs.writeFileSync(path.join(agentDir, "pid"), String(pid), "utf-8");
	if (!ownedHandle && process.platform !== "win32") fs.writeFileSync(path.join(agentDir, "process_group"), String(pid), "utf-8");
	writeProgress("spawned", { pid });

	proc.stdin.write([
		serializeJsonLine({
			id: "sub_get_state",
			type: "get_state",
		}),
		serializeJsonLine({
			id: "sub_prompt",
			type: "prompt",
			message: promptContent,
			...(promptImages ? { images: promptImages } : {}),
		}),
	].join(""));
	writeProgress("prompt_sent");
	// Keep stdin open while the RPC prompt is running. pi RPC mode treats stdin
	// EOF as a shutdown request, while the prompt command itself is handled
	// asynchronously after preflight. Closing stdin here can therefore terminate
	// the child before message_end/agent_end/agent_settled events are emitted,
	// producing exit 0 with no result.md. The child is terminated explicitly after agent_settled,
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

function compactRpcEventForTranscript(event: RpcEventRecord, originalBytes: number): RpcEventRecord | undefined {
	if (event.type === "message_update" || event.type === "tool_execution_update") return undefined;
	if (event.type === "response") {
		return stripUndefined({
			type: event.type,
			command: typeof event.command === "string" ? event.command : undefined,
			success: typeof event.success === "boolean" ? event.success : undefined,
			error: typeof event.error === "string" ? previewLine(event.error) : undefined,
			bytes: originalBytes,
		});
	}
	if (event.type === "agent_end") {
		return {
			type: event.type,
			messageCount: Array.isArray(event.messages) ? event.messages.length : 0,
			bytes: originalBytes,
		};
	}
	if (event.type === "message_end") {
		return stripUndefined({
			type: event.type,
			role: isRecord(event.message) && typeof event.message.role === "string" ? event.message.role : undefined,
			stopReason: isRecord(event.message) && typeof event.message.stopReason === "string" ? event.message.stopReason : undefined,
			bytes: originalBytes,
		});
	}
	if (event.type === "turn_end") {
		return {
			type: event.type,
			toolResultCount: Array.isArray(event.toolResults) ? event.toolResults.length : 0,
			bytes: originalBytes,
		};
	}
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
		return stripUndefined({
			type: event.type,
			toolName: typeof event.toolName === "string" ? event.toolName : undefined,
			toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : undefined,
			bytes: originalBytes,
		});
	}
	return { type: event.type, bytes: originalBytes };
}

function compactRpcEventForProgress(event: RpcEventRecord): Record<string, unknown> | undefined {
	if (event.type === "message_update" || event.type === "tool_execution_update") return undefined;
	if (event.type === "response") {
		return stripUndefined({
			type: event.type,
			command: typeof event.command === "string" ? event.command : undefined,
			success: typeof event.success === "boolean" ? event.success : undefined,
		});
	}
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
		return stripUndefined({
			type: event.type,
			toolName: typeof event.toolName === "string" ? event.toolName : undefined,
		});
	}
	if (event.type === "message_start" || event.type === "message_end") {
		return stripUndefined({
			type: event.type,
			role: typeof event.role === "string"
				? event.role
				: isRecord(event.message) && typeof event.message.role === "string"
					? event.message.role
					: undefined,
			stopReason: isRecord(event.message) && typeof event.message.stopReason === "string" ? event.message.stopReason : undefined,
		});
	}
	return { type: event.type };
}

function suppressedRpcEventType(line: string): string | undefined {
	if (line.includes('"type":"message_update"') || line.includes('"type": "message_update"')) return "message_update";
	if (line.includes('"type":"tool_execution_update"') || line.includes('"type": "tool_execution_update"')) return "tool_execution_update";
	return undefined;
}

function isAgentEndLine(line: string): boolean {
	return line.includes('"type":"agent_end"') || line.includes('"type": "agent_end"');
}

function writeSuppressedRpcEventSummary(transcriptStream: { write(chunk: string | Buffer): void }, counts: Map<string, number>): void {
	for (const [eventType, count] of counts) {
		if (count > 0) transcriptStream.write(serializeJsonLine({ type: "suppressed_rpc_events", eventType, count }));
	}
}

function previewLine(text: string, maxChars = 4096): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}… [truncated ${text.length - maxChars} chars]`;
}

function stripUndefined(record: RpcEventRecord): RpcEventRecord {
	for (const key of Object.keys(record)) {
		if (record[key] === undefined) delete record[key];
	}
	return record;
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

function prepareUiQaWorkspace(agentDir: string, subagentType: string | undefined): void {
	const workspace = path.join(agentDir, UI_QA_WORKSPACE_DIR);
	const browserWorkspace = path.join(agentDir, BROWSER_QA_WORKSPACE_DIR);
	fs.rmSync(workspace, { recursive: true, force: true });
	fs.rmSync(browserWorkspace, { recursive: true, force: true });
	if (!isUiQaType(subagentType)) return;
	const flows = path.join(browserWorkspace, "flows");
	const uiFlows = path.join(workspace, "flows");
	fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
	fs.mkdirSync(uiFlows, { recursive: true, mode: 0o700 });
	fs.mkdirSync(flows, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") {
		fs.chmodSync(workspace, 0o700);
		fs.chmodSync(uiFlows, 0o700);
		fs.chmodSync(browserWorkspace, 0o700);
		fs.chmodSync(flows, 0o700);
	}
}

function appendEnvList(value: string | undefined, items: readonly string[]): string {
	const existing = value?.trim();
	return existing ? `${existing},${items.join(",")}` : items.join(",");
}

function isTruthyEnv(value: string | undefined): boolean {
	return /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
}
