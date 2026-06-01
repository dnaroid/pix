import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTask, RetryConfig } from "./types.js";
import type { SpawnedAgent, AgentCompletionHandler } from "./types.js";
import { isQuotaLimitCompletion, nextFallbackModel, rememberSessionModelFallback, selectSessionModelWithFallback } from "./model-fallback.js";
import { spawnAgent, type SpawnAgentOptions } from "./spawn.js";
import { getAgentState } from "./state.js";
import { isoNow } from "./utils.js";

export interface RetryableSpawnOptions extends SpawnAgentOptions {
	retry: RetryConfig;
	extraArgs?: string[];
	/** Ordered fallback models for quota/rate-limit failures. Applies to this Pi process/session. */
	fallbackModels?: string[];
	signal?: AbortSignal;
	onRpcEvent?: (event: import("./types.js").RpcEventRecord) => void;
	/** Called each time a retry attempt starts. */
	onRetry?: (attempt: number, maxRetries: number, delayMs: number) => void;
}

/**
 * Spawn an agent with automatic retry on failure.
 *
 * Returns a promise that resolves with the final SpawnedAgent (possibly after retries).
 * The `onComplete` callback is only called for the *final* attempt (success or all retries exhausted).
 */
export function spawnAgentWithRetry(
	runDir: string,
	task: AgentTask,
	cwd: string,
	onComplete: AgentCompletionHandler | undefined,
	options: RetryableSpawnOptions,
): { initial: SpawnedAgent; done: Promise<void> } {
	const { retry, extraArgs = [], fallbackModels = [], signal, onRpcEvent, onRetry, ...spawnOpts } = options;
	if (signal?.aborted) throw new Error("Aborted");
	const maxRetries = retry.maxRetries > 0 ? retry.maxRetries : 0;
	const initialModel = selectSessionModelWithFallback(task.model, fallbackModels);
	let currentTask = initialModel?.fellBack ? { ...task, model: initialModel.model } : task;

	let currentAttempt = 0;
	let settled = false;
	let retryTimer: NodeJS.Timeout | undefined;
	let abortRetry: (() => void) | undefined;
	let resolveAllDone: () => void;
	let rejectAllDone: (error: Error) => void;
	const allDone = new Promise<void>((resolve, reject) => {
		resolveAllDone = resolve;
		rejectAllDone = reject;
	});

	const settle = (completion: Parameters<AgentCompletionHandler>[0], error?: Error) => {
		if (settled) return;
		settled = true;
		if (retryTimer) clearTimeout(retryTimer);
		abortRetry?.();
		clearRetryPending(completion.agentDir);
		writeRetryCount(completion.agentDir, currentAttempt);
		onComplete?.(completion);
		if (error) rejectAllDone!(error);
		else resolveAllDone!();
	};

	const handleCompletion: AgentCompletionHandler = (completion) => {
		if (settled) return;
		const fallbackModel = isQuotaLimitCompletion(completion, currentTask.model)
			? nextFallbackModel(currentTask.model, fallbackModels)
			: undefined;
		if (fallbackModel) {
			const failedModel = currentTask.model;
			rememberSessionModelFallback(failedModel, fallbackModel);
			writeModelFallbackLog(completion.agentDir, failedModel, fallbackModel, completion.exitCode);
			currentTask = { ...currentTask, model: fallbackModel };
			if (signal?.aborted) {
				settle(completion);
				return;
			}
			if (isStopRequested(completion.agentDir)) {
				settle(refreshedCompletion(completion));
				return;
			}
			try {
				spawnAgent(runDir, currentTask, cwd, extraArgs, onRpcEvent, handleCompletion, spawnOpts);
			} catch (error) {
				settle(completion, error instanceof Error ? error : new Error(String(error)));
			}
			return;
		}
		const isRetryable = maxRetries > currentAttempt && shouldRetry(completion, retry);

		if (!isRetryable) {
			settle(completion);
			return;
		}

		// Schedule retry with exponential backoff.
		currentAttempt++;
		const delayMs = retry.backoffMs * Math.pow(2, currentAttempt - 1);
		onRetry?.(currentAttempt, maxRetries, delayMs);

		// Write retry metadata.
		writeRetryCount(completion.agentDir, currentAttempt);
		writeRetryPending(completion.agentDir, delayMs);
		writeRetryLog(completion.agentDir, currentAttempt, delayMs, completion.exitCode);

		if (signal?.aborted) {
			settle(completion);
			return;
		}

		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			abortRetry?.();
			abortRetry = undefined;
			if (settled) return;
			if (signal?.aborted || isStopRequested(completion.agentDir)) {
				settle(refreshedCompletion(completion));
				return;
			}
			clearRetryPending(completion.agentDir);
			try {
				spawnAgent(runDir, currentTask, cwd, extraArgs, onRpcEvent, handleCompletion, spawnOpts);
			} catch (error) {
				settle(completion, error instanceof Error ? error : new Error(String(error)));
			}
		}, delayMs);
		retryTimer.unref?.();

		if (signal) {
			const onAbort = () => settle(refreshedCompletion(completion));
			signal.addEventListener("abort", onAbort, { once: true });
			abortRetry = () => signal.removeEventListener("abort", onAbort);
		}
	};

	const initial = spawnAgent(runDir, currentTask, cwd, extraArgs, onRpcEvent, handleCompletion, spawnOpts);
	return { initial, done: allDone };
}

function shouldRetry(completion: Parameters<AgentCompletionHandler>[0], retry: RetryConfig): boolean {
	if (completion.state.status === "stopped") return false;
	if (completion.exitCode === 0) return false;
	if (retry.retryableExitCodes === undefined) return true;
	if (retry.retryableExitCodes.length === 0) return false;
	return retry.retryableExitCodes.includes(completion.exitCode);
}

function writeRetryCount(agentDir: string, count: number): void {
	try {
		fs.writeFileSync(path.join(agentDir, "retry_count"), String(count), "utf-8");
	} catch { /* best-effort */ }
}

function writeRetryPending(agentDir: string, delayMs: number): void {
	try {
		const nextRetryAt = new Date(Date.now() + delayMs).toISOString().replace(/\.\d{3}Z$/, "Z");
		fs.writeFileSync(path.join(agentDir, "retry_pending"), isoNow(), "utf-8");
		fs.writeFileSync(path.join(agentDir, "next_retry_at"), nextRetryAt, "utf-8");
	} catch { /* best-effort */ }
}

function clearRetryPending(agentDir: string): void {
	try {
		fs.rmSync(path.join(agentDir, "retry_pending"), { force: true });
		fs.rmSync(path.join(agentDir, "next_retry_at"), { force: true });
	} catch { /* best-effort */ }
}

function writeRetryLog(agentDir: string, attempt: number, delayMs: number, exitCode: number): void {
	try {
		const line = `${isoNow()} retry=${attempt} delay=${delayMs}ms exitCode=${exitCode}\n`;
		fs.appendFileSync(path.join(agentDir, "retry.log"), line, "utf-8");
	} catch { /* best-effort */ }
}

function writeModelFallbackLog(agentDir: string, failedModel: string | undefined, fallbackModel: string, exitCode: number): void {
	try {
		const line = `${isoNow()} modelFallback ${failedModel ?? "(default)"} -> ${fallbackModel} exitCode=${exitCode}\n`;
		fs.appendFileSync(path.join(agentDir, "model_fallback.log"), line, "utf-8");
		fs.writeFileSync(path.join(agentDir, "model_fallback_from"), failedModel ?? "", "utf-8");
		fs.writeFileSync(path.join(agentDir, "model_fallback_to"), fallbackModel, "utf-8");
	} catch { /* best-effort */ }
}

function isStopRequested(agentDir: string): boolean {
	return fs.existsSync(path.join(agentDir, "stop_requested"));
}

function refreshedCompletion(completion: Parameters<AgentCompletionHandler>[0]): Parameters<AgentCompletionHandler>[0] {
	const refreshed = getAgentState(completion.runDir, completion.agentId, { includeLineCounts: false });
	return refreshed ? { ...completion, exitCode: refreshed.exitCode ?? completion.exitCode, state: refreshed } : completion;
}
