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
import { createRenderHitMap, type RenderHitMap, type StatusRenderHitMap } from "../screen/render-hit-map.js";
import { renderToastOverlays } from "./toast-renderer.js";
import type { AppToastController } from "./toast-controller.js";
import { TerminalOutputBuffer, type TerminalOutputFrameRegion } from "../terminal/terminal-output-buffer.js";
import { ANSI_RESET, colorLine, colorize, type Theme } from "../../theme.js";
import { stringDisplayWidth } from "../../terminal-width.js";
import { padOrTrimPlain } from "./render-text.js";

const INPUT_FRAME = {
	topLeft: "╭",
	topRight: "╮",
	bottomLeft: "╰",
	bottomRight: "╯",
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
	voiceProgressOverlayText(): string | undefined;
};

export type AppRenderResult =
	| { kind: "full"; hitMap: RenderHitMap }
	| { kind: "status"; hitMap: StatusRenderHitMap };

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

	renderStatusLine(): AppRenderResult | undefined {
		if (!this.host.isRunning()) return undefined;

		const columns = this.host.terminalColumns();
		const rows = this.host.terminalRows();
		const statusRow = Math.max(1, rows);
		const statusLayout = this.deps.statusLineRenderer.layout(columns);

		const hitMap = this.statusRenderHitMap(statusLayout, statusRow);
		const output = this.outputBuffer.diff("statusLine", `\x1b7${DISABLE_TERMINAL_WRAP}${this.renderFrameRow(statusRow, this.deps.statusLineRenderer.render(statusRow, statusLayout, columns))}\x1b8`);
		if (output.length > 0) process.stdout.write(output);
		return { kind: "status", hitMap };
	}

	render(): AppRenderResult | undefined {
		if (!this.host.isRunning()) return undefined;

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
		const scrollBar = this.deps.scrollController.scrollBarForMetrics(scrollMetrics);
		const conversationColumns = Math.max(1, Math.min(columns, scrollMetrics.viewportColumns));
		this.deps.mouseController.syncConversationSelectionForRender(scrollMetrics.start, bodyHeight, topReservedRows, conversationColumns);
		const hitMap = createRenderHitMap();

		const frameLines: Record<TerminalOutputFrameRegion, string[]> = {
			tabs: [],
			conversation: [],
			inputStatus: [],
		};
		const inputStatusStartRow = toScreenRow(inputSeparatorRow);
		const regionForOverlayRow = (row: number): TerminalOutputFrameRegion => {
			if (row >= statusRow) return "inputStatus";
			if (topReservedRows > 0 && row <= topReservedRows) return "tabs";
			if (row >= inputStatusStartRow) return "inputStatus";
			return "conversation";
		};
		const appendFrameOutput = (region: TerminalOutputFrameRegion, row: number, output: string): void => {
			if (row >= 1 && row <= rows) frameLines[region].push(output);
		};
		const setRenderedBackground = (row: number, background: string | undefined): void => {
			if (background !== undefined) hitMap.rowBackgrounds.set(row, background);
		};
		if (topReservedRows > 0) {
			hitMap.tabLineTargets.push(...tabLayout.targets.map((target) => ({ ...target, row: tabRow })));
			hitMap.rowTexts.set(tabRow, tabLayout.text);
			appendFrameOutput("tabs", tabRow, this.renderFrameRow(tabRow, this.deps.tabLineRenderer.render(tabRow, tabLayout, columns)));
			if (topReservedRows > 1) {
				hitMap.tabLineTargets.push(...tabLayout.targets
					.filter((target) => target.kind === "new-tab")
					.map((target) => ({ ...target, row: tabBottomRow })));
				const bottomText = this.deps.tabLineRenderer.bottomText(tabLayout, columns);
				hitMap.rowTexts.set(tabBottomRow, bottomText);
				appendFrameOutput("tabs", tabBottomRow, this.renderFrameRow(tabBottomRow, this.deps.tabLineRenderer.renderBottom(tabBottomRow, tabLayout, columns)));
			}
		} else {
			hitMap.tabLineTargets.push(...tabLayout.targets
				.filter((target) => target.kind === "new-tab")
				.map((target) => ({ ...target, row: tabRow })));
		}
		for (let index = 0; index < bodyHeight; index += 1) {
			const rendered = visible[index];
			const row = toScreenRow(index + 1);
			if (rendered?.target) hitMap.targets.set(row, rendered.target);
			if (rendered?.imageTargets?.length) hitMap.imageTargets.set(row, rendered.imageTargets);
			hitMap.rowTexts.set(row, rendered?.text ?? "");
			setRenderedBackground(row, rendered?.backgroundOverride);
			appendFrameOutput("conversation", row, this.renderFrameRow(row, this.deps.screenStyler.styleBaseLine(row, rendered, conversationColumns)));
		}
		if (scrollBar && columns > 0) {
			for (let layoutRow = 1; layoutRow <= bodyHeight; layoutRow += 1) {
				const row = toScreenRow(layoutRow);
				const isThumb = layoutRow >= scrollBar.thumbStartRow && layoutRow <= scrollBar.thumbEndRow;
				const marker = isThumb ? " " : "│";
				appendFrameOutput("conversation", row, `\x1b[${row};${columns}H${colorize(marker, {
					foreground: this.deps.theme.colors.inputBorder,
					...(isThumb ? { background: this.deps.theme.colors.inputBorder } : {}),
				})}`);
			}
		}

		const aboveEditorStartRow = inputSeparatorRow + 1;
		for (let index = 0; index < aboveEditorLines.length; index += 1) {
			const rendered = frameRenderedLine(aboveEditorLines[index], columns, this.deps.theme, this.deps.screenStyler);
			const row = toScreenRow(aboveEditorStartRow + index);
			if (row < 1 || row >= statusRow) continue;
			if (rendered.line?.target) hitMap.targets.set(row, rendered.line.target);
			if (rendered.line?.imageTargets?.length) hitMap.imageTargets.set(row, rendered.line.imageTargets);
			hitMap.rowTexts.set(row, rendered.text);
			setRenderedBackground(row, rendered.line?.backgroundOverride);
			appendFrameOutput("inputStatus", row, this.renderFrameRow(row, rendered.output(row)));
		}

		if (inputSeparatorRow > 1) {
			const separatorText = inputFrameLine(columns, "top");
			const row = toScreenRow(inputSeparatorRow);
			if (row < statusRow) {
				hitMap.rowTexts.set(row, separatorText);
				appendFrameOutput("inputStatus", row, this.renderFrameRow(row, this.deps.screenStyler.styleLine(row, separatorText, columns, {
					foreground: this.deps.theme.colors.inputBorder,
				})));
			}
		}
		for (let index = 0; index < renderedInput.lines.length; index += 1) {
			const inputLine = renderedInput.lines[index] ?? "";
			const tagSpans = renderedInput.tagSpans[index];
			const suggestionSpans = renderedInput.suggestionSpans?.[index] ?? [];
			const row = toScreenRow(inputStartRow + index);
			hitMap.rowTexts.set(row, inputLine);

			const tagColor = this.deps.theme.colors.accent;
			const styledLine = this.deps.screenStyler.styleInputLine(row, inputLine, tagSpans, suggestionSpans, columns, tagColor, this.deps.theme.colors.muted, this.deps.theme.colors.inputBorder);
			appendFrameOutput("inputStatus", row, this.renderFrameRow(row, styledLine));
		}
		if (renderedInput.scrollBar && columns > 0) {
			const scrollBar = renderedInput.scrollBar;
			for (let offset = 0; offset < scrollBar.trackHeight; offset += 1) {
				const row = toScreenRow(inputStartRow + renderedInput.editorStartRowOffset + offset);
				const isThumb = offset >= scrollBar.top && offset < scrollBar.top + scrollBar.height;
				const marker = isThumb ? " " : "│";
				appendFrameOutput("inputStatus", row, `\x1b[${row};${columns}H${colorize(marker, {
					foreground: this.deps.theme.colors.inputBorder,
					...(isThumb ? { background: this.deps.theme.colors.inputBorder } : {}),
				})}`);
			}
		}
		const belowEditorStartRow = inputStartRow + renderedInput.lines.length;
		for (let index = 0; index < belowEditorLines.length; index += 1) {
			const rendered = frameRenderedLine(belowEditorLines[index], columns, this.deps.theme, this.deps.screenStyler);
			const row = toScreenRow(belowEditorStartRow + index);
			if (row < 1 || row >= statusRow) continue;
			if (rendered.line?.target) hitMap.targets.set(row, rendered.line.target);
			if (rendered.line?.imageTargets?.length) hitMap.imageTargets.set(row, rendered.line.imageTargets);
			hitMap.rowTexts.set(row, rendered.text);
			setRenderedBackground(row, rendered.line?.backgroundOverride);
			appendFrameOutput("inputStatus", row, this.renderFrameRow(row, rendered.output(row)));
		}
		if (inputBottomSeparatorRow > 1) {
			const separatorText = inputFrameLine(columns, "bottom");
			const row = toScreenRow(inputBottomSeparatorRow);
			if (row < statusRow) {
				hitMap.rowTexts.set(row, separatorText);
				appendFrameOutput("inputStatus", row, this.renderFrameRow(row, this.deps.screenStyler.styleLine(row, separatorText, columns, {
					foreground: this.deps.theme.colors.inputBorder,
				})));
			}
		}
		const statusLayout = this.deps.statusLineRenderer.layout(columns);
		hitMap.status = this.statusRenderHitMap(statusLayout, statusRow);
		hitMap.rowTexts.set(statusRow, hitMap.status.text);
		appendFrameOutput("inputStatus", statusRow, this.renderFrameRow(statusRow, this.deps.statusLineRenderer.render(statusRow, statusLayout, columns)));

		const voiceProgressOverlay = this.renderVoiceProgressOverlay(this.deps.voiceProgressOverlayText(), columns, statusRow);
		if (voiceProgressOverlay) {
			hitMap.rowTexts.set(voiceProgressOverlay.row, voiceProgressOverlay.text);
			setRenderedBackground(voiceProgressOverlay.row, this.deps.theme.colors.info);
			appendFrameOutput(regionForOverlayRow(voiceProgressOverlay.row), voiceProgressOverlay.row, this.renderFrameRow(voiceProgressOverlay.row, voiceProgressOverlay.output));
		}

		if (defaultOverlayLines.length > 0 && popupMenuPlacement === "default") {
			const overlayStartRow = Math.max(1, inputSeparatorRow - defaultOverlayLines.length);
			const activeMenu = this.deps.popupMenus.getActivePopupMenu(activePopupMenu ?? this.deps.popupMenus.syncActivePopupMenu() ?? "slash");
			for (let index = 0; index < defaultOverlayLines.length; index += 1) {
				const line = defaultOverlayLines[index];
				const row = toScreenRow(overlayStartRow + index);
				const fallbackTarget = { kind: "popup-menu" as const, index: activeMenu.selectedIndex };
				hitMap.targets.set(row, line?.target ?? fallbackTarget);
				hitMap.rowTexts.set(row, this.deps.popupMenus.overlayPlainText(line ?? { text: "" }, columns));
				setRenderedBackground(row, line?.backgroundOverride);
				appendFrameOutput(regionForOverlayRow(row), row, this.renderFrameRow(row, this.deps.popupMenus.styleOverlayLine(row, line ?? { text: "" }, columns)));
			}
		}
		if (underTabsOverlayLines.length > 0 && popupMenuPlacement === "under-tabs") {
			const activeMenu = this.deps.popupMenus.getActivePopupMenu(activePopupMenu ?? this.deps.popupMenus.syncActivePopupMenu() ?? "slash");
			for (let index = 0; index < underTabsOverlayLines.length; index += 1) {
				const line = underTabsOverlayLines[index];
				const row = underTabsOverlayStartRow + index;
				const fallbackTarget = { kind: "popup-menu" as const, index: activeMenu.selectedIndex };
				hitMap.targets.set(row, line?.target ?? fallbackTarget);
				hitMap.rowTexts.set(row, this.deps.popupMenus.overlayPlainText(line ?? { text: "" }, columns));
				setRenderedBackground(row, line?.backgroundOverride);
				appendFrameOutput(regionForOverlayRow(row), row, this.renderFrameRow(row, this.deps.popupMenus.styleOverlayLine(row, line ?? { text: "" }, columns)));
			}
		}

		for (const toastOverlay of renderToastOverlays(this.deps.toastController.toast.visibleStates, columns, Math.max(0, statusRow - topReservedRows - 1), this.deps.theme)) {
			const row = topReservedRows + toastOverlay.row;
			const rowText = hitMap.rowTexts.get(row) ?? "";
			if (toastOverlay.target) hitMap.targets.set(row, toastOverlay.target);
			hitMap.rowTexts.set(row, overlayText(rowText, toastOverlay.column, toastOverlay.text));
			appendFrameOutput(regionForOverlayRow(row), row, `\x1b[${row};${toastOverlay.column}H${toastOverlay.output}`);
		}
		if (topReservedRows === 0) {
			const newTabTarget = tabLayout.targets.find((target) => target.kind === "new-tab");
			if (newTabTarget) {
				const plusColumn = newTabTarget.endColumn - stringDisplayWidth(APP_ICONS.plus);
				const rowText = hitMap.rowTexts.get(tabRow) ?? "";
				hitMap.rowTexts.set(tabRow, overlayText(rowText, plusColumn, APP_ICONS.plus));
				appendFrameOutput(regionForOverlayRow(tabRow), tabRow, `\x1b[${tabRow};${plusColumn}H${colorize(APP_ICONS.plus, {
					foreground: this.deps.theme.colors.info,
					bold: true,
				})}`);
			}
		}

		const cursorRow = toScreenRow(inputStartRow + renderedInput.cursorRowOffset);
		const cursor = renderedInput.cursorVisible ? `\x1b[${cursorRow};${renderedInput.cursorColumn}H${SHOW_CURSOR}` : "";
		if (this.deps.mouseController.consumeClickFlashDirty?.()) this.outputBuffer.reset();
		const output = this.outputBuffer.diffFrame({
			tabs: frameLines.tabs.join(""),
			conversation: frameLines.conversation.join(""),
			inputStatus: frameLines.inputStatus.join(""),
		});
		process.stdout.write(`${DISABLE_TERMINAL_WRAP}${HIDE_CURSOR}${output}${this.renderClickFlashOverlay(columns, rows)}${cursor}`);
		return { kind: "full", hitMap };
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

	private statusRenderHitMap(statusLayout: ReturnType<StatusLineRenderer["layout"]>, statusRow: number): StatusRenderHitMap {
		return {
			row: statusRow,
			text: statusLayout.text,
			modelTarget: this.deps.statusLineRenderer.modelTarget(statusLayout.text, statusRow),
			thinkingTarget: this.deps.statusLineRenderer.thinkingTarget(statusLayout.text, statusRow),
			contextTarget: this.deps.statusLineRenderer.contextTarget(statusLayout.text, statusRow, statusLayout),
			modelUsageTarget: this.deps.statusLineRenderer.modelUsageTarget(statusLayout.text, statusRow, statusLayout),
			draftQueueTarget: this.deps.statusLineRenderer.draftQueueTarget?.(statusLayout, statusRow),
			userJumpTarget: this.deps.statusLineRenderer.userJumpTarget?.(statusLayout, statusRow),
			thinkingExpandTarget: this.deps.statusLineRenderer.thinkingExpandTarget?.(statusLayout, statusRow),
			compactToolsTarget: this.deps.statusLineRenderer.compactToolsTarget?.(statusLayout, statusRow),
			terminalBellSoundTarget: this.deps.statusLineRenderer.terminalBellSoundTarget?.(statusLayout, statusRow),
			sessionTarget: this.deps.statusLineRenderer.sessionTarget(statusLayout.text, statusRow, statusLayout.sessionLabel, statusLayout.workspaceLabel),
			promptEnhancerTarget: this.deps.statusLineRenderer.promptEnhancerTarget(statusLayout, statusRow),
			voiceMicTarget: this.deps.statusLineRenderer.voiceMicTarget(statusLayout, statusRow),
			voiceLanguageTarget: this.deps.statusLineRenderer.voiceLanguageTarget(statusLayout, statusRow),
		};
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
}

function inputFrameLine(width: number, edge: "top" | "bottom"): string {
	if (width <= 0) return "";
	if (width === 1) return edge === "top" ? INPUT_FRAME.topLeft : INPUT_FRAME.bottomLeft;
	const left = edge === "top" ? INPUT_FRAME.topLeft : INPUT_FRAME.bottomLeft;
	const right = edge === "top" ? INPUT_FRAME.topRight : INPUT_FRAME.bottomRight;
	return `${left}${INPUT_FRAME.horizontal.repeat(Math.max(0, width - 2))}${right}`;
}

function frameRenderedLine(
	line: RenderedLine | undefined,
	width: number,
	theme: Theme,
	screenStyler: ScreenStyler,
): { line: RenderedLine | undefined; text: string; output: (row: number) => string } {
	if (width <= 0) return { line, text: "", output: () => "" };
	if (width === 1) {
		const border = colorize("│", {
			foreground: theme.colors.inputBorder,
		});
		return { line, text: "│", output: () => border };
	}

	const innerWidth = Math.max(0, width - 2);
	const innerText = padOrTrimPlain(line?.text ?? "", innerWidth);
	const innerLine = line ? frameInnerRenderedLine(line, innerText, innerWidth) : undefined;
	const leftBorder = colorize("│", {
		foreground: theme.colors.inputBorder,
	});
	const rightBorder = leftBorder;
	return {
		line,
		text: `│${innerText}│`,
		output: (row: number) => `${leftBorder}${screenStyler.styleBaseLine(row, innerLine, innerWidth)}${rightBorder}`,
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
