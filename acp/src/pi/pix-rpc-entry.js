#!/usr/bin/env node
// @ts-nocheck

process.env.PI_CODING_AGENT = "true";
process.env.AI_AGENT = "pi";
process.emitWarning = () => {};

const codingAgentIndex = import.meta.resolve("@earendil-works/pi-coding-agent");
const { AgentSession } = await import("@earendil-works/pi-coding-agent");

const PIX_PAUSE_MESSAGE = "\u0000pix:agent-control:pause";
const PIX_CONTINUE_MESSAGE = "\u0000pix:agent-control:continue";

/** @type {WeakMap<AgentSession, {
 *   state: "idle" | "pause-requested" | "paused" | "resuming";
 *   pauseBoundaryReached: boolean;
 *   pauseSettled?: Promise<void>;
 *   resolvePauseSettled?: () => void;
 *   originalHandlePostAgentRun: () => Promise<boolean>;
 * }>} */
const records = new WeakMap();

/** @param {AgentSession} session */
function sessionInternals(session) {
	const internals = session;
	if (typeof internals._handlePostAgentRun !== "function"
		|| typeof internals._flushPendingBashMessages !== "function"
		|| typeof internals._emitAgentSettled !== "function"
		|| typeof internals._isAgentRunActive !== "boolean"
		|| !("_systemPromptOverride" in internals)) {
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

	const originalShouldStopAfterTurn = session.agent.shouldStopAfterTurn;
	session.agent.shouldStopAfterTurn = async (context, signal) => {
		if (await originalShouldStopAfterTurn?.(context, signal)) {
			if (record.state === "pause-requested") {
				record.pauseBoundaryReached = false;
				record.state = "idle";
			}
			return true;
		}
		if (record.state !== "pause-requested") return false;
		record.pauseBoundaryReached = true;
		return true;
	};

	internals._handlePostAgentRun = async () => {
		if (record.state === "paused") return false;
		const pauseBoundaryReached = record.pauseBoundaryReached;
		record.pauseBoundaryReached = false;
		const shouldContinue = await record.originalHandlePostAgentRun();
		if (pauseBoundaryReached || record.state === "pause-requested") {
			if (shouldContinue || canContinue(session)) {
				record.pauseSettled = new Promise((resolve) => {
					record.resolvePauseSettled = resolve;
				});
				record.state = "paused";
				return false;
			}
			record.state = "idle";
			return false;
		}
		return shouldContinue;
	};

	return record;
}

/** @param {AgentSession} session */
function canContinue(session) {
	const messages = session.agent.state.messages;
	const lastMessage = messages[messages.length - 1];
	return Boolean(lastMessage && lastMessage.role !== "assistant") || session.agent.hasQueuedMessages();
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
	try {
		await session.agent.continue();
		while (await record.originalHandlePostAgentRun()) {
			await session.agent.continue();
		}
	} finally {
		internals._systemPromptOverride = undefined;
		internals._flushPendingBashMessages();
		internals._flushPendingCustomMessages?.();
		await internals._emitAgentSettled();
	}
	record.state = "idle";
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
	return originalPrompt.call(this, text, options);
};

const { main } = await import(new URL("./main.js", codingAgentIndex).href);
await main(["--mode", "rpc", ...process.argv.slice(2)]);
