import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentSession, AgentSessionEvent, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import {
	AppSessionLifecycleController,
	type AppSessionLifecycleHost,
} from "../src/app/session/session-lifecycle-controller.js";

describe("AppSessionLifecycleController", () => {
	it("defers background extension binding until the next event-loop turn", async () => {
		let bindStarted = false;
		let finishBind: () => void = () => {};
		const bindCompletion = new Promise<void>((resolve) => {
			finishBind = resolve;
		});
		const { controller, runtime } = createController(() => {
			bindStarted = true;
			return bindCompletion;
		});

		await controller.bindCurrentSession({ awaitExtensions: false });

		assert.equal(bindStarted, false);
		const extensionsReady = controller.awaitCurrentSessionExtensions(runtime);
		let waitFinished = false;
		void extensionsReady.then(() => {
			waitFinished = true;
		});

		await nextEventLoopTurn();

		assert.equal(bindStarted, true);
		assert.equal(waitFinished, false);
		finishBind();
		await extensionsReady;
		assert.equal(waitFinished, true);
	});

	it("starts extension binding immediately when the caller awaits it", async () => {
		let bindStarted = false;
		let finishBind: () => void = () => {};
		const bindCompletion = new Promise<void>((resolve) => {
			finishBind = resolve;
		});
		const { controller } = createController(() => {
			bindStarted = true;
			return bindCompletion;
		});

		let bindFinished = false;
		const binding = controller.bindCurrentSession().then(() => {
			bindFinished = true;
		});

		assert.equal(bindStarted, true);
		assert.equal(bindFinished, false);
		finishBind();
		await binding;
		assert.equal(bindFinished, true);
	});

	it("does not start a deferred extension bind after session ownership changes", async () => {
		let oldBindCount = 0;
		let newBindCount = 0;
		const oldSession = fakeSession("old", () => {
			oldBindCount += 1;
			return Promise.resolve();
		});
		const newSession = fakeSession("new", () => {
			newBindCount += 1;
			return Promise.resolve();
		});
		const oldRuntime = { session: oldSession } as AgentSessionRuntime;
		const newRuntime = { session: newSession } as AgentSessionRuntime;
		let currentRuntime = oldRuntime;
		const host = lifecycleHost(() => currentRuntime);
		const controller = new AppSessionLifecycleController(host);

		await controller.bindCurrentSession({ awaitExtensions: false });
		currentRuntime = newRuntime;
		await controller.bindCurrentSession({ awaitExtensions: false });
		await nextEventLoopTurn();

		assert.equal(oldBindCount, 0);
		assert.equal(newBindCount, 1);
	});

	it("ignores late events from a stale session subscription", async () => {
		let oldListener: ((event: AgentSessionEvent) => void) | undefined;
		let newListener: ((event: AgentSessionEvent) => void) | undefined;
		const oldSession = fakeSession("old", async () => {}, (listener) => {
			oldListener = listener;
		});
		const newSession = fakeSession("new", async () => {}, (listener) => {
			newListener = listener;
		});
		const runtime = { session: oldSession } as AgentSessionRuntime;
		const handledSessionIds: string[] = [];
		const host = lifecycleHost(() => runtime, {
			handleSessionEvent: () => {
				handledSessionIds.push(runtime.session.sessionId);
			},
		});
		const controller = new AppSessionLifecycleController(host);

		await controller.bindCurrentSession();
		(runtime as unknown as { session: AgentSession }).session = newSession;
		await controller.bindCurrentSession();
		oldListener?.({ type: "session_info_changed" } as AgentSessionEvent);
		newListener?.({ type: "session_info_changed" } as AgentSessionEvent);

		assert.deepEqual(handledSessionIds, ["new"]);
	});

	it("cancels stale replacement history before applying completion side effects", async () => {
		let finishHistory: (completed: boolean) => void = () => {};
		const historyCompletion = new Promise<boolean>((resolve) => {
			finishHistory = resolve;
		});
		let cancellationCheck: (() => boolean) | undefined;
		let metadataSyncCount = 0;
		let statusUpdateCount = 0;
		const oldSession = fakeSession("old", async () => {});
		const newSession = fakeSession("new", async () => {});
		const runtime = { session: oldSession } as AgentSessionRuntime;
		const host = lifecycleHost(() => runtime, {
			entries: [],
			loadSessionHistoryEntriesAsync: async (options) => {
				cancellationCheck = options.isCancelled;
				return await historyCompletion;
			},
			syncUserSessionEntryMetadata: () => {
				metadataSyncCount += 1;
			},
			setSessionStatus: () => {
				statusUpdateCount += 1;
			},
		});
		const controller = new AppSessionLifecycleController(host);
		await controller.bindCurrentSession();

		controller.afterSessionReplacement("old history loaded");
		(runtime as unknown as { session: AgentSession }).session = newSession;
		await controller.bindCurrentSession({ awaitExtensions: false });

		assert.equal(cancellationCheck?.(), true);
		finishHistory(true);
		await nextEventLoopTurn();

		assert.equal(metadataSyncCount, 0);
		assert.equal(statusUpdateCount, 0);
		assert.equal(host.entries.some((entry) => "text" in entry && entry.text === "old history loaded"), false);
	});
});

function createController(bindExtensions: () => Promise<void>): {
	controller: AppSessionLifecycleController;
	runtime: AgentSessionRuntime;
} {
	const session = {
		sessionId: "test-session",
		sessionFile: "/tmp/test-session.jsonl",
		subscribe: () => () => {},
		bindExtensions,
	} as unknown as AgentSession;
	const runtime = { session } as AgentSessionRuntime;
	const host = {
		runtime: () => runtime,
		handleSessionEvent: () => {},
		closeSdkMenuForBind: () => {},
		clearExtensionWidgets: () => {},
		createExtensionUIContext: () => ({}),
		createExtensionCommandContextActions: () => ({}),
		extensionShutdownHandler: () => () => {},
		handleExtensionError: () => {},
		isRunning: () => true,
		addEntry: () => {},
		showToast: () => {},
		render: () => {},
	} as unknown as AppSessionLifecycleHost;
	return { controller: new AppSessionLifecycleController(host), runtime };
}

async function nextEventLoopTurn(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function fakeSession(
	sessionId: string,
	bindExtensions: () => Promise<void>,
	onSubscribe: (listener: (event: AgentSessionEvent) => void) => void = () => {},
): AgentSession {
	return {
		sessionId,
		sessionFile: `/tmp/${sessionId}.jsonl`,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			onSubscribe(listener);
			return () => {};
		},
		bindExtensions,
	} as unknown as AgentSession;
}

function lifecycleHost(
	runtime: () => AgentSessionRuntime,
	overrides: Partial<AppSessionLifecycleHost> = {},
): AppSessionLifecycleHost {
	return {
		entries: [],
		runtime,
		handleSessionEvent: () => {},
		closeSdkMenuForBind: () => {},
		clearExtensionWidgets: () => {},
		createExtensionUIContext: () => ({} as never),
		createExtensionCommandContextActions: () => ({} as never),
		extensionShutdownHandler: () => () => {},
		handleExtensionError: () => {},
		isRunning: () => true,
		addEntry: () => {},
		showToast: () => {},
		setSessionStatus: () => {},
		setSessionActivity: () => {},
		sessionEventsReset: () => {},
		resetSubagentsWidget: () => {},
		resetTodoWidget: () => {},
		conversationViewportClear: () => {},
		queuedMessagesReset: () => {},
		resetConversationMenuState: () => {},
		clearMouseRenderState: () => {},
		scrollReset: () => {},
		loadSessionHistoryEntriesAsync: async () => true,
		syncUserSessionEntryMetadata: () => {},
		render: () => {},
		...overrides,
	} as AppSessionLifecycleHost;
}
