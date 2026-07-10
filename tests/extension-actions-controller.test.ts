import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppExtensionActionsController, type AppExtensionActionsHost, type ExtensionErrorLogger } from "../src/app/extensions/extension-actions-controller.js";
import type { Entry } from "../src/app/types.js";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

describe("AppExtensionActionsController", () => {
	it("surfaces extension error source details in the UI and pix log", () => {
		const entries: Entry[] = [];
		const toasts: Array<{ message: string; kind: string }> = [];
		const logs: Array<{ level: string; event: string; details: Record<string, unknown> | undefined }> = [];
		let rendered = false;
		const host = createHost({
			isRunning: () => true,
			addEntry: (entry) => entries.push(entry),
			showToast: (message, kind) => toasts.push({ message, kind }),
			render: () => {
				rendered = true;
			},
		});
		const logger: ExtensionErrorLogger = (level, event, details) => {
			logs.push({ level, event, details });
		};
		const controller = new AppExtensionActionsController(host, logger);

		controller.handleExtensionError({
			extensionPath: "/Users/test/.pi/agent/extensions/pi-tools-suite",
			event: "send_user_message",
			error: "Agent is already processing. Wait for completion before continuing.",
			stack: "Error: boom",
		});

		assert.equal(entries.length, 1);
		assert.equal(entries[0]?.kind, "error");
		assert.match(entries[0]?.text ?? "", /Extension send_user_message failed \[pi-tools-suite\]/u);
		assert.match(entries[0]?.text ?? "", /\/Users\/test\/\.pi\/agent\/extensions\/pi-tools-suite/u);
		assert.deepEqual(toasts, [{ message: "Extension send_user_message failed", kind: "error" }]);
		assert.equal(rendered, true);
		assert.deepEqual(logs, [
			{
				level: "error",
				event: "extension:error",
				details: {
					event: "send_user_message",
					error: "Agent is already processing. Wait for completion before continuing.",
					extensionPath: "/Users/test/.pi/agent/extensions/pi-tools-suite",
					extensionName: "pi-tools-suite",
					stack: "Error: boom",
				},
			},
		]);
	});

	it("handles runtime extension errors without a source path", () => {
		const entries: Entry[] = [];
		const logs: Array<{ level: string; event: string; details: Record<string, unknown> | undefined }> = [];
		const host = createHost({
			isRunning: () => false,
			addEntry: (entry) => entries.push(entry),
		});
		const logger: ExtensionErrorLogger = (level, event, details) => {
			logs.push({ level, event, details });
		};
		const controller = new AppExtensionActionsController(host, logger);

		controller.handleExtensionError({ extensionPath: "", event: "send_user_message", error: "Agent is already processing." });

		assert.equal(entries[0]?.kind, "error");
		assert.equal(entries[0]?.text, "Extension send_user_message failed: Agent is already processing.");
		assert.deepEqual(logs, [
			{
				level: "error",
				event: "extension:error",
				details: { event: "send_user_message", error: "Agent is already processing." },
			},
		]);
	});

	it("delegates waitForIdle to the SDK session so settled handlers are included", async () => {
		let waitCalls = 0;
		let resolveIdle!: () => void;
		const idle = new Promise<void>((resolve) => {
			resolveIdle = resolve;
		});
		const runtime = {
			session: {
				waitForIdle: () => {
					waitCalls += 1;
					return idle;
				},
			},
		} as unknown as AgentSessionRuntime;
		const controller = new AppExtensionActionsController(createHost({}));
		let completed = false;
		const waiting = controller.waitForSessionIdle(runtime).then(() => {
			completed = true;
		});

		await Promise.resolve();
		assert.equal(waitCalls, 1);
		assert.equal(completed, false);

		resolveIdle();
		await waiting;
		assert.equal(completed, true);
	});
});

function createHost(overrides: Partial<AppExtensionActionsHost>): AppExtensionActionsHost {
	return {
		isRunning: () => false,
		getInput: () => "",
		setInput: () => undefined,
		awaitCurrentSessionExtensions: async () => undefined,
		resetSessionView: () => undefined,
		loadSessionHistory: () => undefined,
		afterSessionReplacement: () => undefined,
		addEntry: () => undefined,
		setStatus: () => undefined,
		setSessionStatus: () => undefined,
		showToast: () => undefined,
		render: () => undefined,
		...overrides,
	};
}
