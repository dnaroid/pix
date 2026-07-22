import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PiUiExtendApp } from "../src/app/app.js";
import type { Entry } from "../src/app/types.js";

type TestApp = {
	entries: Entry[];
	superCompactTools: boolean;
	toggleSuperCompactTools(): void;
};

type RenderLifecycleTestApp = {
	running: boolean;
	scheduledRenderTimer: ReturnType<typeof setTimeout> | undefined;
	render(): void;
	scheduleRender(): void;
	showToast(message: string): void;
};

function createApp(): TestApp {
	return new PiUiExtendApp({ cwd: process.cwd(), themeName: "dark", noSession: true }) as unknown as TestApp;
}

function toolEntry(toolName: string, expanded: boolean): Extract<Entry, { kind: "tool" }> {
	return {
		id: `tool-${toolName}`,
		kind: "tool",
		toolCallId: `call-${toolName}`,
		toolName,
		argsText: "",
		output: "body",
		expanded,
		isError: false,
		status: "done",
	};
}

describe("PiUiExtendApp super-compact tool toggle", () => {
	it("restores default-expanded tools when leaving super-compact mode", () => {
		const app = createApp();
		const mutationTool = toolEntry("apply_patch", true);
		const regularTool = toolEntry("read", true);
		app.entries.push(mutationTool, regularTool);

		app.toggleSuperCompactTools();

		assert.equal(app.superCompactTools, true);
		assert.equal(mutationTool.expanded, false);
		assert.equal(regularTool.expanded, false);

		app.toggleSuperCompactTools();

		assert.equal(app.superCompactTools, false);
		assert.equal(mutationTool.expanded, true);
		assert.equal(regularTool.expanded, false);
	});
});

describe("PiUiExtendApp render lifecycle", () => {
	it("does not render after shutdown", () => {
		let renders = 0;
		const app = Object.assign(Object.create(PiUiExtendApp.prototype) as object, {
			running: false,
			scheduledRenderTimer: undefined,
			autocompleteController: { observeInput: () => { throw new Error("should not observe input"); } },
			inputEditor: { contentVersion: 0 },
			lastInputEditorContentVersion: 0,
			scrollController: { scrollToBottom: () => {} },
			renderController: { render: () => { renders += 1; } },
		}) as unknown as RenderLifecycleTestApp;

		app.render();

		assert.equal(renders, 0);
	});

	it("does not create late toasts after shutdown", () => {
		let toasts = 0;
		const app = Object.assign(Object.create(PiUiExtendApp.prototype) as object, {
			running: false,
			toastController: { showToast: () => { toasts += 1; } },
		}) as unknown as RenderLifecycleTestApp;

		app.showToast("late update");

		assert.equal(toasts, 0);
	});

	it("rechecks shutdown state in an already scheduled render", async () => {
		let renders = 0;
		const app = Object.assign(Object.create(PiUiExtendApp.prototype) as object, {
			running: true,
			scheduledRenderTimer: undefined,
			inputEditor: { contentVersion: 0 },
			lastInputEditorContentVersion: 0,
			scrollController: { scrollToBottom: () => {} },
			renderController: { render: () => { renders += 1; } },
		}) as unknown as RenderLifecycleTestApp;

		app.scheduleRender();
		app.running = false;
		await new Promise<void>((resolve) => { setTimeout(resolve, 30); });

		assert.equal(renders, 0);
		assert.equal(app.scheduledRenderTimer, undefined);
	});
});
