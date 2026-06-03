import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

import { AppQueuedMessageController, type AppQueuedMessageControllerHost } from "../src/app/session/queued-message-controller.js";

describe("AppQueuedMessageController", () => {
	it("restores and clears queued messages before aborting", () => {
		const sdkQueue = {
			steering: ["queued steer"],
			followUp: ["queued follow"],
		};
		const session = fakeSession(sdkQueue);
		const state = createHostState("draft");
		const controller = new AppQueuedMessageController(createHost(session, state));

		controller.deferredUserMessages.push({
			id: "deferred-1",
			promptText: "deferred [Image 1] ",
			displayText: "deferred [Image 1]",
			images: [{ type: "image", data: "image-data", mimeType: "image/png" }],
		});

		const restored = controller.restoreQueuedMessagesToEditorForAbort();

		assert.equal(restored, 3);
		assert.deepEqual(sdkQueue, { steering: [], followUp: [] });
		assert.equal(controller.deferredUserMessages.length, 0);
		assert.equal(state.input, "queued steer\n\ndeferred\n\nqueued follow\n\ndraft\n[Image 1] ");
		assert.deepEqual(state.images, [{ data: "image-data", mimeType: "image/png" }]);
		assert.equal(state.setSessionStatusCalls, 1);
	});

	it("aborts the active stream before immediately sending an SDK queued message", async () => {
		const sdkQueue = {
			steering: ["keep before", "send now", "keep after"],
			followUp: ["follow later"],
		};
		const calls: string[] = [];
		const session = fakeSession(sdkQueue, { calls, isStreaming: true });
		const state = createHostState("");
		state.visibleEntries = [
			{ id: "queued-selected", kind: "queued", mode: "steering", text: "send now", queueSource: "sdk-steering", queueIndex: 1 },
		];
		const controller = new AppQueuedMessageController(createHost(session, state));

		await controller.sendQueuedMessageImmediately("queued-selected");

		assert.deepEqual(calls, [
			"clearQueue",
			"abort",
			"steer:keep before",
			"steer:keep after",
			"followUp:follow later",
			"prompt:send now",
		]);
		assert.deepEqual(sdkQueue, { steering: ["keep before", "keep after"], followUp: ["follow later"] });
		assert.equal(state.abortedEntries, 1);
	});

	it("queues submitted messages during streaming for manual send", async () => {
		const sdkQueue = { steering: [], followUp: [] };
		const calls: string[] = [];
		const session = fakeSession(sdkQueue, { calls, isStreaming: true });
		const state = createHostState("");
		const controller = new AppQueuedMessageController(createHost(session, state));

		await controller.submitUserMessage(controller.createSubmittedUserMessage("send later", "send later", []));

		assert.deepEqual(calls, []);
		assert.equal(controller.deferredUserMessages.length, 1);
		assert.deepEqual(state.toasts, ["info:Message queued; send it from the queue menu or status button"]);
		assert.equal(state.deferredChangeCount, 1);
	});

	it("does not auto-flush deferred messages after an immediate send", async () => {
		const sdkQueue = { steering: ["send now"], followUp: [] };
		const calls: string[] = [];
		let controller: AppQueuedMessageController | undefined;
		const session = fakeSession(sdkQueue, {
			calls,
			isStreaming: true,
			onAbort: async () => {
				await controller?.flushDeferredUserMessages();
			},
		});
		const state = createHostState("");
		state.visibleEntries = [
			{ id: "queued-selected", kind: "queued", mode: "steering", text: "send now", queueSource: "sdk-steering", queueIndex: 0 },
		];
		controller = new AppQueuedMessageController(createHost(session, state));
		controller.deferredUserMessages.push({ id: "deferred-1", promptText: "deferred later", displayText: "deferred later", images: [] });

		await controller.sendQueuedMessageImmediately("queued-selected");

		assert.deepEqual(calls, ["clearQueue", "abort", "prompt:send now"]);
		assert.equal(controller.deferredUserMessages.length, 1);
	});

	it("flushes all deferred messages only when explicitly requested", async () => {
		const sdkQueue = { steering: [], followUp: [] };
		const calls: string[] = [];
		const session = fakeSession(sdkQueue, { calls });
		const state = createHostState("");
		const controller = new AppQueuedMessageController(createHost(session, state));
		controller.deferredUserMessages.push(
			{ id: "deferred-1", promptText: "send first", displayText: "send first", images: [] },
			{ id: "deferred-2", promptText: "send second", displayText: "send second", images: [] },
		);

		await controller.flushDeferredUserMessages();

		assert.deepEqual(calls, ["prompt:send first", "prompt:send second"]);
		assert.equal(controller.deferredUserMessages.length, 0);
		assert.equal(state.deferredChangeCount, 2);
	});

	it("cancels a deferred queued message without touching SDK queues", async () => {
		const sdkQueue = { steering: ["keep steer"], followUp: ["keep follow"] };
		const calls: string[] = [];
		const session = fakeSession(sdkQueue, { calls });
		const state = createHostState("");
		state.visibleEntries = [
			{ id: "deferred-selected", kind: "queued", mode: "steering", text: "deferred send", queueSource: "deferred", queueIndex: 0 },
		];
		const controller = new AppQueuedMessageController(createHost(session, state));
		controller.deferredUserMessages.push({ id: "deferred-1", promptText: "deferred send", displayText: "deferred send", images: [] });

		await controller.cancelQueuedMessage("deferred-selected");

		assert.equal(controller.deferredUserMessages.length, 0);
		assert.deepEqual(sdkQueue, { steering: ["keep steer"], followUp: ["keep follow"] });
		assert.deepEqual(calls, []);
		assert.deepEqual(state.toasts, ["success:Queued message cancelled"]);
		assert.equal(state.deferredChangeCount, 1);
	});

	it("cancels an SDK queued message without removing the rest of the queue", async () => {
		const sdkQueue = { steering: ["keep before", "remove me", "keep after"], followUp: ["follow later"] };
		const calls: string[] = [];
		const session = fakeSession(sdkQueue, { calls });
		const state = createHostState("");
		state.visibleEntries = [
			{ id: "queued-selected", kind: "queued", mode: "steering", text: "remove me", queueSource: "sdk-steering", queueIndex: 1 },
		];
		const controller = new AppQueuedMessageController(createHost(session, state));

		await controller.cancelQueuedMessage("queued-selected");

		assert.deepEqual(sdkQueue, { steering: ["keep before", "keep after"], followUp: ["follow later"] });
		assert.deepEqual(calls, ["clearQueue", "steer:keep before", "steer:keep after", "followUp:follow later"]);
		assert.deepEqual(state.toasts, ["success:Queued message cancelled"]);
	});
});

type QueueState = {
	steering: string[];
	followUp: string[];
};

type HostState = {
	input: string;
	images: Array<{ data: string; mimeType: string }>;
	setSessionStatusCalls: number;
	abortedEntries: number;
	toasts: string[];
	visibleEntries: AppQueuedMessageControllerHost["visibleEntries"] extends () => infer T ? T : never;
	deferredChangeCount: number;
};

function fakeSession(
	queue: QueueState,
	options: { calls?: string[]; isStreaming?: boolean; isCompacting?: boolean; onAbort?: () => Promise<void> } = {},
): AgentSession {
	let isStreaming = options.isStreaming ?? false;
	let isCompacting = options.isCompacting ?? false;
	const calls = options.calls;
	return {
		get isStreaming() {
			return isStreaming;
		},
		get isCompacting() {
			return isCompacting;
		},
		getSteeringMessages: () => queue.steering,
		getFollowUpMessages: () => queue.followUp,
		clearQueue: () => {
			calls?.push("clearQueue");
			const cleared = {
				steering: [...queue.steering],
				followUp: [...queue.followUp],
			};
			queue.steering = [];
			queue.followUp = [];
			return cleared;
		},
		steer: async (text: string) => {
			calls?.push(`steer:${text}`);
			queue.steering.push(text);
		},
		followUp: async (text: string) => {
			calls?.push(`followUp:${text}`);
			queue.followUp.push(text);
		},
		prompt: async (text: string) => {
			calls?.push(`prompt:${text}`);
		},
		abort: async () => {
			calls?.push("abort");
			isStreaming = false;
			await options.onAbort?.();
		},
		abortCompaction: () => {
			calls?.push("abortCompaction");
			isCompacting = false;
		},
	} as unknown as AgentSession;
}

function createHostState(input: string): HostState {
	return { input, images: [], setSessionStatusCalls: 0, abortedEntries: 0, toasts: [], visibleEntries: [], deferredChangeCount: 0 };
}

function createHost(session: AgentSession, state: HostState): AppQueuedMessageControllerHost {
	const runtime = { session } as unknown as AgentSessionRuntime;
	return {
		runtime: () => runtime,
		requireRuntime: () => runtime,
		visibleEntries: () => state.visibleEntries,
		isRunning: () => true,
		render: () => undefined,
		addEntry: () => undefined,
		addSessionAbortedEntry: () => {
			state.abortedEntries += 1;
		},
		setStatus: () => undefined,
		setSessionStatus: () => {
			state.setSessionStatusCalls += 1;
		},
		setSessionActivity: () => undefined,
		showToast: (message, kind) => {
			state.toasts.push(`${kind}:${message}`);
		},
		inputText: () => state.input,
		resetRequestHistoryNavigation: () => undefined,
		clearInput: () => {
			state.input = "";
			state.images = [];
		},
		setInput: (value) => {
			state.input = value;
		},
		insertInput: (value) => {
			state.input += value;
		},
		attachImage: (data, mimeType) => {
			state.images.push({ data, mimeType });
			state.input += `[Image ${state.images.length}] `;
		},
		onDeferredUserMessagesChanged: () => {
			state.deferredChangeCount += 1;
		},
	};
}
