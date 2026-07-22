import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentSession, AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
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
