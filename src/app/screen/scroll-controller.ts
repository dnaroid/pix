import type { ConversationViewport } from "../rendering/conversation-viewport.js";
import type { EditorLayoutRenderer } from "../rendering/editor-layout-renderer.js";
import { sanitizeText } from "../rendering/render-text.js";
import type { RenderedLine } from "../types.js";

export type AppScrollMetrics = {
	bodyHeight: number;
	viewportColumns: number;
	conversationLineCount: number;
	maxScroll: number;
	start: number;
};

export type AppScrollBarMetrics = {
	thumbStartRow: number;
	thumbEndRow: number;
};

export type ConversationTextScrollTarget = {
	entryId?: string;
	needles: readonly string[];
};

export type AppScrollControllerHost = {
	conversationViewport(): ConversationViewport;
	editorLayoutRenderer(): EditorLayoutRenderer;
	terminalColumns(): number;
	terminalRows(): number;
	tabPanelRows(terminalRows: number): number;
	hasOlderSessionHistory?(): boolean;
	isLoadingOlderSessionHistory?(): boolean;
	loadOlderSessionHistory?(options?: { render?: boolean }): Promise<boolean>;
	render(): void;
};

export class AppScrollController {
	private scrollFromBottom = 0;
	private detachedScrollStart: number | undefined;
	private readonly olderHistoryThresholdLines = 8;

	constructor(private readonly host: AppScrollControllerHost) {}

	reset(): void {
		this.scrollFromBottom = 0;
		this.detachedScrollStart = undefined;
	}

	conversationView(columns: number, bodyHeight: number): { lines: RenderedLine[]; metrics: AppScrollMetrics } {
		const metrics = this.scrollMetrics(columns, bodyHeight);
		return {
			lines: this.host.conversationViewport().slice(metrics.viewportColumns, metrics.start, bodyHeight),
			metrics,
		};
	}

	visibleConversationLines(columns: number, bodyHeight: number): RenderedLine[] {
		return this.conversationView(columns, bodyHeight).lines;
	}

	scrollMetrics(columns: number, bodyHeight: number): AppScrollMetrics {
		const conversationViewport = this.host.conversationViewport();
		const viewportColumns = this.viewportColumns(columns, bodyHeight);
		const conversationLineCount = conversationViewport.lineCount(viewportColumns);
		const maxScroll = Math.max(0, conversationLineCount - bodyHeight);
		let start: number;
		if (this.detachedScrollStart !== undefined) {
			start = Math.max(0, Math.min(maxScroll, this.detachedScrollStart));
			this.scrollFromBottom = Math.max(0, conversationLineCount - bodyHeight - start);
			this.detachedScrollStart = start >= maxScroll ? undefined : start;
		} else {
			this.scrollFromBottom = Math.min(this.scrollFromBottom, maxScroll);
			start = Math.max(0, conversationLineCount - bodyHeight - this.scrollFromBottom);
		}
		return { bodyHeight, viewportColumns, conversationLineCount, maxScroll, start };
	}

	scrollBarForMetrics(metrics: AppScrollMetrics): AppScrollBarMetrics | undefined {
		if (metrics.bodyHeight <= 0 || metrics.maxScroll <= 0 || metrics.conversationLineCount <= metrics.bodyHeight) return undefined;

		const thumbSize = Math.max(1, Math.min(metrics.bodyHeight, Math.round((metrics.bodyHeight * metrics.bodyHeight) / metrics.conversationLineCount)));
		const travel = Math.max(0, metrics.bodyHeight - thumbSize);
		const thumbOffset = travel === 0 ? 0 : Math.round((metrics.start / metrics.maxScroll) * travel);
		return {
			thumbStartRow: thumbOffset + 1,
			thumbEndRow: thumbOffset + thumbSize,
		};
	}

	scrollBarMetrics(columns: number, bodyHeight: number): AppScrollBarMetrics | undefined {
		return this.scrollBarForMetrics(this.scrollMetrics(columns, bodyHeight));
	}

	scrollByPage(direction: -1 | 1): void {
		const rows = this.host.terminalRows();
		this.scrollByLines(direction * Math.max(1, editorLayoutRows(rows, this.host.tabPanelRows(rows)) - 4));
	}

	scrollByLines(delta: number, options: { render?: boolean } = {}): boolean {
		const shouldRender = options.render ?? true;
		const columns = this.host.terminalColumns();
		const terminalRows = this.host.terminalRows();
		const rows = editorLayoutRows(terminalRows, this.host.tabPanelRows(terminalRows));
		const { bodyHeight } = this.host.editorLayoutRenderer().computeLayout(columns, rows);
		const metrics = this.scrollMetrics(columns, bodyHeight);
		this.maybeLoadOlderHistory(delta, metrics, { render: shouldRender });
		const { conversationLineCount, maxScroll } = metrics;
		const nextScrollFromBottom = Math.max(0, Math.min(maxScroll, this.scrollFromBottom + -delta));
		if (nextScrollFromBottom === this.scrollFromBottom) {
			if (nextScrollFromBottom === 0 && this.detachedScrollStart !== undefined && delta > 0) {
				this.detachedScrollStart = undefined;
				if (shouldRender) this.host.render();
				return true;
			}
			return false;
		}

		this.scrollFromBottom = nextScrollFromBottom;
		this.detachedScrollStart = nextScrollFromBottom === 0
			? undefined
			: Math.max(0, conversationLineCount - bodyHeight - nextScrollFromBottom);
		if (shouldRender) this.host.render();
		return true;
	}

	private maybeLoadOlderHistory(delta: number, metrics: AppScrollMetrics, options: { render: boolean }): void {
		if (delta >= 0) return;
		if (metrics.start > this.olderHistoryThresholdLines) return;
		if (this.host.hasOlderSessionHistory?.() !== true) return;
		if (this.host.isLoadingOlderSessionHistory?.() === true) return;
		void this.host.loadOlderSessionHistory?.({ render: options.render });
	}

	scrollToScrollbarPosition(bodyRow: number): boolean {
		const columns = this.host.terminalColumns();
		const terminalRows = this.host.terminalRows();
		const rows = editorLayoutRows(terminalRows, this.host.tabPanelRows(terminalRows));
		const { bodyHeight } = this.host.editorLayoutRenderer().computeLayout(columns, rows);
		const metrics = this.scrollMetrics(columns, bodyHeight);
		if (!this.scrollBarForMetrics(metrics)) return false;

		const clampedRow = Math.max(0, Math.min(Math.max(0, bodyHeight - 1), bodyRow));
		const ratio = bodyHeight <= 1 ? 0 : clampedRow / (bodyHeight - 1);
		const start = Math.round(metrics.maxScroll * ratio);
		return this.scrollToStart(start, metrics);
	}

	scrollToConversationEntry(entryId: string): boolean {
		const columns = this.host.terminalColumns();
		const terminalRows = this.host.terminalRows();
		const rows = editorLayoutRows(terminalRows, this.host.tabPanelRows(terminalRows));
		const conversationViewport = this.host.conversationViewport();
		const { bodyHeight } = this.host.editorLayoutRenderer().computeLayout(columns, rows);
		const metrics = this.scrollMetrics(columns, bodyHeight);
		const position = conversationViewport.entryBlockPositions(metrics.viewportColumns).find((candidate) => candidate.entry.id === entryId);
		if (!position) return false;

		this.setScrollStart(position.offset, metrics);
		this.host.render();
		return true;
	}

	scrollToConversationText(target: ConversationTextScrollTarget): boolean {
		const needles = normalizeLineSearchNeedles(target.needles);
		if (needles.length === 0) return target.entryId ? this.scrollToConversationEntry(target.entryId) : false;

		const columns = this.host.terminalColumns();
		const terminalRows = this.host.terminalRows();
		const rows = editorLayoutRows(terminalRows, this.host.tabPanelRows(terminalRows));
		const conversationViewport = this.host.conversationViewport();
		const { bodyHeight } = this.host.editorLayoutRenderer().computeLayout(columns, rows);
		const metrics = this.scrollMetrics(columns, bodyHeight);
		const positions = conversationViewport.entryBlockPositions(metrics.viewportColumns);

		const targetPosition = target.entryId
			? positions.find((position) => position.entry.id === target.entryId)
			: undefined;
		const targetMatch = targetPosition ? lineMatchInPosition(targetPosition, needles) : undefined;
		if (targetMatch) {
			this.setScrollStart(targetMatch.start, metrics);
			this.host.render();
			return true;
		}

		if (targetPosition) {
			this.setScrollStart(targetPosition.offset, metrics);
			this.host.render();
			return true;
		}

		const anyMatch = positions
			.map((position) => lineMatchInPosition(position, needles))
			.find((match) => match !== undefined);
		if (anyMatch) {
			this.setScrollStart(anyMatch.start, metrics);
			this.host.render();
			return true;
		}

		return false;
	}

	private scrollToStart(start: number, metrics: AppScrollMetrics): boolean {
		if (!this.setScrollStart(start, metrics)) return false;
		this.host.render();
		return true;
	}

	private setScrollStart(start: number, metrics: AppScrollMetrics): boolean {
		const nextStart = Math.max(0, Math.min(metrics.maxScroll, start));
		const nextScrollFromBottom = Math.max(0, metrics.conversationLineCount - metrics.bodyHeight - nextStart);
		const nextDetachedScrollStart = nextScrollFromBottom === 0 ? undefined : nextStart;
		const changed = this.scrollFromBottom !== nextScrollFromBottom || this.detachedScrollStart !== nextDetachedScrollStart;
		this.scrollFromBottom = nextScrollFromBottom;
		this.detachedScrollStart = nextDetachedScrollStart;
		return changed;
	}

	private viewportColumns(columns: number, bodyHeight: number): number {
		const safeColumns = Math.max(1, columns);
		if (safeColumns <= 1 || bodyHeight <= 0) return safeColumns;

		const lineCountWithoutScrollbar = this.host.conversationViewport().lineCount(safeColumns);
		return lineCountWithoutScrollbar > bodyHeight ? safeColumns - 1 : safeColumns;
	}
}

function editorLayoutRows(terminalRows: number, tabPanelRows: number): number {
	return Math.max(1, terminalRows - tabPanelRows);
}

function normalizeLineSearchNeedles(needles: readonly string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const needle of needles) {
		const value = normalizeLineSearchText(needle);
		if (!value || seen.has(value)) continue;
		seen.add(value);
		normalized.push(value);
	}
	return normalized;
}

function normalizeLineSearchText(text: string): string {
	return sanitizeText(text).replace(/…/gu, " ").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function lineMatchInPosition(
	position: ReturnType<ConversationViewport["entryBlockPositions"]>[number],
	needles: readonly string[],
): { start: number } | undefined {
	const lineIndex = lineIndexForNeedles(position.block.lines, needles);
	return lineIndex === undefined ? undefined : { start: position.offset + lineIndex };
}

function lineIndexForNeedles(lines: readonly RenderedLine[], needles: readonly string[]): number | undefined {
	const normalizedLines = lines.map((line) => normalizeLineSearchText(line.text));
	for (const needle of needles) {
		const directIndex = normalizedLines.findIndex((line) => line.includes(needle));
		if (directIndex >= 0) return directIndex;

		const maxWindowSize = Math.min(4, normalizedLines.length);
		for (let windowSize = 2; windowSize <= maxWindowSize; windowSize += 1) {
			for (let start = 0; start <= normalizedLines.length - windowSize; start += 1) {
				const windowText = normalizedLines.slice(start, start + windowSize).join(" ").replace(/\s+/gu, " ").trim();
				if (windowText.includes(needle)) return start;
			}
		}
	}
	return undefined;
}
