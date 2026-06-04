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

describe("AppMouseController", () => {
	it("shows detailed DCP stats as a dialog toast when context status is clicked", () => {
		let toast: { message: string; kind: string; variant?: string; durationMs?: number } | undefined;
		const controller = new AppMouseController(
			fakeHost({
				runtimeSession: () => ({
					getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
					sessionManager: { getBranch: () => [] },
				}) as never,
				showToast: (message, kind, options) => { toast = { message, kind, variant: options?.variant, durationMs: options?.durationMs }; },
			}),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.statusContextTarget = { row: 5, startColumn: 1, endColumn: 6 };

		controller.handleMouse({ button: 0, x: 2, y: 5, released: true });

		assert.equal(toast?.kind, "info");
		assert.match(toast?.message ?? "", /DCP Session Statistics:/);
		assert.match(toast?.message ?? "", /Nudge telemetry:/);
		assert.equal(toast?.variant, "dialog");
		assert.equal(toast?.durationMs, undefined);
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

	it("refreshes model usage when clicking its status target", () => {
		let refreshCount = 0;
		const controller = new AppMouseController(
			fakeHost({ refreshModelUsageStatus: () => { refreshCount += 1; } }),
			fakePopupMenus(),
			fakePopupActions(),
			fakeScrollController(),
			fakeCommandController(),
		);
		controller.statusModelUsageTarget = { row: 5, startColumn: 12, endColumn: 32 };

		controller.handleMouse({ button: 0, x: 18, y: 5, released: false });
		controller.handleMouse({ button: 0, x: 18, y: 5, released: true });

		assert.equal(refreshCount, 1);
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

	it("opens the user-message jump menu when clicking its status target", async () => {
		let opened: { menu: string; options?: unknown } | undefined;
		let renderCount = 0;
		let refreshCount = 0;
		const controller = new AppMouseController(
			fakeHost({
				render: () => { renderCount += 1; },
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

		controller.handleMouse({ button: 0, x: 3, y: 2, released: true });

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
	contentStartColumn: 2,
	contentEndColumn: 20,
};

describe("screenSelectionLineText", () => {
	it("omits input field borders from full-row copies", () => {
		const text = "│hello             │";

		assert.equal(screenSelectionLineText(9, text, 1, text.length + 1, inputFrame), "hello             ");
	});

	it("omits input frame separator rows", () => {
		assert.equal(screenSelectionLineText(8, "╭──────────────────╮", 1, 21, inputFrame), undefined);
		assert.equal(screenSelectionLineText(11, "╰──────────────────╯", 1, 21, inputFrame), undefined);
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
		refreshModelUsageStatus: () => {},
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

function fakePopupActions(): AppPopupActionController {
	return { submitActivePopupMenu: () => {} } as unknown as AppPopupActionController;
}

function fakeCommandController(overrides: Partial<AppCommandController> = {}): AppCommandController {
	return { runResumeCommand: () => {}, ...overrides } as unknown as AppCommandController;
}
