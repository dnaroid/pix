import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { APP_ICONS } from "../src/app/icons.js";
import { AgentPauseController } from "../src/app/session/agent-pause-controller.js";

describe("AgentPauseController", () => {
	it("requests a stop only after a tool-producing turn", async () => {
		const fixture = pauseFixture();
		fixture.controller.bind(fixture.session);

		await fixture.controller.toggle(fixture.session);
		assert.equal(fixture.controller.state(fixture.session), "pause-requested");

		const shouldStop = await fixture.agent.shouldStopAfterTurn?.({ toolResults: [{}] } as never, new AbortController().signal);
		assert.equal(shouldStop, true);
		assert.equal(fixture.controller.state(fixture.session), "pause-requested");
		assert.equal(await fixture.internals._handlePostAgentRun(), false);
		assert.equal(fixture.controller.state(fixture.session), "paused");
		assert.equal(fixture.controller.statusWidgetText(fixture.session), APP_ICONS.play);
		assert.equal(fixture.postRunCalls(), 1);
	});

	it("lets a tool-free final turn finish instead of creating a non-resumable pause", async () => {
		const fixture = pauseFixture({ lastMessageRole: "assistant" });
		fixture.controller.bind(fixture.session);
		await fixture.controller.toggle(fixture.session);

		const shouldStop = await fixture.agent.shouldStopAfterTurn?.({ toolResults: [] } as never, new AbortController().signal);
		await fixture.internals._handlePostAgentRun();

		assert.equal(shouldStop, true);
		assert.equal(fixture.controller.state(fixture.session), "idle");
	});

	it("pauses a tool-free turn when queued work can continue it", async () => {
		const fixture = pauseFixture({ lastMessageRole: "assistant", hasQueuedMessages: true });
		fixture.controller.bind(fixture.session);
		await fixture.controller.toggle(fixture.session);

		await fixture.agent.shouldStopAfterTurn?.({ toolResults: [] } as never, new AbortController().signal);
		await fixture.internals._handlePostAgentRun();

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

	it("preserves an existing stop-after-turn policy", async () => {
		const fixture = pauseFixture({ existingShouldStop: true });
		fixture.controller.bind(fixture.session);
		await fixture.controller.toggle(fixture.session);

		const shouldStop = await fixture.agent.shouldStopAfterTurn?.({ toolResults: [{}] } as never, new AbortController().signal);

		assert.equal(shouldStop, true);
		assert.equal(fixture.controller.state(fixture.session), "idle");
	});

	it("continues through session bookkeeping and returns to idle", async () => {
		const fixture = pauseFixture();
		fixture.controller.bind(fixture.session);
		await fixture.controller.toggle(fixture.session);
		await fixture.agent.shouldStopAfterTurn?.({ toolResults: [{}] } as never, new AbortController().signal);
		await fixture.internals._handlePostAgentRun();
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
		await fixture.agent.shouldStopAfterTurn?.({ toolResults: [{}] } as never, new AbortController().signal);

		await fixture.controller.toggle(fixture.session);
		assert.equal(fixture.continueCalls(), 0);

		await fixture.internals._handlePostAgentRun();
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
		await fixture.agent.shouldStopAfterTurn?.({ toolResults: [{}] } as never, new AbortController().signal);
		await fixture.internals._handlePostAgentRun();

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
		await fixture.agent.shouldStopAfterTurn?.({ toolResults: [{}] } as never, new AbortController().signal);
		await fixture.internals._handlePostAgentRun();
		await fixture.internals._emitAgentSettled();

		await fixture.controller.toggle(fixture.session);

		assert.equal(fixture.controller.state(fixture.session), "paused");
		assert.ok(fixture.toasts.some((toast) => toast.kind === "error" && toast.message.includes("resume failed")));
	});
});

function pauseFixture(options: { existingShouldStop?: boolean; continueError?: Error; lastMessageRole?: "assistant" | "toolResult"; hasQueuedMessages?: boolean; postRunResult?: boolean } = {}) {
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
		shouldStopAfterTurn: options.existingShouldStop === undefined
			? undefined
			: async () => options.existingShouldStop!,
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
		_systemPromptOverride: undefined,
		_handlePostAgentRun: async () => {
			postRunCalls += 1;
			return options.postRunResult ?? false;
		},
		_flushPendingBashMessages: () => {},
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
