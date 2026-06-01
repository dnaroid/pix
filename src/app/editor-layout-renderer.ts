import type { InputEditor } from "../input-editor.js";
import type { Theme } from "../theme.js";
import {
	ABOVE_EDITOR_WIDGET_KEY_GROUPS,
	BUILT_IN_SUBAGENTS_WIDGET_KEYS,
	INPUT_MAX_ROWS,
	LEGACY_TODO_WIDGET_KEYS,
} from "./constants.js";
import { renderSubagentsPanel, renderTodoPanel } from "./editor-panels.js";
import { ellipsizeDisplay, horizontalPaddingLayout, padHorizontalText, sanitizeText } from "./render-text.js";
import { APP_ICONS } from "./icons.js";
import type {
	EditorLayout,
	ExtensionWidgetRegistration,
	ExtensionWidgetTheme,
	RenderedInput,
	RenderedLine,
	ScrollBarMetrics,
	SubagentsWidgetState,
	TodoDetails,
	WidgetPlacement,
	WidgetTuiHandle,
} from "./types.js";

const INPUT_FRAME_VERTICAL = "│";

export type EditorLayoutRendererHost = {
	readonly theme: Theme;
	readonly inputEditor: InputEditor;
	readonly extensionWidgets: ReadonlyMap<string, ExtensionWidgetRegistration>;
	readonly todoDetails: TodoDetails | undefined;
	readonly todoPanelExpanded: boolean;
	readonly subagentsPanelExpanded: boolean;
	readonly subagentsWidgetState: SubagentsWidgetState | undefined;
	readonly voicePartialText: string | undefined;
	renderExtensionInputComponent(width: number): string[] | undefined;
	extensionInputUsesEditor(): boolean;
	widgetTuiHandle(): WidgetTuiHandle;
	createExtensionTheme(): ExtensionWidgetTheme;
	suppressExtensionWidget(key: string): void;
};

export class EditorLayoutRenderer {
	constructor(private readonly host: EditorLayoutRendererHost) {}

	computeLayout(width: number, rows: number): EditorLayout {
		const maxAvailableInputRows = Math.max(1, rows - 5);
		const renderedInput = this.renderInput(width, Math.min(INPUT_MAX_ROWS, maxAvailableInputRows), maxAvailableInputRows);
		const maxEntityRows = Math.max(0, rows - renderedInput.lines.length - 4);
		const framedEntityWidth = inputFrameContentWidth(width);
		const aboveEditorEntities = this.renderAboveEditorEntities(framedEntityWidth);
		let aboveEditorLines = this.limitEntityLines(aboveEditorEntities.lines, maxEntityRows);
		if (aboveEditorEntities.hasWidgets && aboveEditorLines.length < maxEntityRows) {
			aboveEditorLines = [...aboveEditorLines, { text: "", variant: "normal" }];
		}
		const belowEditorLines = this.limitEntityLines(
			this.renderExtensionWidgets("belowEditor", framedEntityWidth),
			maxEntityRows - aboveEditorLines.length,
		);

		const inputBottomSeparatorRow = rows - 1;
		const belowEditorStartRow = inputBottomSeparatorRow - belowEditorLines.length;
		const inputStartRow = belowEditorStartRow - renderedInput.lines.length;
		const inputSeparatorRow = inputStartRow - aboveEditorLines.length - 1;

		return {
			renderedInput,
			aboveEditorLines,
			belowEditorLines,
			inputStartRow,
			inputSeparatorRow,
			inputBottomSeparatorRow,
			bodyHeight: Math.max(0, inputSeparatorRow - 1),
		};
	}

	private renderWidgetRegistration(widget: ExtensionWidgetRegistration, width: number): RenderedLine[] {
		try {
			const lines = Array.isArray(widget.content)
				? widget.content
				: this.renderWidgetComponent(widget, width);
			return lines.map((line) => ({ text: line, variant: "normal" as const }));
		} catch (error) {
			return [{ text: `${widget.key}: widget render failed: ${String(error)}`, variant: "error" }];
		}
	}

	private renderWidgetComponent(widget: ExtensionWidgetRegistration, width: number): string[] {
		const content = widget.content;
		if (typeof content !== "function") return [...content];
		const component = widget.component ?? content(this.host.widgetTuiHandle(), this.host.createExtensionTheme());
		widget.component = component;
		return component.render(width);
	}

	private renderAboveEditorEntities(width: number): { lines: RenderedLine[]; hasWidgets: boolean } {
		const todoPanelLines = renderTodoPanel(this.host.todoDetails, this.host.todoPanelExpanded, width, this.host.theme.colors);
		const hasBuiltInTodoPanel = todoPanelLines.length > 0;
		const subagentsPanelLines = renderSubagentsPanel(this.host.subagentsWidgetState, this.host.subagentsPanelExpanded, width, this.host.theme.colors);
		const hasBuiltInSubagentsPanel = subagentsPanelLines.length > 0;
		const lines: RenderedLine[] = [...todoPanelLines, ...subagentsPanelLines];
		let hasWidgets = lines.length > 0;
		const consumedWidgetKeys = new Set<string>();

		for (const widgetKeys of ABOVE_EDITOR_WIDGET_KEY_GROUPS) {
			const slotLines: RenderedLine[] = [];
			for (const key of widgetKeys) {
				if (hasBuiltInTodoPanel && LEGACY_TODO_WIDGET_KEYS.has(key)) {
					consumedWidgetKeys.add(key);
					this.host.suppressExtensionWidget(key);
					continue;
				}
				if (hasBuiltInSubagentsPanel && BUILT_IN_SUBAGENTS_WIDGET_KEYS.has(key)) {
					consumedWidgetKeys.add(key);
					this.host.suppressExtensionWidget(key);
					continue;
				}
				const widget = this.host.extensionWidgets.get(key);
				if (!widget || widget.placement !== "aboveEditor") continue;
				consumedWidgetKeys.add(key);
				const widgetLines = this.renderWidgetRegistration(widget, width);
				if (widgetLines.length > 0) hasWidgets = true;
				slotLines.push(...widgetLines);
			}

			lines.push(...slotLines);
		}

		for (const widget of this.host.extensionWidgets.values()) {
			if (widget.placement !== "aboveEditor" || consumedWidgetKeys.has(widget.key)) continue;
			if (hasBuiltInTodoPanel && LEGACY_TODO_WIDGET_KEYS.has(widget.key)) {
				this.host.suppressExtensionWidget(widget.key);
				continue;
			}
			if (hasBuiltInSubagentsPanel && BUILT_IN_SUBAGENTS_WIDGET_KEYS.has(widget.key)) {
				this.host.suppressExtensionWidget(widget.key);
				continue;
			}
			const widgetLines = this.renderWidgetRegistration(widget, width);
			if (widgetLines.length > 0) hasWidgets = true;
			lines.push(...widgetLines);
		}

		lines.push(...this.renderVoicePartial(width));

		return { lines, hasWidgets };
	}

	private renderVoicePartial(width: number): RenderedLine[] {
		const partial = this.host.voicePartialText?.trim();
		if (!partial) return [];

		const { left, contentWidth } = horizontalPaddingLayout(width);
		const text = ellipsizeDisplay(`${APP_ICONS.microphone} ${sanitizeText(partial)}`, contentWidth);
		return [{
			text: padHorizontalText(text, width),
			variant: "muted",
			segments: [{ start: left, end: left + APP_ICONS.microphone.length, foreground: this.host.theme.colors.error }],
		}];
	}

	private renderExtensionWidgets(placement: WidgetPlacement, width: number): RenderedLine[] {
		const lines: RenderedLine[] = [];
		for (const widget of this.host.extensionWidgets.values()) {
			if (widget.placement !== placement) continue;
			lines.push(...this.renderWidgetRegistration(widget, width));
		}
		return lines;
	}

	private limitEntityLines(lines: readonly RenderedLine[], maxRows: number): RenderedLine[] {
		if (maxRows <= 0) return [];
		if (lines.length <= maxRows) return [...lines];

		const hidden = lines.length - maxRows + 1;
		return [
			...lines.slice(0, Math.max(0, maxRows - 1)),
			{ text: `… +${hidden} more UI rows`, variant: "muted" },
		];
	}

	private renderInput(width: number, normalMaxRows: number, extensionMaxRows: number): RenderedInput {
		const { left, contentWidth } = horizontalPaddingLayout(width);
		const extensionLines = this.host.renderExtensionInputComponent(contentWidth);
		const hasExtensionInput = extensionLines !== undefined;
		const usesEditor = !hasExtensionInput || this.host.extensionInputUsesEditor();
		const maxRows = hasExtensionInput ? extensionMaxRows : normalMaxRows;
		const customLines = hasExtensionInput
			? this.limitExtensionInputLines(extensionLines, Math.max(0, maxRows - (usesEditor ? 1 : 0)))
			: [];
		const editorMaxRows = usesEditor ? Math.max(1, maxRows - customLines.length) : 1;
		const rendered = this.host.inputEditor.render(contentWidth, editorMaxRows, "", "");
		const visibleLines = rendered.visualLines.slice(rendered.scrollOffset, rendered.scrollOffset + editorMaxRows);
		const scrollBar = usesEditor
			? inputScrollBarMetrics(rendered.visualLines.length, visibleLines.length, rendered.scrollOffset)
			: undefined;
		const editorLines = usesEditor ? visibleLines.map((vl) => frameInputLine(padHorizontalText(vl.text, width))) : [];
		const editorTagSpans = usesEditor
			? visibleLines.map((vl) => vl.tagSpans.map((span) => ({
				start: span.start + left,
				end: span.end + left,
			})))
			: [];
		const paddedCustomLines = customLines.map((line) => frameInputLine(padHorizontalText(line, width)));
		return {
			lines: [...paddedCustomLines, ...editorLines],
			cursorRowOffset: customLines.length + rendered.cursorVisualRow - rendered.scrollOffset,
			cursorColumn: Math.min(width, left + rendered.cursorScreenCol),
			cursorVisible: usesEditor && rendered.cursorVisible,
			scrollOffset: rendered.scrollOffset,
			totalLineCount: rendered.visualLines.length,
			visibleRowCount: visibleLines.length,
			scrollBar,
			editorStartRowOffset: customLines.length,
			tagSpans: [
				...paddedCustomLines.map(() => []),
				...editorTagSpans,
			],
		};
	}

	private limitExtensionInputLines(lines: readonly string[], maxRows: number): string[] {
		if (maxRows <= 0) return [];
		if (lines.length <= maxRows) return [...lines];

		const hidden = lines.length - maxRows + 1;
		return [
			...lines.slice(0, Math.max(0, maxRows - 1)),
			`… +${hidden} more UI rows`,
		];
	}
}

function frameInputLine(line: string): string {
	if (line.length <= 0) return line;
	if (line.length === 1) return INPUT_FRAME_VERTICAL;
	return `${INPUT_FRAME_VERTICAL}${line.slice(1, -1)}${INPUT_FRAME_VERTICAL}`;
}

function inputFrameContentWidth(width: number): number {
	return Math.max(1, width - 2);
}

function inputScrollBarMetrics(totalLineCount: number, visibleRowCount: number, scrollOffset: number): ScrollBarMetrics | undefined {
	if (visibleRowCount <= 0 || totalLineCount <= visibleRowCount) return undefined;

	const thumbSize = Math.max(1, Math.min(visibleRowCount, Math.round((visibleRowCount * visibleRowCount) / totalLineCount)));
	const travel = Math.max(0, visibleRowCount - thumbSize);
	const maxScroll = Math.max(0, totalLineCount - visibleRowCount);
	const thumbOffset = travel === 0 ? 0 : Math.round((scrollOffset / maxScroll) * travel);
	return {
		top: thumbOffset,
		height: thumbSize,
		trackHeight: visibleRowCount,
	};
}
