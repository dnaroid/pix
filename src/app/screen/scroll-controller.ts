import type { ConversationViewport } from "../rendering/conversation-viewport.js";
import type { EditorLayoutRenderer } from "../rendering/editor-layout-renderer.js";
import { sanitizeText } from "../rendering/render-text.js";
import type { Entry, RenderedLine } from "../types.js";

export type AppScrollMetrics = {
	bodyHeight: number;
	viewportColumns: number;
	conversationLineCount: number;
	maxScroll: number;
	start: number;
};

export type ConversationTextScrollTarget = {
	entryId?: string;
	needles: readonly string[];
};

export type AppScrollState = {
	scrollFromBottom: number;
	detachedScrollStart?: number;
};

export type AppScrollControllerHost = {
	conversationViewport(): ConversationViewport;
	editorLayoutRenderer(): EditorLayoutRenderer;
	terminalColumns(): number;
	terminalRows(): number;
	tabPanelRows(terminalRows: number): number;
	hasOlderSessionHistory?(): boolean;
	isLoadingOlderSessionHistory?(): boolean;
	loadOlderSessionHistory?(options?: { render?: boolean; onPrependedEntries?: (entries: readonly Entry[]) => void }): Promise<boolean>;
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

	scrollToBottom(): boolean {
		const changed = this.scrollFromBottom !== 0 || this.detachedScrollStart !== undefined;
		this.scrollFromBottom = 0;
		this.detachedScrollStart = undefined;
		return changed;
	}

	scrollToTop(): boolean {
		const columns = this.host.terminalColumns();
		const terminalRows = this.host.terminalRows();
		const rows = editorLayoutRows(terminalRows, this.host.tabPanelRows(terminalRows));
		const { bodyHeight } = this.host.editorLayoutRenderer().computeLayout(columns, rows);
		const metrics = this.scrollMetrics(columns, bodyHeight);
		return this.setScrollStart(0, metrics);
	}

	async scrollToAbsoluteTop(): Promise<boolean> {
		let loadedOlder = false;
		while (this.host.hasOlderSessionHistory?.() === true && this.host.isLoadingOlderSessionHistory?.() !== true) {
			const loaded = await this.host.loadOlderSessionHistory?.({ render: false });
			if (!loaded) break;
			loadedOlder = true;
			this.host.render();
			await yieldToEventLoop();
		}

		return this.scrollToTop() || loadedOlder;
	}

	quickScrollDirections(columns: number, bodyHeight: number): { up: boolean; down: boolean } {
		if (bodyHeight <= 0) return { up: false, down: false };

		const metrics = this.scrollMetrics(columns, bodyHeight);
		return {
			up: metrics.start > 0 || this.host.hasOlderSessionHistory?.() === true,
			down: metrics.start < metrics.maxScroll,
		};
	}

	captureState(): AppScrollState {
		return {
			scrollFromBottom: this.scrollFromBottom,
			...(this.detachedScrollStart === undefined ? {} : { detachedScrollStart: this.detachedScrollStart }),
		};
	}

	restoreState(state: AppScrollState): void {
		this.scrollFromBottom = Math.max(0, state.scrollFromBottom);
		this.detachedScrollStart = state.detachedScrollStart === undefined
			? undefined
			: Math.max(0, state.detachedScrollStart);
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
		const shouldLoadOlderHistory = this.shouldLoadOlderHistory(delta, metrics);
		const { conversationLineCount, maxScroll } = metrics;
		const nextScrollFromBottom = Math.max(0, Math.min(maxScroll, this.scrollFromBottom + -delta));
		let changed = false;
		if (nextScrollFromBottom === this.scrollFromBottom) {
			if (nextScrollFromBottom === 0 && this.detachedScrollStart !== undefined && delta > 0) {
				this.detachedScrollStart = undefined;
				changed = true;
			} else if (!shouldLoadOlderHistory) {
				return false;
			}
		} else {
			this.scrollFromBottom = nextScrollFromBottom;
			this.detachedScrollStart = nextScrollFromBottom === 0
				? undefined
				: Math.max(0, conversationLineCount - bodyHeight - nextScrollFromBottom);
			changed = true;
		}

		if (shouldLoadOlderHistory) this.loadOlderHistoryAnchored(metrics, { render: shouldRender });
		if (shouldRender) this.host.render();
		return changed || shouldLoadOlderHistory;
	}

	private shouldLoadOlderHistory(delta: number, metrics: AppScrollMetrics): boolean {
		if (delta >= 0) return false;
		if (metrics.start > this.olderHistoryThresholdLines) return false;
		if (this.host.hasOlderSessionHistory?.() !== true) return false;
		if (this.host.isLoadingOlderSessionHistory?.() === true) return false;
		return true;
	}

	private loadOlderHistoryAnchored(metrics: AppScrollMetrics, options: { render: boolean }): void {
		void this.host.loadOlderSessionHistory?.({
			render: false,
			onPrependedEntries: (entries) => {
				const prependedLineCount = this.host.conversationViewport().measuredLineCountForEntries(metrics.viewportColumns, entries.map((entry) => entry.id));
				if (prependedLineCount > 0 && this.detachedScrollStart !== undefined) this.detachedScrollStart += prependedLineCount;
			},
		}).then((loaded) => {
			if (loaded && options.render) this.host.render();
		});
	}

	adjustForHistoryWindowPrune(edge: "top" | "bottom", lineCount: number): void {
		if (lineCount <= 0) return;
		if (edge !== "top") return;
		if (this.detachedScrollStart === undefined) return;

		this.detachedScrollStart = Math.max(0, this.detachedScrollStart - lineCount);
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

	private setScrollStart(start: number, metrics: AppScrollMetrics): boolean {
		const nextStart = Math.max(0, Math.min(metrics.maxScroll, start));
		const nextScrollFromBottom = Math.max(0, metrics.conversationLineCount - metrics.bodyHeight - nextStart);
		const nextDetachedScrollStart = nextScrollFromBottom === 0 ? undefined : nextStart;
		const changed = this.scrollFromBottom !== nextScrollFromBottom || this.detachedScrollStart !== nextDetachedScrollStart;
		this.scrollFromBottom = nextScrollFromBottom;
		this.detachedScrollStart = nextDetachedScrollStart;
		return changed;
	}

	private viewportColumns(columns: number, _bodyHeight: number): number {
		const safeColumns = Math.max(1, columns);
		return safeColumns;
	}
}

async function yieldToEventLoop(): Promise<void> {
	await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
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
