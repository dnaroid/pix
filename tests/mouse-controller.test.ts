import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";

import {
	AppMouseController,
	screenSelectionLineText,
	type AppMouseControllerHost,
	type InputFrameCopyRows,
} from "../src/app/screen/mouse-controller.js";
import type { AppCommandController } from "../src/app/commands/command-controller.js";
import type { EditorLayoutRenderer } from "../src/app/rendering/editor-layout-renderer.js";
import type { AppPopupActionController } from "../src/app/popup/popup-action-controller.js";
import type { AppPopupMenuController } from "../src/app/popup/popup-menu-controller.js";
import type { AppScrollController } from "../src/app/screen/scroll-controller.js";
import { APP_ICONS } from "../src/app/icons.js";
import { THEMES } from "../src/theme.js";

describe("AppMouseController", () => {
	it("shows detailed DCP stats as a dialog toast when context status is clicked", async () => {
		let toast: { message: string; kind: string; variant?: string; durationMs?: number; action?: { label: string; onSelect: () => void } } | undefined;
		const commands: Array<[string, string]> = [];
		const session = {
			model: { provider: "fixture", id: "model", contextWindow: 1000 },
			getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
			sessionManager: { getBranch: () => [] },
			isStreaming: false,
			isCompacting: false,
		} as never;
		const controller = new AppMouseController(
			fakeHost({
				runtimeSession: () => session,
				showToast: (message, kind, options) => { toast = { message, kind, variant: options?.variant, durationMs: options?.durationMs, action: options?.action }; },
			}),
			fakePopupMenus(),
			fakePopupActions({
				resourceSlashCommandAvailable: () => true,
				runResourceSlashCommandFromUi: async (name, args) => { commands.push([name, args]); return true; },
			}),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.statusContextTarget = { row: 5, startColumn: 1, endColumn: 6 };

		controller.handleMouse({ button: 0, x: 2, y: 5, released: true });
		await delay(0);

		assert.equal(toast?.kind, "info");
		const message = (toast?.message ?? "").replace(/\x1b\[[\d;:]*m/gu, "");
		assert.match(message, /DCP session statistics/);
		assert.match(message, /Context\s+10% · 100 \/ 1K tokens/);
		assert.match(message, /Occupied ~100/);
		assert.match(message, /Free ~900/);
		assert.match(message, /Measured gain unknown/);
		assert.equal(toast?.variant, "dialog");
		assert.equal(toast?.durationMs, undefined);
		assert.equal(toast?.action?.label, "Compress");
		toast?.action?.onSelect();
		await delay(0);
		assert.deepEqual(commands, [["dcp", "compress"]]);
	});

	it("suppresses a DCP dialog when its branch or model owner changes during the read", async () => {
		const completions: Array<(branch: readonly unknown[]) => void> = [];
		let leafId = "leaf-a";
		const session = {
			model: { provider: "fixture", id: "model", contextWindow: 1000 },
			getContextUsage: () => ({ tokens: 100, contextWindow: 1000 }),
			sessionManager: {
				getSessionId: () => "session-a",
				getLeafId: () => leafId,
				readFullBranchEntries: () => new Promise<readonly unknown[]>((resolve) => { completions.push(resolve); }),
			},
		} as never;
		const shown: string[] = [];
		const controller = new AppMouseController(
			fakeHost({ runtimeSession: () => session, showToast: (message) => { shown.push(message); } }),
			fakePopupMenus(), fakePopupActions(), fakeScrollController(), fakeCommandController(),
		);
		controller.statusContextTarget = { row: 5, startColumn: 1, endColumn: 6 };

		controller.handleMouse({ button: 0, x: 2, y: 5, released: true });
		leafId = "leaf-b";
		completions.shift()?.([]);
		await delay(0);

		controller.handleMouse({ button: 0, x: 2, y: 5, released: true });
		(session as { model: unknown }).model = { provider: "fixture", id: "replacement", contextWindow: 1000 };
		completions.shift()?.([]);
		await delay(0);

		assert.deepEqual(shown, []);
	});

	it("suppresses a DCP dialog after an A→B→A tab lifecycle while its read is pending", async () => {
		let complete: ((branch: readonly unknown[]) => void) | undefined;
		let lifecycleGeneration = 1;
		const session = {
			model: { provider: "fixture", id: "model", contextWindow: 1000 },
			getContextUsage: () => ({ tokens: 100, contextWindow: 1000 }),
			sessionManager: {
				getSessionId: () => "session-a",
				getLeafId: () => "leaf-a",
				readFullBranchEntries: () => new Promise<readonly unknown[]>((resolve) => { complete = resolve; }),
			},
		} as never;
		const shown: string[] = [];
		const controller = new AppMouseController(
			fakeHost({
				runtimeSession: () => session,
				tabsLifecycleGeneration: () => lifecycleGeneration,
				showToast: (message) => { shown.push(message); },
			}),
			fakePopupMenus(), fakePopupActions(), fakeScrollController(), fakeCommandController(),
		);
		controller.statusContextTarget = { row: 5, startColumn: 1, endColumn: 6 };

		controller.handleMouse({ button: 0, x: 2, y: 5, released: true });
		lifecycleGeneration += 2;
		complete?.([]);
		await delay(0);

		assert.deepEqual(shown, []);
	});

	it("shows only the newest DCP dialog when deferred clicks finish out of order", async () => {
		const completions: Array<(branch: readonly unknown[]) => void> = [];
		const session = {
			model: { provider: "fixture", id: "model", contextWindow: 1000 },
			getContextUsage: () => ({ tokens: 100, contextWindow: 1000 }),
			sessionManager: {
				getSessionId: () => "session-a",
				getLeafId: () => "leaf-a",
				readFullBranchEntries: () => new Promise<readonly unknown[]>((resolve) => { completions.push(resolve); }),
			},
		} as never;
		const shown: string[] = [];
		const controller = new AppMouseController(
			fakeHost({ runtimeSession: () => session, showToast: (message) => { shown.push(message); } }),
			fakePopupMenus(), fakePopupActions(), fakeScrollController(), fakeCommandController(),
		);
		controller.statusContextTarget = { row: 5, startColumn: 1, endColumn: 6 };

		controller.handleMouse({ button: 0, x: 2, y: 5, released: true });
		controller.handleMouse({ button: 0, x: 2, y: 5, released: true });
		assert.equal(completions.length, 2);
		completions[1]?.([]);
		await delay(0);
		completions[0]?.([]);
		await delay(0);

		assert.equal(shown.length, 1);
	});

	it("dismisses dialog toasts only from their close target", () => {
		const dismissed: number[] = [];
		const controller = new AppMouseController(
			fakeHost({ dismissToast: (toastId) => { dismissed.push(toastId); } }),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.renderedTargets.set(2, { kind: "toast", id: 7, action: "body", startColumn: 20, endColumn: 50 });
		controller.renderedTargets.set(3, { kind: "toast", id: 7, action: "close", startColumn: 45, endColumn: 48 });

		controller.handleMouse({ button: 0, x: 24, y: 2, released: true });
		controller.handleMouse({ button: 0, x: 44, y: 3, released: true });
		controller.handleMouse({ button: 0, x: 46, y: 3, released: true });

		assert.deepEqual(dismissed, [7]);
	});

	it("activates a toast action without copying or dismissing its error body", () => {
		const activated: number[] = [];
		const dismissed: number[] = [];
		const copied: string[] = [];
		const controller = new AppMouseController(
			fakeHost({
				toastEntry: () => ({ id: 7, message: "Retry failed", kind: "error", createdAt: 0 }),
				activateToastAction: (toastId) => { activated.push(toastId); return true; },
				dismissToast: (toastId) => { dismissed.push(toastId); },
				copyTextToClipboard: (text) => { copied.push(text); },
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.renderedTargets.set(2, { kind: "toast", id: 7, action: "action", startColumn: 30, endColumn: 37 });

		controller.handleMouse({ button: 0, x: 29, y: 2, released: true });
		controller.handleMouse({ button: 0, x: 32, y: 2, released: true });

		assert.deepEqual(activated, [7]);
		assert.deepEqual(dismissed, []);
		assert.deepEqual(copied, []);
	});

	it("keeps compact error-body clicks as copy actions", () => {
		const dismissed: number[] = [];
		const copied: string[] = [];
		const controller = new AppMouseController(
			fakeHost({
				toastEntry: () => ({ id: 7, message: "Retry failed", kind: "error", createdAt: 0 }),
				dismissToast: (toastId) => { dismissed.push(toastId); },
				copyTextToClipboard: (text) => { copied.push(text); },
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.renderedTargets.set(2, { kind: "toast", id: 7, action: "toast", startColumn: 20, endColumn: 40 });

		controller.handleMouse({ button: 0, x: 24, y: 2, released: true });

		assert.deepEqual(copied, ["Retry failed"]);
		assert.deepEqual(dismissed, [7]);
	});

	it("clears model visibility from the management action row", () => {
		let clears = 0;
		const controller = new AppMouseController(
			fakeHost(),
			fakePopupMenus(),
			fakePopupActions({ clearVisibleModels: () => { clears += 1; return true; } }),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.renderedTargets.set(2, { kind: "model-visibility-clear" });

		controller.handleMouse({ button: 0, x: 2, y: 2, released: true });

		assert.equal(clears, 1);
	});

	it("sets the staged model default from the model picker action row", () => {
		let defaults = 0;
		const controller = new AppMouseController(
			fakeHost(),
			fakePopupMenus(),
			fakePopupActions({ setSelectedModelDefault: () => { defaults += 1; return true; } }),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.renderedTargets.set(2, { kind: "model-default-set" });

		controller.handleMouse({ button: 0, x: 2, y: 2, released: true });

		assert.equal(defaults, 1);
	});

	it("opens the session menu when clicking the active tab", () => {
		let resumeOptions: unknown;
		let switchCount = 0;
		const controller = new AppMouseController(
			fakeHost({ switchToTab: () => { switchCount += 1; } }),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController({ runResumeCommand: (options) => { resumeOptions = options; return Promise.resolve(); } }),
		);
		controller.tabLineTargets.push({ kind: "tab", tabId: "tab-1", active: true, row: 1, startColumn: 1, endColumn: 8 });

		controller.handleMouse({ button: 0, x: 2, y: 1, released: false });
		controller.handleMouse({ button: 0, x: 2, y: 1, released: true });

		assert.deepEqual(resumeOptions, { preserveStatus: true, placement: "under-tabs" });
		assert.equal(switchCount, 0);
	});

	it("flashes clickable targets on press before running the release action", () => {
		let resumeOptions: unknown;
		const controller = new AppMouseController(
			fakeHost(),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController({ runResumeCommand: (options) => { resumeOptions = options; return Promise.resolve(); } }),
		);
		controller.renderedRowTexts.set(1, "tab one");
		controller.tabLineTargets.push({ kind: "tab", tabId: "tab-1", active: true, row: 1, startColumn: 1, endColumn: 8 });

		controller.handleMouse({ button: 0, x: 2, y: 1, released: false });

		assert.deepEqual(controller.activeClickFlash(), { y: 1, startColumn: 1, endColumn: 8, text: "tab one" });
		assert.equal(resumeOptions, undefined);

		controller.handleMouse({ button: 0, x: 2, y: 1, released: true });

		assert.deepEqual(resumeOptions, { preserveStatus: true, placement: "under-tabs" });
	});

	it("switches tabs when clicking an inactive tab", () => {
		let resumeCount = 0;
		let switchedTabId: string | undefined;
		const controller = new AppMouseController(
			fakeHost({ switchToTab: (tabId) => { switchedTabId = tabId; } }),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController({ runResumeCommand: () => { resumeCount += 1; return Promise.resolve(); } }),
		);
		controller.tabLineTargets.push({ kind: "tab", tabId: "tab-2", active: false, row: 1, startColumn: 1, endColumn: 8 });

		controller.handleMouse({ button: 0, x: 2, y: 1, released: false });
		controller.handleMouse({ button: 0, x: 2, y: 1, released: true });

		assert.equal(switchedTabId, "tab-2");
		assert.equal(resumeCount, 0);
	});

	it("opens the collapsed new-tab button in the last column", () => {
		let newTabCount = 0;
		const controller = new AppMouseController(
			fakeHost({ openNewTab: () => { newTabCount += 1; } }),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.tabLineTargets.push({ kind: "new-tab", row: 1, startColumn: 10, endColumn: 11 });

		controller.handleMouse({ button: 0, x: 10, y: 1, released: false });
		controller.handleMouse({ button: 0, x: 10, y: 1, released: true });

		assert.equal(newTabCount, 1);
	});

	it("shows token-only model-level session usage, including subagent calls, when clicking Usage", async () => {
		let toast: { message: string; kind: string; variant?: string } | undefined;
		const session = {
			sessionManager: {
				getSessionId: () => "session-usage",
				getEntries: () => [
					{
						type: "message",
						message: {
							role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol",
							usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 150, cost: { total: 0.05 } },
						},
					},
					{
						type: "usage", kind: "async-subagent", provider: "anthropic", model: "claude-sonnet",
						usage: { input: 200, output: 40, cacheRead: 10, cacheWrite: 0, totalTokens: 250, cost: { total: 0.15 } },
					},
				],
			},
		} as never;
		const controller = new AppMouseController(
			fakeHost({
				runtimeSession: () => session,
				modelColors: () => ({ rules: { "openai-codex/*": "modelOpenAI", "anthropic/*": "warning" } }),
				showToast: (message, kind, options) => { toast = { message, kind, variant: options?.variant }; },
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.statusModelUsageTarget = { row: 5, startColumn: 12, endColumn: 32 };

		controller.handleMouse({ button: 0, x: 18, y: 5, released: false });
		controller.handleMouse({ button: 0, x: 18, y: 5, released: true });
		await delay(0);

		assert.equal(toast?.kind, "info");
		assert.equal(toast?.variant, "dialog");
		const plain = (toast?.message ?? "").replace(/\x1b\[[\d;:]*m/gu, "");
		assert.match(plain, /Session usage\n400 tokens/);
		assert.match(plain, /anthropic\n\s+claude-sonnet\s+250/);
		assert.match(plain, /openai-codex\n\s+gpt-5\.6-sol\s+150/);
		assert.doesNotMatch(plain, /\$/);
		assert.doesNotMatch(plain, /agents|of session|quota|remaining|used/i);
		assert.match(toast?.message ?? "", /\x1b\[[\d;]*38;2;/u);
	});

	it("queues the editor input when clicking the draft queue status button", () => {
		let queueCount = 0;
		const controller = new AppMouseController(
			fakeHost({ queueInputFromStatus: () => { queueCount += 1; } }),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.statusDraftQueueTarget = { row: 5, startColumn: 1, endColumn: 3 };

		controller.handleMouse({ button: 0, x: 2, y: 5, released: false });
		controller.handleMouse({ button: 0, x: 2, y: 5, released: true });

		assert.equal(queueCount, 1);
	});

	it("pastes the Pix-internal clipboard when clicking its status button", () => {
		let pasteCount = 0;
		const controller = new AppMouseController(
			fakeHost({ pasteInternalClipboard: () => { pasteCount += 1; } }),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.statusInternalClipboardTarget = { row: 5, startColumn: 1, endColumn: 2 };

		controller.handleMouse({ button: 0, x: 1, y: 5, released: false });

		assert.equal(pasteCount, 1);
	});

	it("handles input-border status buttons on press before screen selection", () => {
		let queueCount = 0;
		const controller = new AppMouseController(
			fakeHost({ queueInputFromStatus: () => { queueCount += 1; } }),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.statusDraftQueueTarget = { row: 5, startColumn: 1, endColumn: 3 };

		controller.handleMouse({ button: 0, x: 2, y: 5, released: false });
		controller.handleMouse({ button: 3, x: 2, y: 5, released: true });

		assert.equal(queueCount, 1);
		assert.equal(controller.mouseSelection, undefined);
	});

	it("does not queue editor input when clicking outside the draft queue status button", () => {
		let queueCount = 0;
		const controller = new AppMouseController(
			fakeHost({ queueInputFromStatus: () => { queueCount += 1; } }),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.statusDraftQueueTarget = { row: 5, startColumn: 1, endColumn: 3 };

		controller.handleMouse({ button: 0, x: 4, y: 5, released: false });
		controller.handleMouse({ button: 0, x: 4, y: 5, released: true });

		assert.equal(queueCount, 0);
	});

	it("toggles super-compact tools when clicking its status target", () => {
		let toggleCount = 0;
		const controller = new AppMouseController(
			fakeHost({ toggleSuperCompactTools: () => { toggleCount += 1; } }),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.statusCompactToolsTarget = { row: 5, startColumn: 1, endColumn: 2 };

		controller.handleMouse({ button: 0, x: 1, y: 5, released: false });
		controller.handleMouse({ button: 0, x: 1, y: 5, released: true });

		assert.equal(toggleCount, 1);
	});

	it("toggles terminal bell notifications when clicking its status target", () => {
		let toggleCount = 0;
		const controller = new AppMouseController(
			fakeHost({ toggleTerminalBellSound: () => { toggleCount += 1; } }),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.statusTerminalBellSoundTarget = { row: 5, startColumn: 1, endColumn: 2 };

		controller.handleMouse({ button: 0, x: 1, y: 5, released: false });
		controller.handleMouse({ button: 0, x: 1, y: 5, released: true });

		assert.equal(toggleCount, 1);
	});

	it("toggles agent pause when clicking its status target", () => {
		let toggleCount = 0;
		const controller = new AppMouseController(
			fakeHost({ toggleAgentPause: () => { toggleCount += 1; } }),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.statusAgentPauseTarget = { row: 5, startColumn: 1, endColumn: 2 };

		controller.handleMouse({ button: 0, x: 1, y: 5, released: false });
		controller.handleMouse({ button: 0, x: 1, y: 5, released: true });

		assert.equal(toggleCount, 1);
	});

	it("toggles all thinking expansion when clicking its status target", () => {
		let toggleCount = 0;
		const controller = new AppMouseController(
			fakeHost({ toggleAllThinkingExpanded: () => { toggleCount += 1; } }),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.statusThinkingExpandTarget = { row: 5, startColumn: 1, endColumn: 2 };

		controller.handleMouse({ button: 0, x: 1, y: 5, released: false });
		controller.handleMouse({ button: 0, x: 1, y: 5, released: true });

		assert.equal(toggleCount, 1);
	});

	it("toggles tool rows only from header text or the first gutter column", () => {
		const entry = { id: "tool-1", kind: "tool", expanded: false } as never;
		let touchCount = 0;
		const controller = new AppMouseController(
			fakeHost({
				findEntry: () => entry,
				touchEntry: () => { touchCount += 1; },
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.renderedTargets.set(2, { kind: "tool", id: "tool-1" });
		controller.renderedRowTexts.set(2, `${APP_ICONS.checkCircle} read   `);
		controller.renderedTargets.set(3, { kind: "tool", id: "tool-1" });
		controller.renderedRowTexts.set(3, `${APP_ICONS.toolBodyGutter} body`);

		controller.handleMouse({ button: 0, x: 2, y: 2, released: true });
		controller.handleMouse({ button: 0, x: 8, y: 2, released: true });
		controller.handleMouse({ button: 0, x: 2, y: 3, released: true });
		controller.handleMouse({ button: 0, x: 1, y: 3, released: true });

		assert.equal(touchCount, 2);
	});

	it("toggles extension entry renderers through their rendered target", () => {
		const entry = { id: "extension-entry-1", kind: "extension-entry", expanded: false } as never;
		let touchCount = 0;
		const controller = new AppMouseController(
			fakeHost({
				findEntry: () => entry,
				touchEntry: () => { touchCount += 1; },
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.renderedTargets.set(2, { kind: "tool", id: "extension-entry-1" });
		controller.renderedRowTexts.set(2, "extension details");

		controller.handleMouse({ button: 0, x: 2, y: 2, released: true });

		assert.equal((entry as { expanded: boolean }).expanded, true);
		assert.equal(touchCount, 1);
	});

	it("treats tool end and truncated preview markers as gutter-only click targets", () => {
		const entry = { id: "tool-1", kind: "tool", expanded: false } as never;
		let touchCount = 0;
		const controller = new AppMouseController(
			fakeHost({
				findEntry: () => entry,
				touchEntry: () => { touchCount += 1; },
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.renderedTargets.set(2, { kind: "tool", id: "tool-1" });
		controller.renderedRowTexts.set(2, `${APP_ICONS.toolBodyEnd} done`);
		controller.renderedTargets.set(3, { kind: "tool", id: "tool-1" });
		controller.renderedRowTexts.set(3, `${APP_ICONS.toolPreviewTruncated} hidden`);

		controller.handleMouse({ button: 0, x: 2, y: 2, released: true });
		controller.handleMouse({ button: 0, x: 1, y: 2, released: true });
		controller.handleMouse({ button: 0, x: 2, y: 3, released: true });
		controller.handleMouse({ button: 0, x: 1, y: 3, released: true });

		assert.equal(touchCount, 2);
	});

	it("flashes only the effective tool click target", () => {
		const gutterController = new AppMouseController(
			fakeHost(),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		gutterController.renderedTargets.set(3, { kind: "tool", id: "tool-1" });
		gutterController.renderedRowTexts.set(3, `${APP_ICONS.toolBodyGutter} body`);

		gutterController.handleMouse({ button: 0, x: 1, y: 3, released: false });

		assert.deepEqual(gutterController.activeClickFlash(), {
			y: 3,
			startColumn: 1,
			endColumn: 2,
			text: APP_ICONS.toolBodyGutter,
		});

		const bodyController = new AppMouseController(
			fakeHost(),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		bodyController.renderedTargets.set(3, { kind: "tool", id: "tool-1" });
		bodyController.renderedRowTexts.set(3, `${APP_ICONS.toolBodyGutter} body`);

		bodyController.handleMouse({ button: 0, x: 3, y: 3, released: false });

		assert.equal(bodyController.activeClickFlash(), undefined);

		const headerController = new AppMouseController(
			fakeHost(),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		headerController.renderedTargets.set(2, { kind: "tool", id: "tool-1" });
		headerController.renderedRowTexts.set(2, `${APP_ICONS.checkCircle} shell   `);

		headerController.handleMouse({ button: 0, x: 3, y: 2, released: false });

		assert.deepEqual(headerController.activeClickFlash(), {
			y: 2,
			startColumn: 1,
			endColumn: 8,
			text: `${APP_ICONS.checkCircle} shell`,
		});
	});

	it("opens the user-message jump menu when clicking its status target", async () => {
		let opened: { menu: string; options?: unknown } | undefined;
		let renderCount = 0;
		let refreshCount = 0;
		const statuses: string[] = [];
		const controller = new AppMouseController(
			fakeHost({
				render: () => { renderCount += 1; },
				setStatus: (status) => { statuses.push(status); },
				refreshUserMessageJumpMenuItems: async () => { refreshCount += 1; },
			}),
			fakePopupMenus({ openDirectPopupMenu: (menu, options) => { opened = { menu, options }; } }),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.statusUserJumpTarget = { row: 5, startColumn: 1, endColumn: 2 };

		controller.handleMouse({ button: 0, x: 1, y: 5, released: false });
		controller.handleMouse({ button: 0, x: 1, y: 5, released: true });
		await delay(0);

		assert.equal(refreshCount, 1);
		assert.deepEqual(opened, { menu: "user-message-jump", options: { preserveStatus: true } });
		assert.deepEqual(statuses, []);
		assert.ok(renderCount >= 1);
	});

	it("opens a detected file link on modified click", () => {
		const cwd = mkdtempSync(join(tmpdir(), "pix-mouse-links-"));
		mkdirSync(join(cwd, "src"));
		const filePath = join(cwd, "src", "app.ts");
		writeFileSync(filePath, "export {};\n", { flag: "wx" });
		let opened: { filePath?: string | undefined; line?: number | undefined; column?: number | undefined } | undefined;
		const controller = new AppMouseController(
			fakeHost({
				cwd: () => cwd,
				openFileLink: (link) => {
					opened = { filePath: link.filePath, line: link.line, column: link.column };
					return true;
				},
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.renderedRowTexts.set(2, "open src/app.ts:12:3 please");

		controller.handleMouse({ button: 8, x: 8, y: 2, released: false });

		assert.deepEqual(opened, { filePath, line: 12, column: 3 });
	});

	it("opens a detected web link on plain click without starting a text selection", () => {
		let openedUrl: string | undefined;
		const controller = new AppMouseController(
			fakeHost({
				openFileLink: (link) => {
					openedUrl = link.url;
					return true;
				},
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.renderedRowTexts.set(2, "visit https://example.com/docs please");

		controller.handleMouse({ button: 0, x: 8, y: 2, released: false });
		controller.handleMouse({ button: 3, x: 10, y: 2, released: true });

		assert.equal(openedUrl, "https://example.com/docs");
	});

	it("opens an explicit markdown link whose destination is not present in the rendered row", () => {
		let openedUrl: string | undefined;
		const controller = new AppMouseController(
			fakeHost({
				openFileLink: (link) => {
					openedUrl = link.url;
					return true;
				},
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.renderedRowTexts.set(2, "open screenshot please");
		controller.renderedLinks.set(2, [{
			start: 5,
			end: 15,
			url: "file:///Volumes/example/a-very-long-browser-qa-evidence-path/screenshot.png",
		}]);

		controller.handleMouse({ button: 0, x: 8, y: 2, released: false });
		controller.handleMouse({ button: 3, x: 8, y: 2, released: true });

		assert.equal(openedUrl, "file:///Volumes/example/a-very-long-browser-qa-evidence-path/screenshot.png");
	});

	it("hit-tests detected web links by display columns after wide characters", () => {
		let openedUrl: string | undefined;
		const controller = new AppMouseController(
			fakeHost({
				openFileLink: (link) => {
					openedUrl = link.url;
					return true;
				},
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.renderedRowTexts.set(2, "界 visit https://example.com/docs");

		controller.handleMouse({ button: 0, x: 33, y: 2, released: false });
		controller.handleMouse({ button: 3, x: 33, y: 2, released: true });

		assert.equal(openedUrl, "https://example.com/docs");
	});

	it("opens a clicked image label with the system viewer", () => {
		const image = { type: "image" as const, data: Buffer.from("png").toString("base64"), mimeType: "image/png" };
		let openedImage: typeof image | undefined;
		let toast: { message: string; kind: string } | undefined;
		const controller = new AppMouseController(
			fakeHost({
				findEntry: () => ({ id: "user-1", kind: "user", text: "[Image]", images: [image] }),
				openImageContent: (clicked) => {
					openedImage = clicked;
					return true;
				},
				showToast: (message, kind) => { toast = { message, kind }; },
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.renderedRowTexts.set(2, "[Image]");
		controller.renderedImageTargets.set(2, [{ start: 0, end: 7, entryId: "user-1", imageIndex: 0 }]);

		controller.handleMouse({ button: 3, x: 3, y: 2, released: true });

		assert.equal(openedImage, image);
		assert.deepEqual(toast, { message: "Opened image.", kind: "success" });
	});

	it("clears conversation text selection after mouse release copy", () => {
		const controller = new AppMouseController(
			fakeHost(),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);

		controller.handleMouse({ button: 0, x: 2, y: 1, released: false });
		controller.handleMouse({ button: 32, x: 6, y: 2, released: false });
		controller.handleMouse({ button: 0, x: 6, y: 2, released: true });

		assert.equal(controller.mouseSelection, undefined);
	});

	it("copies mouse selections through the host clipboard adapter", () => {
		let copiedText: string | undefined;
		const controller = new AppMouseController(
			fakeHost({ copyTextToClipboard: (text) => { copiedText = text; } }),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);

		controller.handleMouse({ button: 0, x: 1, y: 1, released: false });
		controller.handleMouse({ button: 32, x: 7, y: 2, released: false });
		controller.handleMouse({ button: 0, x: 7, y: 2, released: true });

		assert.equal(copiedText, "line 0\nline 1");
	});

	it("retains selected text in Pix when the system clipboard copy fails", () => {
		let internalText: string | undefined;
		const controller = new AppMouseController(
			fakeHost({
				copyTextToClipboard: () => { throw new Error("clipboard unavailable"); },
				setInternalClipboardText: (text) => { internalText = text; },
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);

		controller.handleMouse({ button: 0, x: 1, y: 1, released: false });
		controller.handleMouse({ button: 32, x: 7, y: 2, released: false });
		controller.handleMouse({ button: 0, x: 7, y: 2, released: true });

		assert.equal(internalText, "line 0\nline 1");
	});

	it("copies mouse selections that release in the last column", () => {
		let copiedText: string | undefined;
		const controller = new AppMouseController(
			fakeHost({ copyTextToClipboard: (text) => { copiedText = text; } }),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);

		controller.handleMouse({ button: 0, x: 1, y: 1, released: false });
		controller.handleMouse({ button: 32, x: 10, y: 2, released: false });
		controller.handleMouse({ button: 0, x: 10, y: 2, released: true });

		assert.equal(copiedText, "line 0\nline 1");
		assert.equal(controller.mouseSelection, undefined);
	});

	it("includes the final viewport column when selection reaches the right edge", () => {
		let copiedText: string | undefined;
		const controller = new AppMouseController(
			fakeHost({
				conversationViewport: () => ({
					slice: (_width: number, start: number, count: number) => Array.from({ length: count }, (_, index) => ({
						text: start + index === 0 ? "1234567890" : "abcdefghij",
					})),
				}) as never,
				copyTextToClipboard: (text) => { copiedText = text; },
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);

		controller.handleMouse({ button: 0, x: 1, y: 1, released: false });
		controller.handleMouse({ button: 32, x: 10, y: 1, released: false });
		controller.handleMouse({ button: 0, x: 10, y: 1, released: true });

		assert.equal(copiedText, "1234567890");
	});

	it("includes the final viewport column after a non-BMP icon", () => {
		let copiedText: string | undefined;
		const iconLine = `${APP_ICONS.checkCircle} 12345678`;
		const controller = new AppMouseController(
			fakeHost({
				conversationViewport: () => ({
					slice: () => [{ text: iconLine }],
				}) as never,
				copyTextToClipboard: (text) => { copiedText = text; },
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);

		controller.handleMouse({ button: 0, x: 1, y: 1, released: false });
		controller.handleMouse({ button: 32, x: 10, y: 1, released: false });
		controller.handleMouse({ button: 0, x: 10, y: 1, released: true });

		assert.equal(copiedText, iconLine);
	});

	it("copies left-edge selections when the terminal drops the release event", async () => {
		let copiedText: string | undefined;
		const controller = new AppMouseController(
			fakeHost({ copyTextToClipboard: (text) => { copiedText = text; } }),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);

		controller.handleMouse({ button: 0, x: 7, y: 2, released: false });
		controller.handleMouse({ button: 32, x: 0, y: 1, released: false });
		await delay(220);

		assert.equal(copiedText, "line 0\nline 1");
		assert.equal(controller.mouseSelection, undefined);
	});

	it("copies wrapped conversation text without injecting extra newlines", () => {
		let copiedText: string | undefined;
		const controller = new AppMouseController(
			fakeHost({
				conversationViewport: () => ({
					slice: () => [
						{ text: "hello", copyText: "hello ", continuesOnNextLine: true },
						{ text: "world", copyText: "world" },
					],
				}) as never,
				copyTextToClipboard: (text) => { copiedText = text; },
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);

		controller.handleMouse({ button: 0, x: 1, y: 1, released: false });
		controller.handleMouse({ button: 32, x: 6, y: 2, released: false });
		controller.handleMouse({ button: 0, x: 6, y: 2, released: true });

		assert.equal(copiedText, "hello world");
	});

	it("copies partial wrapped conversation selections from copyText instead of viewport line breaks", () => {
		let copiedText: string | undefined;
		const controller = new AppMouseController(
			fakeHost({
				conversationViewport: () => ({
					slice: () => [
						{ text: "hello", copyText: "hello ", continuesOnNextLine: true },
						{ text: "world", copyText: "world" },
					],
				}) as never,
				copyTextToClipboard: (text) => { copiedText = text; },
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);

		controller.handleMouse({ button: 0, x: 2, y: 1, released: false });
		controller.handleMouse({ button: 32, x: 4, y: 2, released: false });
		controller.handleMouse({ button: 0, x: 4, y: 2, released: true });

		assert.equal(copiedText, "ellowor");
	});

	it("scrolls the input editor with the mouse wheel when the pointer is over it", () => {
		const deltas: number[] = [];
		let renderCount = 0;
		let conversationScrollCount = 0;
		const controller = new AppMouseController(
			fakeHost({
				terminalRows: () => 8,
				editorLayoutRenderer: () => ({
					computeLayout: () => ({
						bodyHeight: 3,
						inputStartRow: 5,
						renderedInput: {
							lines: ["│one      │", "│two      │", "│three    │"],
							editorStartRowOffset: 0,
							scrollOffset: 0,
							visibleRowCount: 3,
							totalLineCount: 8,
						},
					}),
				}) as unknown as EditorLayoutRenderer,
				inputEditor: () => ({ scrollByVisualLines: (delta: number) => { deltas.push(delta); return true; } }) as never,
				render: () => { renderCount += 1; },
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController({ scrollByLines: () => { conversationScrollCount += 1; return true; } }),
			fakeCommandController(),
		);

		controller.handleMouse({ button: 65, x: 4, y: 6, released: false });

		assert.deepEqual(deltas, [3]);
		assert.equal(renderCount, 1);
		assert.equal(conversationScrollCount, 0);
	});

	it("drags the input scrollbar to a visual scroll offset", () => {
		let scrollOffset: number | undefined;
		let renderCount = 0;
		const controller = new AppMouseController(
			fakeHost({
				terminalRows: () => 8,
				editorLayoutRenderer: () => ({
					computeLayout: () => ({
						bodyHeight: 3,
						inputStartRow: 5,
						renderedInput: {
							lines: ["│one      │", "│two      │", "│three    │"],
							editorStartRowOffset: 0,
							scrollOffset: 0,
							visibleRowCount: 3,
							totalLineCount: 10,
							scrollBar: { top: 0, height: 1, trackHeight: 3 },
						},
					}),
				}) as unknown as EditorLayoutRenderer,
				inputEditor: () => ({ setVisualScrollOffset: (offset: number) => { scrollOffset = offset; return true; } }) as never,
				render: () => { renderCount += 1; },
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);

		controller.handleMouse({ button: 0, x: 10, y: 6, released: false });

		assert.equal(scrollOffset, 4);
		assert.equal(renderCount, 1);
	});

	it("auto-scrolls conversation selection while dragging below the viewport", async () => {
		let start = 0;
		const deltas: number[] = [];
		const controller = new AppMouseController(
			fakeHost(),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController({
				scrollMetrics: () => ({ bodyHeight: 2, viewportColumns: 10, conversationLineCount: 30, maxScroll: 28, start }),
				scrollByLines: (delta: number) => {
					deltas.push(delta);
					start = Math.max(0, Math.min(28, start + delta));
					return true;
				},
			}),
			fakeCommandController(),
		);

		controller.handleMouse({ button: 0, x: 2, y: 1, released: false });
		controller.handleMouse({ button: 32, x: 2, y: 5, released: false });
		await delay(120);
		controller.handleMouse({ button: 0, x: 2, y: 5, released: true });

		assert.ok(deltas.some((delta) => delta > 0));
		assert.equal(controller.mouseSelection, undefined);
	});

	it("auto-scrolls from rendered conversation bounds with fixed header and dynamic footer", async () => {
		let start = 0;
		const deltas: number[] = [];
		const controller = new AppMouseController(
			fakeHost({
				terminalRows: () => 12,
				tabPanelRows: () => 2,
				editorLayoutRenderer: () => ({
					// Deliberately different from the rendered body height below: mouse
					// selection must use the last rendered viewport because footer widgets
					// can change how many rows are actually available to conversation text.
					computeLayout: () => ({ bodyHeight: 7, renderedInput: { lines: [], editorStartRowOffset: 0, scrollOffset: 0 }, inputStartRow: 10 }),
				}) as unknown as EditorLayoutRenderer,
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController({
				scrollMetrics: (_columns: number, bodyHeight: number) => ({ bodyHeight, viewportColumns: 10, conversationLineCount: 30, maxScroll: 28, start }),
				scrollByLines: (delta: number) => {
					deltas.push(delta);
					start = Math.max(0, Math.min(28, start + delta));
					return true;
				},
			}),
			fakeCommandController(),
		);

		controller.syncConversationSelectionForRender(0, 2, 2, 10);
		controller.handleMouse({ button: 0, x: 2, y: 3, released: false });
		controller.handleMouse({ button: 32, x: 2, y: 6, released: false });
		await delay(120);
		controller.handleMouse({ button: 0, x: 2, y: 6, released: true });

		assert.ok(deltas.some((delta) => delta > 0));
		assert.equal(controller.mouseSelection, undefined);
	});
});

const inputFrame: InputFrameCopyRows = {
	inputSeparatorRow: 8,
	inputStartRow: 9,
	inputEndRow: 11,
	inputBottomSeparatorRow: 11,
};

describe("screenSelectionLineText", () => {
	it("preserves input field content from full-row copies", () => {
		const text = "hello             ";

		assert.equal(screenSelectionLineText(9, text, 1, text.length + 1, inputFrame), "hello             ");
	});

	it("omits input frame separator rows", () => {
		assert.equal(screenSelectionLineText(8, "────────────────────", 1, 21, inputFrame), undefined);
		assert.equal(screenSelectionLineText(11, "────────────────────", 1, 21, inputFrame), undefined);
	});

	it("preserves normal screen rows", () => {
		assert.equal(screenSelectionLineText(3, "│conversation row │", 1, 20, inputFrame), "│conversation row │");
	});
});

function fakeHost(overrides: Partial<AppMouseControllerHost> = {}): AppMouseControllerHost {
	return {
		terminalColumns: () => 10,
		terminalRows: () => 5,
		tabPanelRows: () => 0,
		conversationViewport: () => ({ slice: (_width: number, start: number, count: number) => Array.from({ length: count }, (_, index) => ({ text: `line ${start + index}` })) }) as never,
		editorLayoutRenderer: () => ({
			computeLayout: () => ({ bodyHeight: 2, renderedInput: { lines: [], editorStartRowOffset: 0, scrollOffset: 0 }, inputStartRow: 3 }),
		}) as unknown as EditorLayoutRenderer,
		inputEditor: () => ({ offsetAtVisualPosition: () => 0, setCursor: () => {} }) as never,
		resetRequestHistoryNavigation: () => {},
		findEntry: () => undefined,
		touchEntry: () => {},
		getTodoPanelExpanded: () => false,
		setTodoPanelExpanded: () => {},
		getSubagentsPanelExpanded: () => false,
		setSubagentsPanelExpanded: () => {},
		setStatus: () => {},
		runtimeSession: () => undefined,
		tabsLifecycleGeneration: () => 0,
		theme: () => THEMES.dark,
		modelColors: () => ({ rules: {} }),
		cwd: () => undefined,
		enhancePrompt: () => {},
		openNewTab: () => {},
		toggleVoiceRecording: () => {},
		toggleVoiceLanguage: () => {},
		switchToTab: () => {},
		closeTab: () => {},
		toastEntry: () => undefined,
		showToast: () => {},
		dismissToast: () => {},
		activateToastAction: () => false,
		scrollConversationQuick: () => {},
		copyTextToClipboard: () => {},
		handleExtensionInputMouse: () => false,
		render: () => {},
		...overrides,
	};
}

function fakeScrollController(overrides: Partial<AppScrollController> = {}): AppScrollController {
	return {
		scrollMetrics: () => ({ bodyHeight: 2, viewportColumns: 10, conversationLineCount: 20, maxScroll: 18, start: 0 }),
		scrollByLines: () => {},
		...overrides,
	} as unknown as AppScrollController;
}

function fakePopupMenus(overrides: Partial<AppPopupMenuController> = {}): AppPopupMenuController {
	return {
		scrollActivePopupMenu: () => {},
		getActivePopupMenu: () => ({ selectedIndex: 0, moveSelection: () => {} }),
		syncActivePopupMenu: () => undefined,
		cancelActivePopupMenu: () => {},
		openDirectPopupMenu: () => {},
		...overrides,
	} as unknown as AppPopupMenuController;
}

function fakePopupActions(overrides: Partial<AppPopupActionController> = {}): AppPopupActionController {
	return {
		submitActivePopupMenu: () => {},
		resourceSlashCommandAvailable: () => false,
		runResourceSlashCommandFromUi: async () => false,
		...overrides,
	} as unknown as AppPopupActionController;
}

function fakeCommandController(overrides: Partial<AppCommandController> = {}): AppCommandController {
	return { runResumeCommand: () => {}, ...overrides } as unknown as AppCommandController;
}
