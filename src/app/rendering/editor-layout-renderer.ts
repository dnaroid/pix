import type { InputEditor } from "../../input-editor.js";
import type { Theme } from "../../theme.js";
import {
	ABOVE_EDITOR_WIDGET_KEY_GROUPS,
	BUILT_IN_SUBAGENTS_WIDGET_KEYS,
	LEGACY_TODO_WIDGET_KEYS,
} from "../constants.js";
import { renderSubagentsPanel, renderTodoPanel } from "./editor-panels.js";
import { ellipsizeDisplay, horizontalPaddingLayout, padHorizontalText, sanitizeText, wrapText } from "./render-text.js";
import { APP_ICONS } from "../icons.js";
import type {
	EditorLayout,
	Entry,
	ExtensionWidgetRegistration,
	ExtensionWidgetTheme,
	RenderedInput,
	RenderedLine,
	ScrollBarMetrics,
	SubagentsWidgetState,
	TodoDetails,
	WidgetPlacement,
	WidgetTuiHandle,
} from "../types.js";
export type EditorLayoutRendererHost = {
	readonly theme: Theme;
	readonly inputEditor: InputEditor;
	readonly extensionWidgets: ReadonlyMap<string, ExtensionWidgetRegistration>;
	readonly todoDetails: TodoDetails | undefined;
	readonly todoPanelExpanded: boolean;
	readonly subagentsPanelExpanded: boolean;
	readonly subagentsWidgetState: SubagentsWidgetState | undefined;
	readonly voicePartialText: string | undefined;
	readonly autocompleteSuggestion: string | undefined;
	readonly queuedMessageWidgetEntries: readonly Extract<Entry, { kind: "queued" }>[];
	renderExtensionInputComponent(width: number): string[] | undefined;
	extensionInputUsesEditor(): boolean;
	widgetTuiHandle(): WidgetTuiHandle;
	createExtensionTheme(): ExtensionWidgetTheme;
	suppressExtensionWidget(key: string): void;
};

export class EditorLayoutRenderer {
	constructor(private readonly host: EditorLayoutRendererHost) {}

	computeLayout(width: number, rows: number): EditorLayout {
		const maxAvailableInputRows = Math.max(1, rows - 4);
		const maxComposerRows = Math.max(1, Math.min(maxAvailableInputRows, Math.floor(rows * 0.7)));
		const renderedInput = this.renderInput(width, maxComposerRows, maxComposerRows);
		const maxEntityRows = Math.max(0, rows - renderedInput.lines.length - 4);
		const editorEntityWidth = inputFrameContentWidth(width);
		const aboveEditorEntities = this.renderAboveEditorEntities(editorEntityWidth);
		let aboveEditorLines = this.limitEntityLines(aboveEditorEntities.lines, maxEntityRows);
		if (aboveEditorEntities.hasWidgets && aboveEditorLines.length < maxEntityRows) {
			aboveEditorLines = [...aboveEditorLines, { text: "", variant: "normal" }];
		}
		const belowEditorLines = this.limitEntityLines(
			this.renderExtensionWidgets("belowEditor", editorEntityWidth),
			maxEntityRows - aboveEditorLines.length,
		);

		const belowEditorStartRow = rows - belowEditorLines.length;
		const inputBottomSeparatorRow = belowEditorStartRow - 1;
		const inputStartRow = inputBottomSeparatorRow - renderedInput.lines.length;
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
		const queuedMessageWidgetLines = this.renderQueuedMessageWidgets(width);
		const lines: RenderedLine[] = [...todoPanelLines, ...subagentsPanelLines, ...queuedMessageWidgetLines];
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

	private renderQueuedMessageWidgets(width: number): RenderedLine[] {
		const lines: RenderedLine[] = [];
		for (const entry of this.host.queuedMessageWidgetEntries) {
			const icon = entry.queueSource === "deferred" ? APP_ICONS.pause : APP_ICONS.timerSand;
			const wrapped = wrapText(`${icon} ${sanitizeText(entry.text)}`, width);
			for (const [index, text] of wrapped.entries()) {
				lines.push({
					text: padHorizontalText(text, width),
					colorOverride: this.host.theme.colors.userForeground,
					target: { kind: "queue-message", id: entry.id },
					...(index === 0 ? { segments: [{ start: 0, end: icon.length, foreground: this.host.theme.colors.info }] } : {}),
				});
			}
		}
		return lines;
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
		const rendered = this.host.inputEditor.render(contentWidth, editorMaxRows, "", "", usesEditor ? this.host.autocompleteSuggestion ?? "" : "");
		const visibleLines = rendered.visualLines.slice(rendered.scrollOffset, rendered.scrollOffset + editorMaxRows);
		const scrollBar = usesEditor
			? inputScrollBarMetrics(rendered.visualLines.length, visibleLines.length, rendered.scrollOffset)
			: undefined;
		const editorLines = usesEditor ? visibleLines.map((vl) => padHorizontalText(vl.text, width)) : [];
		const editorTagSpans = usesEditor
			? visibleLines.map((vl) => vl.tagSpans.map((span) => ({
				start: span.start + left,
				end: span.end + left,
			})))
			: [];
		const editorSuggestionSpans = usesEditor
			? visibleLines.map((vl) => (vl.suggestionSpans ?? []).map((span) => ({
				start: span.start + left,
				end: span.end + left,
			})))
			: [];
		const paddedCustomLines = customLines.map((line) => padHorizontalText(line, width));
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
			suggestionSpans: [
				...paddedCustomLines.map(() => []),
				...editorSuggestionSpans,
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

function inputFrameContentWidth(width: number): number {
	return Math.max(1, width);
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
