import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppRenderController } from "../src/app/rendering/render-controller.js";
import { APP_ICONS } from "../src/app/icons.js";
import { DISABLE_TERMINAL_WRAP, HIDE_CURSOR } from "../src/app/constants.js";
import { TerminalOutputBuffer } from "../src/app/terminal/terminal-output-buffer.js";
import type { EditorLayoutRenderer } from "../src/app/rendering/editor-layout-renderer.js";
import type { AppMouseController } from "../src/app/screen/mouse-controller.js";
import type { AppPopupMenuController } from "../src/app/popup/popup-menu-controller.js";
import type { AppScrollController } from "../src/app/screen/scroll-controller.js";
import type { ScreenStyler } from "../src/app/screen/screen-styler.js";
import type { StatusLineRenderer } from "../src/app/rendering/status-line-renderer.js";
import type { TabLineRenderer } from "../src/app/rendering/tab-line-renderer.js";
import type { AppToastController } from "../src/app/rendering/toast-controller.js";
import { THEMES } from "../src/theme.js";

describe("AppRenderController", () => {
	it("repaints only the status line for status indicator blink ticks", () => {
		const mouseController = fakeMouseController();
		const controller = new AppRenderController({
			isRunning: () => true,
			terminalColumns: () => 40,
			terminalRows: () => 6,
		}, {
			theme: THEMES.dark,
			screenStyler: fakeScreenStyler(),
			editorLayoutRenderer: {} as unknown as EditorLayoutRenderer,
			scrollController: {} as unknown as AppScrollController,
			popupMenus: {} as unknown as AppPopupMenuController,
			mouseController,
			statusLineRenderer: {
				layout: () => ({ details: "", text: "STATUS", sessionLabel: "", workspaceLabel: "" }),
				render: () => "STATUS",
				modelTarget: () => ({ row: 6, startColumn: 1, endColumn: 7 }),
				thinkingTarget: () => undefined,
				contextTarget: () => undefined,
				modelUsageTarget: () => undefined,
				userJumpTarget: () => undefined,
				sessionTarget: () => undefined,
				promptEnhancerTarget: () => undefined,
				voiceMicTarget: () => undefined,
				voiceLanguageTarget: () => undefined,
			} as unknown as StatusLineRenderer,
			tabLineRenderer: {} as unknown as TabLineRenderer,
			toastController: { toast: { visibleStates: [] } } as unknown as AppToastController,
			voiceProgressOverlayText: () => undefined,
		});

		const { output, result } = captureStdoutWithResult(() => controller.renderStatusLine());

		assert.equal(output, `\x1b7${DISABLE_TERMINAL_WRAP}\x1b[6;1H\x1b[0m\x1b[2KSTATUS\x1b8`);
		assert.equal(result?.kind, "status");
		assert.equal(result?.hitMap.text, "STATUS");
		assert.deepEqual(result?.hitMap.modelTarget, { row: 6, startColumn: 1, endColumn: 7 });
	});

	it("renders the visible tab row at the top and starts toasts below it", () => {
		const mouseController = fakeMouseController();
		let layoutRows: number | undefined;
		const controller = new AppRenderController({
			isRunning: () => true,
			terminalColumns: () => 40,
			terminalRows: () => 6,
		}, {
			theme: THEMES.dark,
			screenStyler: fakeScreenStyler(),
			editorLayoutRenderer: {
				computeLayout: (_width: number, rows: number) => {
					layoutRows = rows;
					return {
						renderedInput: {
							lines: ["INPUT"],
							cursorRowOffset: 0,
							cursorColumn: 7,
							cursorVisible: true,
							scrollOffset: 0,
							editorStartRowOffset: 0,
							tagSpans: [[]],
						},
						aboveEditorLines: [],
						belowEditorLines: [],
						inputStartRow: 3,
						inputSeparatorRow: 2,
						inputBottomSeparatorRow: 4,
						bodyHeight: 1,
					};
				},
			} as unknown as EditorLayoutRenderer,
			scrollController: {
				conversationView: () => ({ lines: [{ text: "BODY" }], metrics: { bodyHeight: 1, viewportColumns: 40, conversationLineCount: 1, maxScroll: 0, start: 0 } }),
				scrollBarForMetrics: () => undefined,
			} as unknown as AppScrollController,
			popupMenus: {
				syncActivePopupMenu: () => undefined,
				popupMenuPlacement: () => "default",
				effectivePopupMenuWidth: () => 40,
				renderActivePopupMenu: () => [],
				getActivePopupMenu: () => ({ selectedIndex: 0 }),
				overlayPlainText: () => "",
				styleOverlayLine: () => "",
			} as unknown as AppPopupMenuController,
			mouseController,
			statusLineRenderer: {
				layout: () => ({ details: "", text: "STATUS", sessionLabel: "", workspaceLabel: "" }),
				render: () => "STATUS",
				modelTarget: () => undefined,
				thinkingTarget: () => undefined,
				contextTarget: () => undefined,
				modelUsageTarget: () => undefined,
				userJumpTarget: () => undefined,
				sessionTarget: () => undefined,
				promptEnhancerTarget: () => undefined,
				voiceMicTarget: () => undefined,
				voiceLanguageTarget: () => undefined,
			} as unknown as StatusLineRenderer,
			tabLineRenderer: {
				panelRows: () => 2,
				layout: () => ({ text: "TABS", segments: [], targets: [{ kind: "tab", tabId: "tab-1", active: true, startColumn: 1, endColumn: 5 }], separatorColumns: [3] }),
				render: () => "TABS",
				bottomText: () => "──┴─",
				renderBottom: () => "──┴─",
			} as unknown as TabLineRenderer,
			toastController: { toast: { visibleStates: [{ id: 1, kind: "info", message: "toast" }] } } as unknown as AppToastController,
			voiceProgressOverlayText: () => undefined,
		});

		const { output, result } = captureStdoutWithResult(() => controller.render());

		assert.equal(layoutRows, 4);
		assert.equal(rowForRenderedText(output, "TABS"), 1);
		assert.equal(rowForRenderedText(output, "──┴─"), 2);
		assert.equal(rowForRenderedText(output, "BODY"), 3);
		assert.equal(rowForRenderedText(output, "INPUT"), 5);
		assert.equal(rowForRenderedText(output, "STATUS"), 6);
		assert.equal(rowForRenderedText(output, "toast"), 3);
		assert.match(output, /\x1b\[5;7H/);
		const hitMap = result?.kind === "full" ? result.hitMap : undefined;
		assert.equal(hitMap?.tabLineTargets[0]?.row, 1);
		assert.equal(hitMap?.tabLineTargets.some((target) => target.kind === "tab" && target.row === 2), false);
	});

	it("buffers unchanged full-render regions independently", () => {
		const mouseController = fakeMouseController();
		let bodyText = "BODY";
		const controller = new AppRenderController({
			isRunning: () => true,
			terminalColumns: () => 40,
			terminalRows: () => 6,
		}, {
			theme: THEMES.dark,
			screenStyler: fakeScreenStyler(),
			editorLayoutRenderer: {
				computeLayout: () => ({
					renderedInput: {
						lines: ["INPUT"],
						cursorRowOffset: 0,
						cursorColumn: 7,
						cursorVisible: false,
						scrollOffset: 0,
						editorStartRowOffset: 0,
						tagSpans: [[]],
					},
					aboveEditorLines: [],
					belowEditorLines: [],
					inputStartRow: 3,
					inputSeparatorRow: 2,
					inputBottomSeparatorRow: 4,
					bodyHeight: 1,
				}),
			} as unknown as EditorLayoutRenderer,
			scrollController: {
				conversationView: () => ({ lines: [{ text: bodyText }], metrics: { bodyHeight: 1, viewportColumns: 40, conversationLineCount: 1, maxScroll: 0, start: 0 } }),
				scrollBarForMetrics: () => undefined,
			} as unknown as AppScrollController,
			popupMenus: fakePopupMenus(),
			mouseController,
			statusLineRenderer: fakeStatusLineRenderer(),
			tabLineRenderer: {
				panelRows: () => 2,
				layout: () => ({ text: "TABS", segments: [], targets: [], separatorColumns: [] }),
				render: () => "TABS",
				bottomText: () => "────",
				renderBottom: () => "────",
			} as unknown as TabLineRenderer,
			toastController: { toast: { visibleStates: [] } } as unknown as AppToastController,
			outputBuffer: new TerminalOutputBuffer({ enabled: true }),
			voiceProgressOverlayText: () => undefined,
		});

		const first = captureStdout(() => controller.render());
		bodyText = "BODY2";
		const second = captureStdout(() => controller.render());
		const third = captureStdout(() => controller.render());

		assert.equal(rowForRenderedText(first, "TABS"), 1);
		assert.equal(rowForRenderedText(first, "INPUT"), 5);
		assert.equal(rowForRenderedText(second, "BODY2"), 3);
		assert.equal(rowForRenderedText(second, "TABS"), undefined);
		assert.equal(rowForRenderedText(second, "INPUT"), undefined);
		assert.equal(rowForRenderedText(second, "STATUS"), undefined);
		assert.equal(third, `${DISABLE_TERMINAL_WRAP}${HIDE_CURSOR}`);
	});

	it("renders click flash with inverse video", () => {
		const mouseController = {
			...fakeMouseController(),
			activeClickFlash: () => ({ y: 1, startColumn: 2, endColumn: 6, text: "BODY" }),
			consumeClickFlashDirty: () => false,
		} as unknown as AppMouseController;
		const controller = new AppRenderController({
			isRunning: () => true,
			terminalColumns: () => 40,
			terminalRows: () => 6,
		}, {
			theme: THEMES.dark,
			screenStyler: fakeScreenStyler(),
			editorLayoutRenderer: {
				computeLayout: () => ({
					renderedInput: {
						lines: ["INPUT"],
						cursorRowOffset: 0,
						cursorColumn: 7,
						cursorVisible: false,
						scrollOffset: 0,
						editorStartRowOffset: 0,
						tagSpans: [[]],
					},
					aboveEditorLines: [],
					belowEditorLines: [],
					inputStartRow: 3,
					inputSeparatorRow: 2,
					inputBottomSeparatorRow: 4,
					bodyHeight: 1,
				}),
			} as unknown as EditorLayoutRenderer,
			scrollController: {
				conversationView: () => ({ lines: [{ text: "BODY" }], metrics: { bodyHeight: 1, viewportColumns: 40, conversationLineCount: 1, maxScroll: 0, start: 0 } }),
				scrollBarForMetrics: () => undefined,
			} as unknown as AppScrollController,
			popupMenus: fakePopupMenus(),
			mouseController,
			statusLineRenderer: fakeStatusLineRenderer(),
			tabLineRenderer: {
				panelRows: () => 0,
				layout: () => ({ text: "", segments: [], targets: [] }),
				render: () => "",
			} as unknown as TabLineRenderer,
			toastController: { toast: { visibleStates: [] } } as unknown as AppToastController,
			voiceProgressOverlayText: () => undefined,
		});

		const output = captureStdout(() => controller.render());

		assert.match(output, /\x1b\[1;2H\x1b\[7mBODY\x1b\[0m/);
	});

	it("renders under-tabs popup menus directly below the tab panel", () => {
		const mouseController = fakeMouseController();
		const controller = new AppRenderController({
			isRunning: () => true,
			terminalColumns: () => 40,
			terminalRows: () => 8,
		}, {
			theme: THEMES.dark,
			screenStyler: fakeScreenStyler(),
			editorLayoutRenderer: {
				computeLayout: () => ({
					renderedInput: {
						lines: ["INPUT"],
						cursorRowOffset: 0,
						cursorColumn: 1,
						cursorVisible: false,
						scrollOffset: 0,
						editorStartRowOffset: 0,
						tagSpans: [[]],
					},
					aboveEditorLines: [],
					belowEditorLines: [],
					inputStartRow: 5,
					inputSeparatorRow: 4,
					inputBottomSeparatorRow: 6,
					bodyHeight: 3,
				}),
			} as unknown as EditorLayoutRenderer,
			scrollController: {
				conversationView: () => ({ lines: [{ text: "BODY1" }, { text: "BODY2" }, { text: "BODY3" }], metrics: { bodyHeight: 3, viewportColumns: 40, conversationLineCount: 3, maxScroll: 0, start: 0 } }),
				scrollBarForMetrics: () => undefined,
			} as unknown as AppScrollController,
			popupMenus: fakePopupMenus({
				placement: "under-tabs",
				lines: [
					{ text: "Sessions", target: { kind: "popup-menu-close" } },
					{ text: "› new", target: { kind: "popup-menu", index: 0 } },
				],
			}),
			mouseController,
			statusLineRenderer: fakeStatusLineRenderer(),
			tabLineRenderer: {
				panelRows: () => 2,
				layout: () => ({ text: "TABS", segments: [], targets: [], separatorColumns: [] }),
				render: () => "TABS",
				bottomText: () => "────",
				renderBottom: () => "────",
			} as unknown as TabLineRenderer,
			toastController: { toast: { visibleStates: [] } } as unknown as AppToastController,
			voiceProgressOverlayText: () => undefined,
		});

		const { output, result } = captureStdoutWithResult(() => controller.render());

		assert.equal(rowForRenderedText(output, "TABS"), 1);
		assert.equal(rowForRenderedText(output, "────"), 2);
		assert.equal(rowForRenderedText(output, "Sessions"), 3);
		assert.equal(rowForRenderedText(output, "› new"), 4);
		assert.deepEqual(result?.kind === "full" ? result.hitMap.targets.get(4) : undefined, { kind: "popup-menu", index: 0 });
	});

	it("overlays the new-tab button without reserving the top row when the tab panel is collapsed", () => {
		const mouseController = fakeMouseController();
		let layoutRows: number | undefined;
		const controller = new AppRenderController({
			isRunning: () => true,
			terminalColumns: () => 40,
			terminalRows: () => 5,
		}, {
			theme: THEMES.dark,
			screenStyler: fakeScreenStyler(),
			editorLayoutRenderer: {
				computeLayout: (_width: number, rows: number) => {
					layoutRows = rows;
					return {
						renderedInput: {
							lines: ["INPUT"],
							cursorRowOffset: 0,
							cursorColumn: 7,
							cursorVisible: false,
							scrollOffset: 0,
							editorStartRowOffset: 0,
							tagSpans: [[]],
						},
						aboveEditorLines: [],
						belowEditorLines: [],
						inputStartRow: 3,
						inputSeparatorRow: 2,
						inputBottomSeparatorRow: 4,
						bodyHeight: 1,
					};
				},
			} as unknown as EditorLayoutRenderer,
			scrollController: {
				conversationView: () => ({ lines: [{ text: "BODY" }], metrics: { bodyHeight: 1, viewportColumns: 40, conversationLineCount: 1, maxScroll: 0, start: 0 } }),
				scrollBarForMetrics: () => undefined,
			} as unknown as AppScrollController,
			popupMenus: fakePopupMenus(),
			mouseController,
			statusLineRenderer: fakeStatusLineRenderer(),
			tabLineRenderer: {
				panelRows: () => 0,
				layout: () => ({ text: `${" ".repeat(39)}${APP_ICONS.plus}`, segments: [], targets: [{ kind: "new-tab", startColumn: 40, endColumn: 41 }], separatorColumns: [] }),
				render: () => `${" ".repeat(39)}${APP_ICONS.plus}`,
				bottomText: () => "",
				renderBottom: () => "",
			} as unknown as TabLineRenderer,
			toastController: { toast: { visibleStates: [] } } as unknown as AppToastController,
			voiceProgressOverlayText: () => undefined,
		});

		const { output, result } = captureStdoutWithResult(() => controller.render());

		assert.equal(layoutRows, 5);
		assert.equal(rowForRenderedText(output, "BODY"), 1);
		assert.equal(rowForRenderedText(output, "STATUS"), 5);
		assert.match(output, /\x1b\[1;40H/);
		const hitMap = result?.kind === "full" ? result.hitMap : undefined;
		assert.equal(hitMap?.rowTexts.get(1)?.startsWith("BODY"), true);
		assert.equal(hitMap?.rowTexts.get(1)?.endsWith(APP_ICONS.plus), true);
		assert.deepEqual(hitMap?.tabLineTargets, [{ kind: "new-tab", startColumn: 40, endColumn: 41, row: 1 }]);
	});

	it("reserves the last column for the conversation scrollbar", () => {
		const bodyWidths: number[] = [];
		const controller = new AppRenderController({
			isRunning: () => true,
			terminalColumns: () => 10,
			terminalRows: () => 4,
		}, {
			theme: THEMES.dark,
			screenStyler: {
				...fakeScreenStyler(),
				styleBaseLine: (_row: number, line: { text?: string } | undefined, width: number) => {
					bodyWidths.push(width);
					return (line?.text ?? "").slice(0, width);
				},
			} as unknown as ScreenStyler,
			editorLayoutRenderer: {
				computeLayout: () => ({
					renderedInput: {
						lines: [""],
						cursorRowOffset: 0,
						cursorColumn: 1,
						cursorVisible: false,
						scrollOffset: 0,
						editorStartRowOffset: 0,
						tagSpans: [[]],
					},
					aboveEditorLines: [],
					belowEditorLines: [],
					inputStartRow: 3,
					inputSeparatorRow: 2,
					inputBottomSeparatorRow: 0,
					bodyHeight: 1,
				}),
			} as unknown as EditorLayoutRenderer,
			scrollController: {
				conversationView: () => ({ lines: [{ text: "1234567890" }], metrics: { bodyHeight: 1, viewportColumns: 9, conversationLineCount: 2, maxScroll: 1, start: 0 } }),
				scrollBarForMetrics: () => ({ thumbStartRow: 1, thumbEndRow: 1 }),
			} as unknown as AppScrollController,
			popupMenus: {
				syncActivePopupMenu: () => undefined,
				popupMenuPlacement: () => "default",
				effectivePopupMenuWidth: () => 10,
				renderActivePopupMenu: () => [],
				getActivePopupMenu: () => ({ selectedIndex: 0 }),
				overlayPlainText: () => "",
				styleOverlayLine: () => "",
			} as unknown as AppPopupMenuController,
			mouseController: fakeMouseController(),
			statusLineRenderer: {
				layout: () => ({ details: "", text: "STATUS", sessionLabel: "", workspaceLabel: "" }),
				render: () => "STATUS",
				modelTarget: () => undefined,
				thinkingTarget: () => undefined,
				contextTarget: () => undefined,
				modelUsageTarget: () => undefined,
				sessionTarget: () => undefined,
				promptEnhancerTarget: () => undefined,
				voiceMicTarget: () => undefined,
				voiceLanguageTarget: () => undefined,
			} as unknown as StatusLineRenderer,
			tabLineRenderer: {
				panelRows: () => 0,
				layout: () => ({ text: "", segments: [], targets: [] }),
				render: () => "",
			} as unknown as TabLineRenderer,
			toastController: { toast: { visibleStates: [] } } as unknown as AppToastController,
			voiceProgressOverlayText: () => undefined,
		});

		const output = captureStdout(() => controller.render());

		assert.equal(bodyWidths[0], 9);
		assert.match(output, /\x1b\[1;1H\x1b\[0m\x1b\[2K123456789\x1b\[1;10H/);
		assert.doesNotMatch(output, /1234567890\x1b\[1;10H/);
	});

	it("keeps framed widget rows closed at the right edge", () => {
		const mouseController = fakeMouseController();
		const controller = new AppRenderController({
			isRunning: () => true,
			terminalColumns: () => 12,
			terminalRows: () => 6,
		}, {
			theme: THEMES.dark,
			screenStyler: fakeScreenStyler(),
			editorLayoutRenderer: {
				computeLayout: () => ({
					renderedInput: {
						lines: ["│input    │"],
						cursorRowOffset: 0,
						cursorColumn: 2,
						cursorVisible: false,
						scrollOffset: 0,
						editorStartRowOffset: 0,
						tagSpans: [[]],
					},
					aboveEditorLines: [{ text: "widget", target: { kind: "todo-panel" } }],
					belowEditorLines: [],
					inputStartRow: 4,
					inputSeparatorRow: 2,
					inputBottomSeparatorRow: 5,
					bodyHeight: 1,
				}),
			} as unknown as EditorLayoutRenderer,
			scrollController: {
				conversationView: () => ({ lines: [{ text: "BODY" }], metrics: { bodyHeight: 1, viewportColumns: 12, conversationLineCount: 1, maxScroll: 0, start: 0 } }),
				scrollBarForMetrics: () => undefined,
			} as unknown as AppScrollController,
			popupMenus: fakePopupMenus(),
			mouseController,
			statusLineRenderer: fakeStatusLineRenderer(),
			tabLineRenderer: {
				panelRows: () => 0,
				layout: () => ({ text: "", segments: [], targets: [] }),
				render: () => "",
			} as unknown as TabLineRenderer,
			toastController: { toast: { visibleStates: [] } } as unknown as AppToastController,
			voiceProgressOverlayText: () => undefined,
		});

		const { output, result } = captureStdoutWithResult(() => controller.render());

		assert.match(output, /\x1b\[3;1H\x1b\[0m\x1b\[2K\x1b\[[^m]+m│\x1b\[0mwidget {4}\x1b\[[^m]+m│\x1b\[0m/);
		assert.equal(result?.kind === "full" ? result.hitMap.rowTexts.get(3) : undefined, "│widget    │");
		assert.deepEqual(result?.kind === "full" ? result.hitMap.targets.get(3) : undefined, { kind: "todo-panel" });
	});

	it("renders default popup overlays above the input frame", () => {
		const mouseController = fakeMouseController();
		const controller = new AppRenderController({
			isRunning: () => true,
			terminalColumns: () => 40,
			terminalRows: () => 7,
		}, {
			theme: THEMES.dark,
			screenStyler: fakeScreenStyler(),
			editorLayoutRenderer: {
				computeLayout: () => ({
					renderedInput: {
						lines: ["INPUT"],
						cursorRowOffset: 0,
						cursorColumn: 1,
						cursorVisible: false,
						scrollOffset: 0,
						editorStartRowOffset: 0,
						tagSpans: [[]],
					},
					aboveEditorLines: [],
					belowEditorLines: [],
					inputStartRow: 4,
					inputSeparatorRow: 3,
					inputBottomSeparatorRow: 5,
					bodyHeight: 1,
				}),
			} as unknown as EditorLayoutRenderer,
			scrollController: {
				conversationView: () => ({ lines: [{ text: "BODY" }], metrics: { bodyHeight: 1, viewportColumns: 40, conversationLineCount: 1, maxScroll: 0, start: 0 } }),
				scrollBarForMetrics: () => undefined,
			} as unknown as AppScrollController,
			popupMenus: fakePopupMenus({
				placement: "default",
				lines: [{ text: "help", target: { kind: "popup-menu", index: 0 } }],
			}),
			mouseController,
			statusLineRenderer: fakeStatusLineRenderer(),
			tabLineRenderer: { panelRows: () => 0, layout: () => ({ text: "", segments: [], targets: [] }), render: () => "" } as unknown as TabLineRenderer,
			toastController: { toast: { visibleStates: [] } } as unknown as AppToastController,
			voiceProgressOverlayText: () => undefined,
		});

		const { output, result } = captureStdoutWithResult(() => controller.render());

		assert.equal(rowForRenderedText(output, "help"), 2);
		assert.deepEqual(result?.kind === "full" ? result.hitMap.targets.get(2) : undefined, { kind: "popup-menu", index: 0 });
	});

	it("renders the voice progress overlay centered on the second row", () => {
		const mouseController = fakeMouseController();
		const controller = new AppRenderController({
			isRunning: () => true,
			terminalColumns: () => 40,
			terminalRows: () => 7,
		}, {
			theme: THEMES.dark,
			screenStyler: fakeScreenStyler(),
			editorLayoutRenderer: {
				computeLayout: () => ({
					renderedInput: {
						lines: ["INPUT"],
						cursorRowOffset: 0,
						cursorColumn: 1,
						cursorVisible: false,
						scrollOffset: 0,
						editorStartRowOffset: 0,
						tagSpans: [[]],
					},
					aboveEditorLines: [],
					belowEditorLines: [],
					inputStartRow: 4,
					inputSeparatorRow: 3,
					inputBottomSeparatorRow: 5,
					bodyHeight: 1,
				}),
			} as unknown as EditorLayoutRenderer,
			scrollController: {
				conversationView: () => ({ lines: [{ text: "BODY" }], metrics: { bodyHeight: 1, viewportColumns: 40, conversationLineCount: 1, maxScroll: 0, start: 0 } }),
				scrollBarForMetrics: () => undefined,
			} as unknown as AppScrollController,
			popupMenus: fakePopupMenus(),
			mouseController,
			statusLineRenderer: fakeStatusLineRenderer(),
			tabLineRenderer: { panelRows: () => 0, layout: () => ({ text: "", segments: [], targets: [] }), render: () => "" } as unknown as TabLineRenderer,
			toastController: { toast: { visibleStates: [] } } as unknown as AppToastController,
			voiceProgressOverlayText: () => "Listening",
		});

		const { output, result } = captureStdoutWithResult(() => controller.render());

		assert.equal(rowForRenderedText(output, "Listening"), 2);
		assert.equal(result?.kind === "full" ? result.hitMap.rowTexts.get(2)?.includes("Listening") : undefined, true);
		assert.equal(result?.kind === "full" ? result.hitMap.rowBackgrounds.get(2) : undefined, THEMES.dark.colors.info);
	});
});

function fakeMouseController(): AppMouseController {
	return {
		renderedTargets: new Map(),
		renderedRowTexts: new Map(),
		renderedRowBackgrounds: new Map(),
		renderedImageTargets: new Map(),
		statusModelTarget: undefined,
		statusThinkingTarget: undefined,
		statusContextTarget: undefined,
		statusModelUsageTarget: undefined,
		statusDraftQueueTarget: undefined,
		statusUserJumpTarget: undefined,
		statusThinkingExpandTarget: undefined,
		statusCompactToolsTarget: undefined,
		statusSessionTarget: undefined,
		statusPromptEnhancerTarget: undefined,
		statusVoiceMicTarget: undefined,
		statusVoiceLanguageTarget: undefined,
		tabLineTargets: [],
		syncConversationSelectionForRender: () => {},
	} as unknown as AppMouseController;
}

function fakeScreenStyler(): ScreenStyler {
	return {
		styleBaseLine: (_row: number, line: { text?: string } | undefined) => line?.text ?? "",
		styleLine: (_row: number, text: string) => text,
		styleInputLine: (_row: number, text: string) => text,
		styleLineSegments: (_row: number, text: string) => text,
	} as unknown as ScreenStyler;
}

function fakePopupMenus(options: { placement?: "default" | "under-tabs"; lines?: { text: string; target?: { kind: "popup-menu"; index: number } | { kind: "popup-menu-close" } }[] } = {}): AppPopupMenuController {
	return {
		syncActivePopupMenu: () => options.lines?.length ? "resume" : undefined,
		popupMenuPlacement: () => options.placement ?? "default",
		effectivePopupMenuWidth: () => 40,
		renderActivePopupMenu: () => options.lines ?? [],
		getActivePopupMenu: () => ({ selectedIndex: 0 }),
		overlayPlainText: (line: { text: string }) => line.text,
		styleOverlayLine: (_row: number, line: { text: string }) => line.text,
	} as unknown as AppPopupMenuController;
}

function fakeStatusLineRenderer(): StatusLineRenderer {
	return {
		layout: () => ({ details: "", text: "STATUS", sessionLabel: "", workspaceLabel: "" }),
		render: () => "STATUS",
		modelTarget: () => undefined,
		thinkingTarget: () => undefined,
		contextTarget: () => undefined,
		modelUsageTarget: () => undefined,
		userJumpTarget: () => undefined,
		thinkingExpandTarget: () => undefined,
		sessionTarget: () => undefined,
		promptEnhancerTarget: () => undefined,
		voiceMicTarget: () => undefined,
		voiceLanguageTarget: () => undefined,
	} as unknown as StatusLineRenderer;
}

function captureStdout(fn: () => void): string {
	const writes: string[] = [];
	const originalWrite = process.stdout.write;
	Object.defineProperty(process.stdout, "write", {
		configurable: true,
		value: (chunk: string | Uint8Array) => {
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		},
	});

	try {
		fn();
	} finally {
		Object.defineProperty(process.stdout, "write", { configurable: true, value: originalWrite });
	}

	return writes.join("");
}

function captureStdoutWithResult<T>(fn: () => T): { output: string; result: T } {
	let result: T;
	const output = captureStdout(() => {
		result = fn();
	});
	return { output, result: result! };
}

function rowForRenderedText(output: string, text: string): number | undefined {
	const cursorPattern = /\x1b\[(\d+);1H(?:\x1b\[0m)?\x1b\[2K/g;
	let match: RegExpExecArray | null;
	while ((match = cursorPattern.exec(output)) !== null) {
		const start = match.index;
		const next = output.slice(cursorPattern.lastIndex).search(/\x1b\[\d+;1H(?:\x1b\[0m)?\x1b\[2K/);
		const end = next < 0 ? output.length : cursorPattern.lastIndex + next;
		if (output.slice(start, end).includes(text)) return Number(match[1]);
	}

	return undefined;
}
