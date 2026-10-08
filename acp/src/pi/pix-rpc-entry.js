#!/usr/bin/env node
// @ts-nocheck

process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = () => {};

const codingAgentIndex = import.meta.resolve("@earendil-works/pi-coding-agent");
const { AgentSession, ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { installContextInventoryHost } = await import("./context-inventory-host.js");
const { installBtwHost, handleBtwPrompt } = await import("./btw-host.js");
installContextInventoryHost(AgentSession);
installBtwHost(AgentSession);
const { installRpcQuestionRecovery } = await import("../../../dist/bundled-extensions/question/recovery.js");
installRpcQuestionRecovery(AgentSession);

// _emit is synchronous. At turn_end the SDK has already appended the assistant
// and every tool result, whereas message_end listeners run BEFORE persistence.
// Carry the immutable boundary identity over RPC instead of asking for a later leaf.
const originalForkBoundaryEmit = AgentSession.prototype._emit;
AgentSession.prototype._emit = function pixForkBoundaryEmit(event) {
	if (event.type === "turn_end" || event.type === "compaction_end" || event.type === "agent_settled") {
		event = { ...event,
			pixForkLeafId: this.sessionManager.getLeafId(),
			pixForkSessionPath: this.sessionManager.getSessionFile(),
		};
	}
	return originalForkBoundaryEmit.call(this, event);
};

const PIX_PAUSE_MESSAGE = "\u0000pix:agent-control:pause";
const PIX_CANCEL_PAUSE_MESSAGE = "\u0000pix:agent-control:cancel-pause";
const PIX_CONTINUE_MESSAGE = "\u0000pix:agent-control:continue";
const PIX_CLEAR_TODOS_MESSAGE = "\u0000pix:clear-todos";
const PIX_LSP_CONTROL_PREFIX = "\u0000pix:lsp-control:";
const PIX_BTW_RPC_PREFIX = "\u0000pix:btw:";
const PIX_DCP_RUNTIME_STATS_SYMBOL = Symbol.for("pix.dcp.runtime-stats");

// --- Anthropic API-key response-header usage capture -----------------------
//
// Anthropic Messages responses carry `anthropic-ratelimit-*` headers that are
// the only usage signal for plain API keys (no subscription quota endpoint).
// Capture them per (session, model) from provider responses and expose the
// latest record for the session's CURRENT model through session stats. The
// ACP adapter parses them with the shared Pix model-usage module; subscription
// (OAuth) auth is skipped because its quota is served by the usage endpoint.

const PIX_ANTHROPIC_USAGE_HEADER_PREFIXES = ["anthropic-ratelimit-", "x-ratelimit-"];
const PIX_ANTHROPIC_USAGE_MAX_HEADERS = 32;
const PIX_ANTHROPIC_USAGE_MAX_RECORDS = 16;

/** @type {Map<string, {modelKey: string, status: number, headers: Record<string, string>, receivedAt: number}>} */
const pixAnthropicUsageRecords = new Map();

function pixAnthropicUsageKey(sessionId, modelKey) {
	return `${sessionId}\0${modelKey}`;
}

function isAnthropicProvider(provider) {
	return typeof provider === "string" && provider.toLowerCase() === "anthropic";
}

function captureAnthropicUsageHeaders(response, model) {
	const headers = response?.headers;
	if (!headers || typeof headers !== "object" || !model) return undefined;
	const selected = {};
	let count = 0;
	for (const [name, value] of Object.entries(headers)) {
		const lowerName = name.toLowerCase();
		if (!PIX_ANTHROPIC_USAGE_HEADER_PREFIXES.some((prefix) => lowerName.startsWith(prefix))) continue;
		const key = lowerName;
		const text = typeof value === "string" ? value.trim() : "";
		if (!key || !text) continue;
		selected[key] = text;
		count += 1;
		if (count >= PIX_ANTHROPIC_USAGE_MAX_HEADERS) break;
	}
	if (count === 0) return undefined;
	return {
		modelKey: `${model.provider}/${model.id}`,
		status: typeof response.status === "number" ? response.status : 0,
		headers: selected,
		receivedAt: Date.now(),
	};
}

function recordAnthropicUsage(sessionId, record) {
	const key = pixAnthropicUsageKey(sessionId, record.modelKey);
	pixAnthropicUsageRecords.delete(key);
	pixAnthropicUsageRecords.set(key, record);
	while (pixAnthropicUsageRecords.size > PIX_ANTHROPIC_USAGE_MAX_RECORDS) {
		const oldest = pixAnthropicUsageRecords.keys().next().value;
		if (oldest === undefined) break;
		pixAnthropicUsageRecords.delete(oldest);
	}
}

function pixAnthropicUsageForSession(sessionId, model) {
	if (!sessionId || !model?.provider || !model?.id) return undefined;
	const record = pixAnthropicUsageRecords.get(pixAnthropicUsageKey(sessionId, `${model.provider}/${model.id}`));
	if (!record) return undefined;
	return {
		modelKey: record.modelKey,
		status: record.status,
		headers: { ...record.headers },
		receivedAt: record.receivedAt,
	};
}

function pixWrapStreamOptions(runtime, model, options) {
	if (!options || typeof options !== "object") return options;
	const sessionId = typeof options.sessionId === "string" ? options.sessionId : undefined;
	if (!sessionId || !isAnthropicProvider(model?.provider)) return options;
	try {
		if (typeof runtime?.isUsingSubscription === "function" && runtime.isUsingSubscription(model.provider)) {
			return options;
		}
	} catch {
		return options;
	}
	const inner = typeof options.onResponse === "function" ? options.onResponse : undefined;
	return {
		...options,
		onResponse: async (response, responseModel) => {
			try {
				const record = captureAnthropicUsageHeaders(response, responseModel ?? model);
				if (record) recordAnthropicUsage(sessionId, record);
			} catch {
				// Usage capture is best-effort; never fail the provider stream.
			}
			if (inner) return inner(response, responseModel);
			return undefined;
		},
	};
}

function installAnthropicUsageCapture() {
	if (typeof ModelRuntime !== "function") return;
	for (const method of ["stream", "streamSimple"]) {
		const original = ModelRuntime.prototype[method];
		if (typeof original !== "function") continue;
		ModelRuntime.prototype[method] = function pixCaptureUsage(model, context, options) {
			return original.call(this, model, context, pixWrapStreamOptions(this, model, options));
		};
	}
	const originalStats = AgentSession.prototype.getSessionStats;
	if (typeof originalStats !== "function") return;
	AgentSession.prototype.getSessionStats = function pixAnthropicUsageStats() {
		const stats = originalStats.call(this);
		try {
			const model = this?.agent?.state?.model;
			const usage = pixAnthropicUsageForSession(stats?.sessionId, model);
			return usage ? { ...stats, pixAnthropicUsage: usage } : stats;
		} catch {
			return stats;
		}
	};
}

installAnthropicUsageCapture();
// --- end Anthropic API-key response-header usage capture -------------------

const originalGetSessionStats = AgentSession.prototype.getSessionStats;
AgentSession.prototype.getSessionStats = function pixGetSessionStats() {
	const stats = { ...originalGetSessionStats.call(this),
		pixSearchLeafId: this.sessionManager.getLeafId(),
		pixSearchSessionPath: this.sessionManager.getSessionFile(),
	};
	try {
		const getter = globalThis[PIX_DCP_RUNTIME_STATS_SYMBOL];
		if (typeof getter !== "function") return stats;
		const runtimeStats = getter();
		const tokensSaved = runtimeStats?.tokensSaved;
		if (typeof tokensSaved !== "number" || !Number.isFinite(tokensSaved) || tokensSaved < 0) return stats;
		const contextMap = parseDcpContextMap(runtimeStats?.contextMap);
		return {
			...stats,
			pixDcpTokensSaved: Math.round(tokensSaved),
			...(contextMap ? { pixDcpContextMap: contextMap } : {}),
		};
	} catch {
		return stats;
	}
};

function parseDcpContextMap(value) {
	const estimates = value?.tokenEstimates;
	const valid = value && typeof value === "object"
		&& Number.isSafeInteger(value.revision) && value.revision > 0
		&& Number.isSafeInteger(value.sessionEpoch) && value.sessionEpoch >= 0
		&& Number.isSafeInteger(value.generatedAt) && value.generatedAt > 0
		&& Number.isFinite(new Date(value.generatedAt).getTime())
		&& estimates && [estimates.candidate, estimates.protected, estimates.compressed, estimates.retained]
			.every((tokens) => Number.isSafeInteger(tokens) && tokens >= 0);
	if (!valid) return undefined;
	const total = estimates.candidate + estimates.protected + estimates.compressed + estimates.retained;
	if (!Number.isSafeInteger(total) || total <= 0) return undefined;
	return {
		revision: value.revision, sessionEpoch: value.sessionEpoch,
		generatedAt: value.generatedAt,
		tokenEstimates: { candidate: estimates.candidate, protected: estimates.protected,
			compressed: estimates.compressed, retained: estimates.retained },
	};
}

/** @type {WeakMap<AgentSession, {
 *   state: "idle" | "pause-requested" | "paused" | "resuming";
 *   pauseBoundaryReached: boolean;
 *   pauseSettled?: Promise<void>;
 *   resolvePauseSettled?: () => void;
 *   originalHandlePostAgentRun: () => Promise<boolean>;
 *   originalRunBeforeSettleBoundary: () => Promise<boolean>;
 * }>} */
const records = new WeakMap();

/** @param {AgentSession} session */
function sessionInternals(session) {
	const internals = session;
	if (typeof internals._handlePostAgentRun !== "function"
		|| typeof internals._runBeforeSettleBoundary !== "function"
		|| typeof internals._flushPendingBashMessages !== "function"
		|| typeof internals._flushPendingCustomMessages !== "function"
		|| typeof internals._emitAgentSettled !== "function"
		|| typeof internals._isAgentRunActive !== "boolean"
		|| typeof internals._agentRunAbortRequested !== "boolean"
		|| !("_runSystemPromptOptions" in internals)) {
		throw new Error("Agent pause is incompatible with this pi SDK version");
	}
	return internals;
}

/** @param {AgentSession} session */
function bindPause(session) {
	const existing = records.get(session);
	if (existing) return existing;

	const internals = sessionInternals(session);
	const record = {
		state: "idle",
		pauseBoundaryReached: false,
		originalHandlePostAgentRun: internals._handlePostAgentRun.bind(session),
		originalRunBeforeSettleBoundary: internals._runBeforeSettleBoundary.bind(session),
	};
	records.set(session, record);

	session.subscribe((event) => {
		if (event.type === "agent_start" && (record.state === "paused" || record.state === "resuming")) {
			record.state = "idle";
			record.pauseBoundaryReached = false;
		}
	});

	const originalEmitAgentSettled = internals._emitAgentSettled.bind(session);
	internals._emitAgentSettled = async () => {
		try {
			await originalEmitAgentSettled();
		} finally {
			record.resolvePauseSettled?.();
			delete record.resolvePauseSettled;
			if (record.state === "pause-requested") {
				record.pauseBoundaryReached = false;
				record.state = "idle";
			}
		}
	};

	const originalFinishTurn = session.agent.finishTurn;
	session.agent.finishTurn = async (turn, signal) => {
		const priorDecision = await originalFinishTurn?.(turn, signal);
		if (priorDecision?.action === "end") {
			if (record.state === "pause-requested") {
				record.pauseBoundaryReached = false;
				record.state = "idle";
			}
			return priorDecision;
		}
		// An explicit continuation can leave an assistant-tail transcript that
		// Agent.continue() cannot restart, so wait for the next turn boundary.
		if (priorDecision?.action === "continue") return priorDecision;
		if (record.state !== "pause-requested" || signal?.aborted
			|| turn.message.stopReason === "aborted" || turn.message.stopReason === "error") {
			return priorDecision;
		}
		record.pauseBoundaryReached = true;
		return { action: "end" };
	};

	internals._handlePostAgentRun = async () => {
		if (record.state === "paused") return false;
		const pauseBoundaryReached = record.pauseBoundaryReached;
		const shouldContinue = await record.originalHandlePostAgentRun();
		if (internals._agentRunAbortRequested) {
			clearPauseRequest(record);
			return false;
		}
		if (pauseBoundaryReached || record.state === "pause-requested") {
			// Keep the irreversible decision locked through before-settle awaits.
			record.pauseBoundaryReached = true;
			if (shouldContinue) {
				pause(record);
				return false;
			}
			// AgentSession executes agent_before_settle after post-run
			// bookkeeping. Preserve that boundary before deciding whether the
			// turn can be resumed.
			return false;
		}
		return shouldContinue;
	};

	internals._runBeforeSettleBoundary = async () => {
		if (record.state === "paused") return false;
		if (internals._agentRunAbortRequested) {
			clearPauseRequest(record);
			return false;
		}
		const shouldContinue = await record.originalRunBeforeSettleBoundary();
		if (record.state !== "pause-requested") return shouldContinue;
		if (internals._agentRunAbortRequested) {
			clearPauseRequest(record);
			return false;
		}
		if (shouldContinue || canContinue(session)) pause(record);
		else clearPauseRequest(record);
		return false;
	};

	return record;
}

/** @param {AgentSession} session */
function canContinue(session) {
	const messages = session.agent.state.messages;
	const lastMessage = messages[messages.length - 1];
	return Boolean(lastMessage && lastMessage.role !== "assistant") || session.agent.hasQueuedMessages();
}

function pause(record) {
	record.pauseSettled = new Promise((resolve) => {
		record.resolvePauseSettled = resolve;
	});
	record.state = "paused";
}

function clearPauseRequest(record) {
	record.pauseBoundaryReached = false;
	if (record.state === "pause-requested") record.state = "idle";
}

/** @param {AgentSession} session */
function requestPause(session) {
	const record = bindPause(session);
	if (record.state === "pause-requested") return;
	if (!session.isStreaming && !session.agent.state.isStreaming) {
		throw new Error("Agent is not running");
	}
	record.state = "pause-requested";
}

/** @param {AgentSession} session */
function cancelPause(session) {
	const record = bindPause(session);
	// finishTurn's end decision is irreversible for this run. Never pretend
	// cancellation succeeded or implicitly resume once that boundary wins.
	if (record.pauseBoundaryReached || record.state === "paused") {
		throw new Error("Agent has already reached the pause boundary");
	}
	if (record.state === "pause-requested") record.state = "idle";
}

/** @param {AgentSession} session */
function assertCanContinue(session) {
	if (session.isStreaming || session.agent.state.isStreaming) {
		throw new Error("Agent is already running");
	}
	if (!canContinue(session)) {
		throw new Error("Agent has no continuable turn");
	}
}

/** @param {AgentSession} session */
async function continueSession(session, record, isCurrent = () => true) {

	record.state = "resuming";
	await record.pauseSettled;
	if (!isCurrent()) {
		record.state = "paused";
		return;
	}
	const internals = sessionInternals(session);
	internals._isAgentRunActive = true;
	internals._agentRunAbortRequested = false;
	try {
		await session.agent.continue();
		while (true) {
			const shouldContinue = await internals._handlePostAgentRun();
			if (shouldContinue) {
				if (internals._agentRunAbortRequested) break;
				await session.agent.continue();
				continue;
			}
			if (internals._agentRunAbortRequested || !await internals._runBeforeSettleBoundary()) break;
			await session.agent.continue();
		}
	} finally {
		internals._runSystemPromptOptions = undefined;
		internals._flushPendingBashMessages();
		internals._flushPendingCustomMessages();
		await internals._emitAgentSettled();
	}
	if (record.state === "resuming") record.state = "idle";
}

// --- Quota-wait hidden control messages -----------------------------------
//
// The bundled quota-wait extension asks its host to pause at a safe turn
// boundary, or to continue a paused/resumable transcript, through a hidden
// control message that must never reach the transcript. The root TUI host
// installs the same interception via src/app/session/quota-wait-control.ts;
// this RPC-side twin keeps pi RPC sessions (Desktop ACP) identical without
// importing compiled app code into pi's RPC entry.

const PIX_QUOTA_CONTROL_CUSTOM_TYPE = "pix-quota-control";

const originalSendCustomMessage = AgentSession.prototype.sendCustomMessage;
AgentSession.prototype.sendCustomMessage = async function pixQuotaControlSend(message, options) {
	if (!message || message.customType !== PIX_QUOTA_CONTROL_CUSTOM_TYPE) {
		return originalSendCustomMessage.call(this, message, options);
	}
	const data = message.details;
	const settle = typeof data?.settle === "function" ? data.settle : undefined;
	if (
		!data || (data.action !== "pause" && data.action !== "continue")
		|| typeof data.accepted !== "function" || !settle
	) {
		settle?.(new Error("Invalid quota control envelope"));
		return;
	}
	// Acknowledge host support immediately so the sender's timeout clears.
	data.accepted();
	let outcome;
	try {
		outcome = { ok: true, value: await handleQuotaControl(this, data.action, data.isCurrent ?? (() => true)) };
	} catch (error) {
		outcome = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
	}
	try {
		if (outcome.ok) settle(outcome.value);
		else settle(outcome.error);
	} catch {
		// The extension owns the callback; a failing one must not break the send.
	}
};

/**
 * Pause: request a safe turn-boundary pause only while the agent is busy;
 * idle or already-paused sessions are a no-op success.
 * Continue: resume through the same lifecycle as the RPC continue control
 * prompt; return false when the transcript has no resumable boundary so the
 * extension can fall back to its hidden continuation message.
 *
 * @param {AgentSession} session
 * @param {"pause" | "continue"} action
 * @returns {Promise<boolean>}
 */
async function handleQuotaControl(session, action, isCurrent) {
	const record = bindPause(session);
	if (action === "pause") {
		if (record.state === "pause-requested" || record.state === "resuming") return true;
		if (session.isStreaming || session.agent.state.isStreaming) {
			try {
				requestPause(session);
			} catch (error) {
				// The run can end between the check and the request; treat that
				// as the idle no-op instead of failing the scheduled wait.
				if (session.isStreaming || session.agent.state.isStreaming) throw error;
			}
		}
		return true;
	}
	if (session.isStreaming || session.agent.state.isStreaming) {
		throw new Error("Agent is already running");
	}
	if (record.state === "resuming") throw new Error("Agent continuation is already in progress");
	if (!canContinue(session)) return false;
	await continueSession(session, record, isCurrent);
	return true;
}

const originalPrompt = AgentSession.prototype.prompt;
AgentSession.prototype.prompt = async function pixPrompt(text, options) {
	if (typeof text === "string" && text.startsWith(PIX_BTW_RPC_PREFIX)) {
		handleBtwPrompt(this, text, options);
		return;
	}
	if (text === PIX_PAUSE_MESSAGE) {
		try {
			requestPause(this);
			options?.preflightResult?.("handled");
			return;
		} catch (error) {
			throw error;
		}
	}
	if (text === PIX_CANCEL_PAUSE_MESSAGE) {
		cancelPause(this);
		options?.preflightResult?.("handled");
		return;
	}
	if (text === PIX_CONTINUE_MESSAGE) {
		try {
			const record = bindPause(this);
			assertCanContinue(this);
			const continuation = continueSession(this, record);
			options?.preflightResult?.("started");
			await continuation;
			return;
		} catch (error) {
			throw error;
		}
	}
	if (text === PIX_CLEAR_TODOS_MESSAGE) {
		const runner = this.extensionRunner;
		const command = runner?.getCommand("todos-clear");
		if (!command) throw new Error("Todo extension is unavailable in this session");
		const context = runner.createCommandContext();
		if (!context.isIdle()) throw new Error("Cannot clear session plan while the session is busy");
		// The normal slash dispatcher reports handler errors as UI events and swallows
		// them. Invoke the same handler directly so ACP receives a failed request.
		await command.handler("", context);
		options?.preflightResult?.("handled");
		return;
	}
	if (text.startsWith(PIX_LSP_CONTROL_PREFIX)) {
		const request = JSON.parse(text.slice(PIX_LSP_CONTROL_PREFIX.length));
		if (!request || typeof request.requestId !== "string" || typeof request.action !== "string") {
			throw new Error("Invalid LSP control request");
		}
		const runner = this.extensionRunner;
		const command = runner?.getCommand("lsp-control");
		if (!command) throw new Error("LSP control extension is unavailable in this session");
		const baseContext = runner.createCommandContext();
		let snapshot;
		// SDK contexts share their UI object. Keep capture request-local and retain
		// the SDK's lazy context getters and stale-instance checks.
		const context = Object.defineProperties({}, {
			...Object.getOwnPropertyDescriptors(baseContext),
			ui: { enumerable: true, get: () => ({
				...baseContext.ui,
				setStatus(key, value) {
					if (key === "pix:lsp" && typeof value === "string") {
						try { snapshot = JSON.parse(value); } catch { snapshot = undefined; }
						return;
					}
					return baseContext.ui.setStatus(key, value);
				},
			}) },
		});
		await command.handler(JSON.stringify({ action: request.action, ...(request.id === undefined ? {} : { id: request.id }), ...(request.root === undefined ? {} : { root: request.root }) }), context);
		if (!snapshot || !Array.isArray(snapshot.servers) || !Array.isArray(snapshot.warnings)) {
			throw new Error("LSP control command returned no snapshot");
		}
		this._emit({ type: "pix_lsp_response", requestId: request.requestId, snapshot });
		options?.preflightResult?.("handled");
		return;
	}
	// Bind the turn-boundary hook before the normal prompt starts. Agent captures
	// finishTurn when it builds the loop config, so installing the hook
	// only when the Pause button is clicked is too late for the already-running
	// turn and the pause request would never be observed.
	bindPause(this);
	return originalPrompt.call(this, text, options);
};

const { main } = await import(new URL("./main.js", codingAgentIndex).href);
await main(["--mode", "rpc", ...process.argv.slice(2)]);
