import { DISABLE_TERMINAL_WRAP, HIDE_CURSOR, SHOW_CURSOR } from "../constants.js";
import { APP_ICONS } from "../icons.js";
import type { EditorLayoutRenderer } from "./editor-layout-renderer.js";
import type { AppMouseController } from "../screen/mouse-controller.js";
import type { AppPopupMenuController } from "../popup/popup-menu-controller.js";
import type { AppScrollController } from "../screen/scroll-controller.js";
import type { ScreenStyler } from "../screen/screen-styler.js";
import type { StatusLineRenderer } from "./status-line-renderer.js";
import type { TabLineRenderer } from "./tab-line-renderer.js";
import type { RenderedLine } from "../types.js";
import { renderToastOverlays } from "./toast-renderer.js";
import type { AppToastController } from "./toast-controller.js";
import { TerminalOutputBuffer, type TerminalOutputFrameRow } from "../terminal/terminal-output-buffer.js";
import { ANSI_RESET, colorLine, colorize, type Theme } from "../../theme.js";
import { stringDisplayWidth } from "../../terminal-width.js";
import { padOrTrimPlain } from "./render-text.js";

const INPUT_FRAME = {
	horizontal: "─",
};

export type AppRenderControllerHost = {
	isRunning(): boolean;
	terminalColumns(): number;
	terminalRows(): number;
};

export type AppRenderControllerDeps = {
	theme: Theme;
	screenStyler: ScreenStyler;
	editorLayoutRenderer: EditorLayoutRenderer;
	scrollController: AppScrollController;
	popupMenus: AppPopupMenuController;
	mouseController: AppMouseController;
	statusLineRenderer: StatusLineRenderer;
	tabLineRenderer: TabLineRenderer;
	toastController: AppToastController;
	outputBuffer?: TerminalOutputBuffer;
	loadingConversationOverlayText?: () => string | undefined;
	voiceProgressOverlayText(): string | undefined;
};

export class AppRenderController {
	private readonly outputBuffer: TerminalOutputBuffer;

	constructor(
		private readonly host: AppRenderControllerHost,
		private readonly deps: AppRenderControllerDeps,
	) {
		this.outputBuffer = deps.outputBuffer ?? new TerminalOutputBuffer();
	}

	resetOutputBuffer(): void {
		this.outputBuffer.reset();
	}

	renderStatusLine(): void {
		if (!this.host.isRunning()) return;

		const columns = this.host.terminalColumns();
		const rows = this.host.terminalRows();
		const statusRow = Math.max(1, rows);
		const statusLayout = this.deps.statusLineRenderer.layout(columns);

		this.updateStatusMouseState(statusLayout, statusRow);
		const output = this.outputBuffer.diff("statusLine", `\x1b7${DISABLE_TERMINAL_WRAP}${this.renderFrameRow(statusRow, this.deps.statusLineRenderer.render(statusRow, statusLayout, columns))}\x1b8`);
		if (output.length > 0) process.stdout.write(output);
	}

	render(): void {
		if (!this.host.isRunning()) return;

		const columns = this.host.terminalColumns();
		const rows = this.host.terminalRows();
		const topReservedRows = this.deps.tabLineRenderer.panelRows(rows);
		const layoutRows = Math.max(1, rows - topReservedRows);
		const statusRow = Math.max(1, Math.min(rows, topReservedRows + layoutRows));
		const tabRow = 1;
		const tabBottomRow = 2;
		const toScreenRow = (layoutRow: number) => Math.max(1, Math.min(rows, topReservedRows + layoutRow));
		const tabLayout = this.deps.tabLineRenderer.layout(columns);
		const layout = this.deps.editorLayoutRenderer.computeLayout(columns, layoutRows);
		const {
			renderedInput,
			aboveEditorLines,
			belowEditorLines,
			inputStartRow,
			inputSeparatorRow,
			inputBottomSeparatorRow,
			bodyHeight,
		} = layout;
		const activePopupMenu = this.deps.popupMenus.syncActivePopupMenu();
		const menuLines = this.deps.popupMenus.renderActivePopupMenu(this.deps.popupMenus.effectivePopupMenuWidth(columns));
		const popupMenuPlacement = this.deps.popupMenus.popupMenuPlacement();
		const defaultOverlayLines = menuLines.slice(0, Math.max(0, inputSeparatorRow - 1));
		const underTabsOverlayStartRow = Math.min(rows, topReservedRows + 1);
		const underTabsOverlayLines = menuLines.slice(0, Math.max(0, statusRow - underTabsOverlayStartRow));
		const { lines: visible, metrics: scrollMetrics } = this.deps.scrollController.conversationView(columns, bodyHeight);
		const conversationColumns = Math.max(1, Math.min(columns, scrollMetrics.viewportColumns));
		this.deps.mouseController.syncConversationSelectionForRender(scrollMetrics.start, bodyHeight, topReservedRows, conversationColumns);

		this.deps.mouseController.renderedTargets.clear();
		this.deps.mouseController.renderedRowTexts.clear();
		this.deps.mouseController.renderedRowBackgrounds.clear();
		this.deps.mouseController.renderedImageTargets.clear();
		this.deps.mouseController.statusModelTarget = undefined;
		this.deps.mouseController.statusThinkingTarget = undefined;
		this.deps.mouseController.statusContextTarget = undefined;
		this.deps.mouseController.statusModelUsageTarget = undefined;
		this.deps.mouseController.statusDraftQueueTarget = undefined;
		this.deps.mouseController.statusUserJumpTarget = undefined;
		this.deps.mouseController.statusThinkingExpandTarget = undefined;
		this.deps.mouseController.statusCompactToolsTarget = undefined;
		this.deps.mouseController.statusQuickScrollUpTarget = undefined;
		this.deps.mouseController.statusQuickScrollDownTarget = undefined;
		this.deps.mouseController.statusTerminalBellSoundTarget = undefined;
		this.deps.mouseController.statusSessionTarget = undefined;
		this.deps.mouseController.statusPromptEnhancerTarget = undefined;
		this.deps.mouseController.statusVoiceMicTarget = undefined;
		this.deps.mouseController.statusVoiceLanguageTarget = undefined;
		this.deps.mouseController.tabLineTargets.length = 0;
		const frameRows = new Map<number, string>();
		const appendFrameOutput = (row: number, output: string): void => {
			if (row >= 1 && row <= rows) frameRows.set(row, `${frameRows.get(row) ?? ""}${output}`);
		};
		const setRenderedBackground = (row: number, background: string | undefined): void => {
			if (background !== undefined) this.deps.mouseController.renderedRowBackgrounds.set(row, background);
		};
		if (topReservedRows > 0) {
			this.deps.mouseController.tabLineTargets.push(...tabLayout.targets.map((target) => ({ ...target, row: tabRow })));
			this.deps.mouseController.renderedRowTexts.set(tabRow, tabLayout.text);
			appendFrameOutput(tabRow, this.renderFrameRow(tabRow, this.deps.tabLineRenderer.render(tabRow, tabLayout, columns)));
			if (topReservedRows > 1) {
				this.deps.mouseController.tabLineTargets.push(...tabLayout.targets
					.filter((target) => target.kind === "new-tab")
					.map((target) => ({ ...target, row: tabBottomRow })));
				const bottomText = this.deps.tabLineRenderer.bottomText(tabLayout, columns);
				this.deps.mouseController.renderedRowTexts.set(tabBottomRow, bottomText);
				appendFrameOutput(tabBottomRow, this.renderFrameRow(tabBottomRow, this.deps.tabLineRenderer.renderBottom(tabBottomRow, tabLayout, columns)));
			}
		} else {
			this.deps.mouseController.tabLineTargets.push(...tabLayout.targets
				.filter((target) => target.kind === "new-tab")
				.map((target) => ({ ...target, row: tabRow })));
		}
		for (let index = 0; index < bodyHeight; index += 1) {
			const rendered = visible[index];
			const row = toScreenRow(index + 1);
			if (rendered?.target) this.deps.mouseController.renderedTargets.set(row, rendered.target);
			if (rendered?.imageTargets?.length) this.deps.mouseController.renderedImageTargets.set(row, rendered.imageTargets);
			this.deps.mouseController.renderedRowTexts.set(row, rendered?.text ?? "");
			setRenderedBackground(row, rendered?.backgroundOverride);
			appendFrameOutput(row, this.renderFrameRow(row, this.deps.screenStyler.styleBaseLine(row, rendered, conversationColumns)));
		}
		const loadingConversationOverlay = this.renderConversationLoadingOverlay(this.deps.loadingConversationOverlayText?.(), conversationColumns, topReservedRows, bodyHeight);
		if (loadingConversationOverlay) {
			this.deps.mouseController.renderedRowTexts.set(loadingConversationOverlay.row, loadingConversationOverlay.text);
			appendFrameOutput(loadingConversationOverlay.row, this.renderFrameRow(loadingConversationOverlay.row, loadingConversationOverlay.output));
		}
		const aboveEditorStartRow = inputSeparatorRow + 1;
		for (let index = 0; index < aboveEditorLines.length; index += 1) {
			const rendered = frameRenderedLine(aboveEditorLines[index], columns, this.deps.theme, this.deps.screenStyler);
			const row = toScreenRow(aboveEditorStartRow + index);
			if (row < 1 || row >= statusRow) continue;
			if (rendered.line?.target) this.deps.mouseController.renderedTargets.set(row, rendered.line.target);
			if (rendered.line?.imageTargets?.length) this.deps.mouseController.renderedImageTargets.set(row, rendered.line.imageTargets);
			this.deps.mouseController.renderedRowTexts.set(row, rendered.text);
			setRenderedBackground(row, rendered.line?.backgroundOverride);
			appendFrameOutput(row, this.renderFrameRow(row, rendered.output(row)));
		}

		if (inputSeparatorRow > 1) {
			const separatorText = inputFrameLine(columns, "top");
			const row = toScreenRow(inputSeparatorRow);
			if (row < statusRow) {
				this.deps.mouseController.renderedRowTexts.set(row, separatorText);
				appendFrameOutput(row, this.renderFrameRow(row, this.deps.screenStyler.styleLine(row, separatorText, columns, {
					foreground: this.deps.theme.colors.tabBorder,
				})));
			}
		}
		for (let index = 0; index < renderedInput.lines.length; index += 1) {
			const inputLine = renderedInput.lines[index] ?? "";
			const tagSpans = renderedInput.tagSpans[index];
			const suggestionSpans = renderedInput.suggestionSpans?.[index] ?? [];
			const row = toScreenRow(inputStartRow + index);
			this.deps.mouseController.renderedRowTexts.set(row, inputLine);

			const tagColor = this.deps.theme.colors.accent;
			const styledLine = this.deps.screenStyler.styleInputLine(row, inputLine, tagSpans, suggestionSpans, columns, tagColor, this.deps.theme.colors.muted);
			appendFrameOutput(row, this.renderFrameRow(row, styledLine));
		}
		if (renderedInput.scrollBar && columns > 0) {
			const scrollBar = renderedInput.scrollBar;
			for (let offset = 0; offset < scrollBar.trackHeight; offset += 1) {
				const row = toScreenRow(inputStartRow + renderedInput.editorStartRowOffset + offset);
				const isThumb = offset >= scrollBar.top && offset < scrollBar.top + scrollBar.height;
				const marker = isThumb ? " " : "│";
				appendFrameOutput(row, `\x1b[${row};${columns}H${colorize(marker, {
					foreground: this.deps.theme.colors.inputBorder,
					...(isThumb ? { background: this.deps.theme.colors.inputBorder } : {}),
				})}`);
			}
		}
		if (inputBottomSeparatorRow && inputBottomSeparatorRow > inputSeparatorRow && inputBottomSeparatorRow < statusRow) {
			const separatorText = inputFrameLine(columns, "bottom");
			const row = toScreenRow(inputBottomSeparatorRow);
			this.deps.mouseController.renderedRowTexts.set(row, separatorText);
			appendFrameOutput(row, this.renderFrameRow(row, this.deps.screenStyler.styleLine(row, separatorText, columns, {
				foreground: this.deps.theme.colors.tabBorder,
			})));
		}
		const belowEditorStartRow = (inputBottomSeparatorRow ?? (inputStartRow + renderedInput.lines.length - 1)) + 1;
		for (let index = 0; index < belowEditorLines.length; index += 1) {
			const rendered = frameRenderedLine(belowEditorLines[index], columns, this.deps.theme, this.deps.screenStyler);
			const row = toScreenRow(belowEditorStartRow + index);
			if (row < 1 || row >= statusRow) continue;
			if (rendered.line?.target) this.deps.mouseController.renderedTargets.set(row, rendered.line.target);
			if (rendered.line?.imageTargets?.length) this.deps.mouseController.renderedImageTargets.set(row, rendered.line.imageTargets);
			this.deps.mouseController.renderedRowTexts.set(row, rendered.text);
			setRenderedBackground(row, rendered.line?.backgroundOverride);
			appendFrameOutput(row, this.renderFrameRow(row, rendered.output(row)));
		}
		const statusLayout = this.deps.statusLineRenderer.layout(columns);
		this.updateStatusMouseState(statusLayout, statusRow);
		appendFrameOutput(statusRow, this.renderFrameRow(statusRow, this.deps.statusLineRenderer.render(statusRow, statusLayout, columns)));

		const voiceProgressOverlay = this.renderVoiceProgressOverlay(this.deps.voiceProgressOverlayText(), columns, statusRow);
		if (voiceProgressOverlay) {
			this.deps.mouseController.renderedRowTexts.set(voiceProgressOverlay.row, voiceProgressOverlay.text);
			setRenderedBackground(voiceProgressOverlay.row, this.deps.theme.colors.info);
			appendFrameOutput(voiceProgressOverlay.row, this.renderFrameRow(voiceProgressOverlay.row, voiceProgressOverlay.output));
		}

		if (defaultOverlayLines.length > 0 && popupMenuPlacement === "default") {
			const overlayStartRow = Math.max(1, inputSeparatorRow - defaultOverlayLines.length);
			const activeMenu = this.deps.popupMenus.getActivePopupMenu(activePopupMenu ?? this.deps.popupMenus.syncActivePopupMenu() ?? "slash");
			for (let index = 0; index < defaultOverlayLines.length; index += 1) {
				const line = defaultOverlayLines[index];
				const row = toScreenRow(overlayStartRow + index);
				const fallbackTarget = { kind: "popup-menu" as const, index: activeMenu.selectedIndex };
				this.deps.mouseController.renderedTargets.set(row, line?.target ?? fallbackTarget);
				this.deps.mouseController.renderedRowTexts.set(row, this.deps.popupMenus.overlayPlainText(line ?? { text: "" }, columns));
				setRenderedBackground(row, line?.backgroundOverride);
				appendFrameOutput(row, this.renderFrameRow(row, this.deps.popupMenus.styleOverlayLine(row, line ?? { text: "" }, columns)));
			}
		}
		if (underTabsOverlayLines.length > 0 && popupMenuPlacement === "under-tabs") {
			const activeMenu = this.deps.popupMenus.getActivePopupMenu(activePopupMenu ?? this.deps.popupMenus.syncActivePopupMenu() ?? "slash");
			for (let index = 0; index < underTabsOverlayLines.length; index += 1) {
				const line = underTabsOverlayLines[index];
				const row = underTabsOverlayStartRow + index;
				const fallbackTarget = { kind: "popup-menu" as const, index: activeMenu.selectedIndex };
				this.deps.mouseController.renderedTargets.set(row, line?.target ?? fallbackTarget);
				this.deps.mouseController.renderedRowTexts.set(row, this.deps.popupMenus.overlayPlainText(line ?? { text: "" }, columns));
				setRenderedBackground(row, line?.backgroundOverride);
				appendFrameOutput(row, this.renderFrameRow(row, this.deps.popupMenus.styleOverlayLine(row, line ?? { text: "" }, columns)));
			}
		}

		for (const toastOverlay of renderToastOverlays(visibleToastStates(this.deps.toastController), columns, Math.max(0, statusRow - topReservedRows - 1), this.deps.theme)) {
			const row = topReservedRows + toastOverlay.row;
			const rowText = this.deps.mouseController.renderedRowTexts.get(row) ?? "";
			if (toastOverlay.target) this.deps.mouseController.renderedTargets.set(row, toastOverlay.target);
			this.deps.mouseController.renderedRowTexts.set(row, overlayText(rowText, toastOverlay.column, toastOverlay.text));
			appendFrameOutput(row, `\x1b[${row};${toastOverlay.column}H${toastOverlay.output}`);
		}
		if (topReservedRows === 0) {
			const newTabTarget = tabLayout.targets.find((target) => target.kind === "new-tab");
			if (newTabTarget) {
				const plusColumn = newTabTarget.endColumn - stringDisplayWidth(APP_ICONS.plus);
				const rowText = this.deps.mouseController.renderedRowTexts.get(tabRow) ?? "";
				this.deps.mouseController.renderedRowTexts.set(tabRow, overlayText(rowText, plusColumn, APP_ICONS.plus));
				appendFrameOutput(tabRow, `\x1b[${tabRow};${plusColumn}H${colorize(APP_ICONS.plus, {
					foreground: this.deps.theme.colors.info,
					bold: true,
				})}`);
			}
		}

		const cursorRow = toScreenRow(inputStartRow + renderedInput.cursorRowOffset);
		const cursor = renderedInput.cursorVisible ? `\x1b[${cursorRow};${renderedInput.cursorColumn}H${SHOW_CURSOR}` : "";
		if (this.deps.mouseController.consumeClickFlashDirty?.()) this.outputBuffer.reset();
		const frame: TerminalOutputFrameRow[] = [...frameRows.entries()].map(([row, output]) => ({ row, output }));
		const output = this.outputBuffer.diffFrame(frame);
		process.stdout.write(`${DISABLE_TERMINAL_WRAP}${HIDE_CURSOR}${output}${this.renderClickFlashOverlay(columns, rows)}${cursor}`);
	}

	private renderFrameRow(row: number, output: string): string {
		return `\x1b[${row};1H${ANSI_RESET}\x1b[2K${output}`;
	}

	private renderClickFlashOverlay(columns: number, rows: number): string {
		const flash = this.deps.mouseController.activeClickFlash?.();
		if (!flash) return "";
		if (flash.startColumn < 1 || flash.startColumn > columns || flash.y < 1 || flash.y > rows) return "";

		const endColumn = Math.max(flash.startColumn + 1, Math.min(columns + 1, flash.endColumn));
		const width = endColumn - flash.startColumn;
		const text = fixedCellText(flash.text, width);
		return `\x1b[${flash.y};${flash.startColumn}H\x1b[7m${text}${ANSI_RESET}`;
	}

	private updateStatusMouseState(
		statusLayout: ReturnType<StatusLineRenderer["layout"]>,
		statusRow: number,
	): void {
		this.deps.mouseController.statusModelTarget = this.deps.statusLineRenderer.modelTarget(statusLayout.text, statusRow);
		this.deps.mouseController.statusThinkingTarget = this.deps.statusLineRenderer.thinkingTarget(statusLayout.text, statusRow);
		this.deps.mouseController.statusContextTarget = this.deps.statusLineRenderer.contextTarget(statusLayout.text, statusRow, statusLayout);
		this.deps.mouseController.statusModelUsageTarget = this.deps.statusLineRenderer.modelUsageTarget(statusLayout.text, statusRow, statusLayout);
		this.deps.mouseController.statusDraftQueueTarget = this.deps.statusLineRenderer.draftQueueTarget?.(statusLayout, statusRow);
		this.deps.mouseController.statusUserJumpTarget = this.deps.statusLineRenderer.userJumpTarget?.(statusLayout, statusRow);
		this.deps.mouseController.statusThinkingExpandTarget = this.deps.statusLineRenderer.thinkingExpandTarget?.(statusLayout, statusRow);
		this.deps.mouseController.statusCompactToolsTarget = this.deps.statusLineRenderer.compactToolsTarget?.(statusLayout, statusRow);
		this.deps.mouseController.statusQuickScrollUpTarget = this.deps.statusLineRenderer.quickScrollUpTarget?.(statusLayout, statusRow);
		this.deps.mouseController.statusQuickScrollDownTarget = this.deps.statusLineRenderer.quickScrollDownTarget?.(statusLayout, statusRow);
		this.deps.mouseController.statusTerminalBellSoundTarget = this.deps.statusLineRenderer.terminalBellSoundTarget?.(statusLayout, statusRow);
		this.deps.mouseController.statusSessionTarget = this.deps.statusLineRenderer.sessionTarget(statusLayout.text, statusRow, statusLayout.sessionLabel, statusLayout.workspaceLabel);
		this.deps.mouseController.statusPromptEnhancerTarget = this.deps.statusLineRenderer.promptEnhancerTarget(statusLayout, statusRow);
		this.deps.mouseController.statusVoiceMicTarget = this.deps.statusLineRenderer.voiceMicTarget(statusLayout, statusRow);
		this.deps.mouseController.statusVoiceLanguageTarget = this.deps.statusLineRenderer.voiceLanguageTarget(statusLayout, statusRow);
		this.deps.mouseController.renderedRowTexts.set(statusRow, statusLayout.text);
	}

	private renderVoiceProgressOverlay(message: string | undefined, width: number, rows: number): { row: number; text: string; output: string } | undefined {
		if (!message || width <= 0 || rows <= 1) return undefined;

		const content = ` ${message} `;
		const overlayWidth = Math.min(Math.max(18, stringDisplayWidth(content)), Math.max(1, width - 4));
		const leftWidth = Math.max(0, Math.floor((width - overlayWidth) / 2));
		const rightWidth = Math.max(0, width - leftWidth - overlayWidth);
		const text = `${" ".repeat(leftWidth)}${padOrTrimPlain(content, overlayWidth)}${" ".repeat(rightWidth)}`;
		const output = [
			colorLine("", leftWidth, { background: this.deps.theme.colors.background }),
			colorLine(content, overlayWidth, {
				foreground: this.deps.theme.colors.background,
				background: this.deps.theme.colors.info,
				bold: true,
			}),
			colorLine("", rightWidth, { background: this.deps.theme.colors.background }),
		].join("");

		return { row: Math.min(2, rows - 1), text, output };
	}

	private renderConversationLoadingOverlay(message: string | undefined, width: number, topReservedRows: number, bodyHeight: number): { row: number; text: string; output: string } | undefined {
		if (!message || width <= 0 || bodyHeight <= 0) return undefined;

		const overlayWidth = Math.min(stringDisplayWidth(message), width);
		const leftWidth = Math.max(0, Math.floor((width - overlayWidth) / 2));
		const rightWidth = Math.max(0, width - leftWidth - overlayWidth);
		const text = `${" ".repeat(leftWidth)}${padOrTrimPlain(message, overlayWidth)}${" ".repeat(rightWidth)}`;
		const row = topReservedRows + Math.floor((bodyHeight + 1) / 2);
		const output = this.deps.screenStyler.styleLine(row, text, width, {
			foreground: this.deps.theme.colors.muted,
		});

		return { row, text, output };
	}
}

function visibleToastStates(toastController: AppToastController): ReturnType<AppToastController["visibleStates"]> {
	const candidate = toastController as AppToastController & { toast?: { visibleStates?: ReturnType<AppToastController["visibleStates"]> } };
	return typeof candidate.visibleStates === "function" ? candidate.visibleStates() : candidate.toast?.visibleStates ?? [];
}

function inputFrameLine(width: number, edge: "top" | "bottom"): string {
	void edge;
	if (width <= 0) return "";
	return INPUT_FRAME.horizontal.repeat(width);
}

function frameRenderedLine(
	line: RenderedLine | undefined,
	width: number,
	theme: Theme,
	screenStyler: ScreenStyler,
): { line: RenderedLine | undefined; text: string; output: (row: number) => string } {
	if (width <= 0) return { line, text: "", output: () => "" };
	void theme;
	const text = padOrTrimPlain(line?.text ?? "", width);
	const outputLine = line ? frameInnerRenderedLine(line, text, width) : undefined;
	return {
		line,
		text,
		output: (row: number) => screenStyler.styleBaseLine(row, outputLine, width),
	};
}

function frameInnerRenderedLine(line: RenderedLine, text: string, width: number): RenderedLine {
	const { segments: originalSegments, ...rest } = line;
	const framed: RenderedLine = {
		...rest,
		text,
	};
	const segments = originalSegments
		?.map((segment) => ({
			...segment,
			start: Math.max(0, Math.min(width, segment.start)),
			end: Math.max(0, Math.min(width, segment.end)),
		}))
		.filter((segment) => segment.end > segment.start);
	if (segments && segments.length > 0) framed.segments = segments;
	return framed;
}

function overlayText(text: string, startColumn: number, overlay: string): string {
	const start = Math.max(0, startColumn - 1);
	const padded = text.padEnd(start, " ");
	return `${padded.slice(0, start)}${overlay}${padded.slice(start + overlay.length)}`;
}

function fixedCellText(text: string, width: number): string {
	const cells = Array.from(text).slice(0, Math.max(0, width)).join("");
	return cells.padEnd(width, " ");
}
