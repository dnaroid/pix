#!/usr/bin/env node
// @ts-nocheck

process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = () => {};

const codingAgentIndex = import.meta.resolve("@earendil-works/pi-coding-agent");
const { AgentSession } = await import("@earendil-works/pi-coding-agent");

const PIX_PAUSE_MESSAGE = "\u0000pix:agent-control:pause";
const PIX_CONTINUE_MESSAGE = "\u0000pix:agent-control:continue";
const PIX_CLEAR_TODOS_MESSAGE = "\u0000pix:clear-todos";
const PIX_DCP_RUNTIME_STATS_SYMBOL = Symbol.for("pix.dcp.runtime-stats");

const originalGetSessionStats = AgentSession.prototype.getSessionStats;
AgentSession.prototype.getSessionStats = function pixGetSessionStats() {
	const stats = originalGetSessionStats.call(this);
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
			record.pauseBoundaryReached = false;
			if (shouldContinue) {
				pause(record);
				return false;
			}
			// AgentSession 0.87 executes agent_before_settle after post-run
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
		record.pauseBoundaryReached = false;
		if (shouldContinue || canContinue(session)) pause(record);
		else record.state = "idle";
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
function assertCanContinue(session) {
	if (session.isStreaming || session.agent.state.isStreaming) {
		throw new Error("Agent is already running");
	}
	if (!canContinue(session)) {
		throw new Error("Agent has no continuable turn");
	}
}

/** @param {AgentSession} session */
async function continueSession(session, record) {

	record.state = "resuming";
	await record.pauseSettled;
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

const originalPrompt = AgentSession.prototype.prompt;
AgentSession.prototype.prompt = async function pixPrompt(text, options) {
	if (text === PIX_PAUSE_MESSAGE) {
		try {
			requestPause(this);
			options?.preflightResult?.(true);
			return;
		} catch (error) {
			options?.preflightResult?.(false);
			throw error;
		}
	}
	if (text === PIX_CONTINUE_MESSAGE) {
		try {
			const record = bindPause(this);
			assertCanContinue(this);
			const continuation = continueSession(this, record);
			options?.preflightResult?.(true);
			await continuation;
			return;
		} catch (error) {
			options?.preflightResult?.(false);
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
		options?.preflightResult?.(true);
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
