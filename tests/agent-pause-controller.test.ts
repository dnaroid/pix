import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { APP_ICONS } from "../src/app/icons.js";
import { AgentPauseController } from "../src/app/session/agent-pause-controller.js";

describe("AgentPauseController", () => {
	it("requests an end only after a completed turn and pauses after before-settle", async () => {
		const fixture = pauseFixture();
		fixture.controller.bind(fixture.session);

		await fixture.controller.toggle(fixture.session);
		assert.equal(fixture.controller.state(fixture.session), "pause-requested");

		const decision = await fixture.agent.finishTurn?.({ message: { stopReason: "stop" }, toolResults: [{}] } as never, new AbortController().signal);
		assert.deepEqual(decision, { action: "end" });
		assert.equal(fixture.controller.state(fixture.session), "pause-requested");
		assert.equal(await fixture.internals._handlePostAgentRun(), false);
		assert.equal(await fixture.internals._runBeforeSettleBoundary(), false);
		assert.equal(fixture.controller.state(fixture.session), "paused");
		assert.equal(fixture.controller.statusWidgetText(fixture.session), APP_ICONS.play);
		assert.equal(fixture.postRunCalls(), 1);
	});

	it("lets a tool-free final turn finish instead of creating a non-resumable pause", async () => {
		const fixture = pauseFixture({ lastMessageRole: "assistant" });
		fixture.controller.bind(fixture.session);
		await fixture.controller.toggle(fixture.session);

		const decision = await fixture.agent.finishTurn?.({ message: { stopReason: "stop" }, toolResults: [] } as never, new AbortController().signal);
		await fixture.internals._handlePostAgentRun();
		await fixture.internals._runBeforeSettleBoundary();

		assert.deepEqual(decision, { action: "end" });
		assert.equal(fixture.controller.state(fixture.session), "idle");
	});

	it("pauses a tool-free turn when queued work can continue it", async () => {
		const fixture = pauseFixture({ lastMessageRole: "assistant", hasQueuedMessages: true });
		fixture.controller.bind(fixture.session);
		await fixture.controller.toggle(fixture.session);

		await fixture.agent.finishTurn?.({ message: { stopReason: "stop" }, toolResults: [] } as never, new AbortController().signal);
		await fixture.internals._handlePostAgentRun();
		await fixture.internals._runBeforeSettleBoundary();

		assert.equal(fixture.controller.state(fixture.session), "paused");
	});

	it("accepts a pause during session post-run bookkeeping", async () => {
		const fixture = pauseFixture({ lastMessageRole: "assistant", postRunResult: true });
		(fixture.agent.state as { isStreaming: boolean }).isStreaming = false;
		fixture.internals._isAgentRunActive = true;
		fixture.controller.bind(fixture.session);

		await fixture.controller.toggle(fixture.session);
		await fixture.internals._handlePostAgentRun();

		assert.equal(fixture.controller.state(fixture.session), "paused");
	});

	it("preserves an existing end decision as authoritative", async () => {
		const fixture = pauseFixture({ existingFinish: "end" });
		fixture.controller.bind(fixture.session);
		await fixture.controller.toggle(fixture.session);

		const decision = await fixture.agent.finishTurn?.({ message: { stopReason: "stop" }, toolResults: [{}] } as never, new AbortController().signal);

		assert.deepEqual(decision, { action: "end" });
		assert.equal(fixture.controller.state(fixture.session), "idle");
	});

	it("preserves an existing continue decision while waiting for the next pausable boundary", async () => {
		const fixture = pauseFixture({ existingFinish: "continue" });
		fixture.controller.bind(fixture.session);

		assert.deepEqual(await fixture.agent.finishTurn?.({ message: { stopReason: "stop" }, toolResults: [] } as never), { action: "continue" });
		await fixture.controller.toggle(fixture.session);
		assert.deepEqual(await fixture.agent.finishTurn?.({ message: { stopReason: "stop" }, toolResults: [] } as never), { action: "continue" });
		assert.equal(fixture.controller.state(fixture.session), "pause-requested");
	});

	it("continues through session bookkeeping and returns to idle", async () => {
		const fixture = pauseFixture();
		fixture.controller.bind(fixture.session);
		await fixture.controller.toggle(fixture.session);
		await fixture.agent.finishTurn?.({ message: { stopReason: "stop" }, toolResults: [{}] } as never, new AbortController().signal);
		await fixture.internals._handlePostAgentRun();
		await fixture.internals._runBeforeSettleBoundary();
		await fixture.internals._emitAgentSettled();

		await fixture.controller.toggle(fixture.session);

		assert.equal(fixture.continueCalls(), 1);
		assert.equal(fixture.postRunCalls(), 2);
		assert.equal(fixture.settledCalls(), 2);
		assert.equal(fixture.internals._isAgentRunActive, false);
		assert.equal(fixture.controller.state(fixture.session), "idle");
	});

	it("does not continue before the paused run reaches session post-run bookkeeping", async () => {
		const fixture = pauseFixture();
		fixture.controller.bind(fixture.session);
		await fixture.controller.toggle(fixture.session);
		await fixture.agent.finishTurn?.({ message: { stopReason: "stop" }, toolResults: [{}] } as never, new AbortController().signal);

		await fixture.controller.toggle(fixture.session);
		assert.equal(fixture.continueCalls(), 0);

		await fixture.internals._handlePostAgentRun();
		await fixture.internals._runBeforeSettleBoundary();
		const resume = fixture.controller.toggle(fixture.session);
		await Promise.resolve();
		assert.equal(fixture.continueCalls(), 0);
		await fixture.internals._emitAgentSettled();
		await resume;
		assert.equal(fixture.continueCalls(), 1);
	});

	it("does not continue a session replaced while waiting for it to settle", async () => {
		const fixture = pauseFixture();
		fixture.controller.bind(fixture.session);
		await fixture.controller.toggle(fixture.session);
		await fixture.agent.finishTurn?.({ message: { stopReason: "stop" }, toolResults: [{}] } as never, new AbortController().signal);
		await fixture.internals._handlePostAgentRun();
		await fixture.internals._runBeforeSettleBoundary();

		const resume = fixture.controller.toggle(fixture.session);
		fixture.setCurrentSession(false);
		await fixture.internals._emitAgentSettled();
		await resume;

		assert.equal(fixture.continueCalls(), 0);
		assert.equal(fixture.controller.state(fixture.session), "paused");
		assert.ok(fixture.toasts.some((toast) => toast.kind === "error" && toast.message.includes("session changed")));
	});

	it("keeps the paused state when continuation fails", async () => {
		const fixture = pauseFixture({ continueError: new Error("resume failed") });
		fixture.controller.bind(fixture.session);
		await fixture.controller.toggle(fixture.session);
		await fixture.agent.finishTurn?.({ message: { stopReason: "stop" }, toolResults: [{}] } as never, new AbortController().signal);
		await fixture.internals._handlePostAgentRun();
		await fixture.internals._runBeforeSettleBoundary();
		await fixture.internals._emitAgentSettled();

		await fixture.controller.toggle(fixture.session);

		assert.equal(fixture.controller.state(fixture.session), "paused");
		assert.ok(fixture.toasts.some((toast) => toast.kind === "error" && toast.message.includes("resume failed")));
	});

	it("does not convert cancellation into a pause", async () => {
		const fixture = pauseFixture();
		fixture.controller.bind(fixture.session);
		await fixture.controller.toggle(fixture.session);
		fixture.internals._agentRunAbortRequested = true;

		await fixture.internals._handlePostAgentRun();

		assert.equal(fixture.controller.state(fixture.session), "idle");
		assert.equal(await fixture.internals._runBeforeSettleBoundary(), false);
	});
});

function pauseFixture(options: { existingFinish?: "continue" | "end"; continueError?: Error; lastMessageRole?: "assistant" | "toolResult"; hasQueuedMessages?: boolean; postRunResult?: boolean } = {}) {
	let continueCalls = 0;
	let postRunCalls = 0;
	let settledCalls = 0;
	let currentSession = true;
	const listeners: Array<(event: never) => void> = [];
	const toasts: Array<{ message: string; kind: string }> = [];
	const agent = {
		state: {
			isStreaming: true,
			messages: [{ role: options.lastMessageRole ?? "toolResult" }],
		},
		finishTurn: options.existingFinish === undefined
			? undefined
			: async () => ({ action: options.existingFinish! }),
		continue: async () => {
			continueCalls += 1;
			if (options.continueError) throw options.continueError;
		},
		hasQueuedMessages: () => options.hasQueuedMessages ?? false,
	} as unknown as AgentSession["agent"];
	const internals = {
		agent,
		get isStreaming() { return this._isAgentRunActive; },
		subscribe: (listener: (event: never) => void) => {
			listeners.push(listener);
			return () => {};
		},
		_isAgentRunActive: false,
		_agentRunAbortRequested: false,
		_runSystemPromptOptions: undefined,
		_handlePostAgentRun: async () => {
			postRunCalls += 1;
			return options.postRunResult ?? false;
		},
		_runBeforeSettleBoundary: async () => options.hasQueuedMessages ?? false,
		_flushPendingBashMessages: () => {},
		_flushPendingCustomMessages: () => {},
		_emitAgentSettled: async () => {
			settledCalls += 1;
			internals._isAgentRunActive = false;
			for (const listener of listeners) listener({ type: "agent_settled" } as never);
		},
	};
	const session = internals as unknown as AgentSession;
	const controller = new AgentPauseController({
		showToast: (message, kind) => toasts.push({ message, kind }),
		render: () => {},
		isCurrentSession: () => currentSession,
	});

	return {
		agent,
		controller,
		internals,
		session,
		toasts,
		continueCalls: () => continueCalls,
		postRunCalls: () => postRunCalls,
		settledCalls: () => settledCalls,
		setCurrentSession: (current: boolean) => { currentSession = current; },
	};
}
