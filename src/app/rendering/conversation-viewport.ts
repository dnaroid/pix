import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { resolveToolRule, type PixConfig } from "../../config.js";
import { stringDisplayWidth } from "../../terminal-width.js";
import type { Theme } from "../../theme.js";
import { renderConversationEntry as renderConversationEntryLines, type InlineUserMessageMenuContext } from "./conversation-entry-renderer.js";
import { horizontalPaddingLayout, shortHash } from "./render-text.js";
import type { ConversationBlockCache, Entry, RenderedLine, SubmittedUserMessage } from "../types.js";

export type ConversationViewportHost = {
	readonly entries: readonly Entry[];
	readonly session: AgentSession | undefined;
	readonly deferredUserMessages: readonly SubmittedUserMessage[];
	readonly entryRenderVersions: ReadonlyMap<string, number>;
	readonly cwd: string;
	readonly colors: Theme["colors"];
	readonly pixConfig: PixConfig;
	readonly outputFilters: readonly RegExp[];
	readonly superCompactTools?: boolean;
	readonly allThinkingExpanded?: boolean;
	hasDynamicConversationBlock?(): boolean;
	isDynamicConversationBlock(entry: Entry): boolean;
	renderInlineUserMessageMenu(entry: Extract<Entry, { kind: "user" }>, context: InlineUserMessageMenuContext): RenderedLine[];
};

type ViewportLayoutCache = {
	entries: readonly Entry[];
	entryIds: string[];
	lineCounts: number[];
	measuredLineCounts: boolean[];
	offsets: number[];
	positions: Map<string, number>;
	dirtyEntryIds: Set<string>;
	totalLineCount: number;
	queuedSignature: string;
	superCompactTools: boolean;
	allThinkingExpanded: boolean;
};

export type ConversationEntryBlockPosition = {
	entry: Entry;
	offset: number;
	lineCount: number;
	block: ConversationBlockCache;
};

export class ConversationViewport {
	private readonly blockCachesByWidth = new Map<number, Map<string, ConversationBlockCache>>();
	private readonly layoutCachesByWidth = new Map<number, ViewportLayoutCache>();

	constructor(private readonly host: ConversationViewportHost) {}

	clear(): void {
		this.blockCachesByWidth.clear();
		this.layoutCachesByWidth.clear();
	}

	deleteEntry(entryId: string): void {
		for (const blockCache of this.blockCachesByWidth.values()) blockCache.delete(entryId);
		for (const layoutCache of this.layoutCachesByWidth.values()) layoutCache.dirtyEntryIds.add(entryId);
	}

	lineCount(width: number): number {
		return this.layoutForWidth(width).totalLineCount;
	}

	slice(width: number, start: number, count: number): RenderedLine[] {
		if (count <= 0) return [];

		for (let attempt = 0; attempt < 4; attempt += 1) {
			const layout = this.layoutForWidth(width);
			const visible = this.sliceMeasured(layout, width, start, count);
			if (!visible.changed) return visible.lines;
		}

		const layout = this.layoutForWidth(width);
		return this.sliceMeasured(layout, width, start, count, { allowLayoutChanges: false }).lines;
	}

	private sliceMeasured(
		layout: ViewportLayoutCache,
		width: number,
		start: number,
		count: number,
		options: { allowLayoutChanges?: boolean } = {},
	): { lines: RenderedLine[]; changed: boolean } {
		const allowLayoutChanges = options.allowLayoutChanges !== false;

		const visible: RenderedLine[] = [];
		const end = start + count;
		let entryIndex = this.entryIndexForOffset(layout.offsets, start);

		for (; entryIndex < layout.entries.length; entryIndex += 1) {
			const entry = layout.entries[entryIndex]!;
			if (allowLayoutChanges && this.ensureEntryMeasured(layout, width, entryIndex)) return { lines: [], changed: true };

			const block = this.blockForEntry(entry, width);
			const blockLineCount = layout.lineCounts[entryIndex] ?? 0;
			if (blockLineCount === 0) continue;

			const offset = layout.offsets[entryIndex] ?? 0;
			const blockEnd = offset + blockLineCount;
			if (blockEnd <= start) continue;

			const localStart = Math.max(0, start - offset);
			const localEnd = Math.min(blockLineCount, end - offset);
			for (let lineIndex = localStart; lineIndex < localEnd; lineIndex += 1) {
				visible.push(lineIndex < block.lines.length ? block.lines[lineIndex]! : { text: "" });
			}

			if (visible.length >= count) break;
		}

		return { lines: visible, changed: false };
	}

	entries(): Entry[] {
		const queued = this.queuedEntries();
		return queued.length === 0 ? [...this.host.entries] : [...this.host.entries, ...queued];
	}

	blockForEntry(entry: Entry, width: number): ConversationBlockCache {
		const blockCache = this.blockCacheForWidth(width);
		const version = (this.host.entryRenderVersions.get(entry.id) ?? 0)
			+ (this.host.superCompactTools ? 1_000_000_000 : 0)
			+ (this.host.allThinkingExpanded ? 2_000_000_000 : 0);
		const cached = blockCache.get(entry.id);
		const dynamic = this.host.isDynamicConversationBlock(entry);
		if (!dynamic && cached?.version === version) return cached;

		const lines = renderConversationEntryLines(entry, width, {
			cwd: this.host.cwd,
			colors: this.host.colors,
			pixConfig: this.host.pixConfig,
			outputFilters: this.host.outputFilters,
			superCompactTools: Boolean(this.host.superCompactTools),
			allThinkingExpanded: Boolean(this.host.allThinkingExpanded),
			renderInlineUserMessageMenu: (userEntry, context) => this.host.renderInlineUserMessageMenu(userEntry, context),
		});
		const block = {
			version,
			lines,
			lineCount: lines.length,
		};
		if (!dynamic) blockCache.set(entry.id, block);
		return block;
	}

	entryBlockPositions(width: number): ConversationEntryBlockPosition[] {
		const layout = this.layoutForWidth(width);
		for (let index = 0; index < layout.entries.length; index += 1) this.ensureEntryMeasured(layout, width, index);
		return layout.entries.map((entry, index) => ({
			entry,
			offset: layout.offsets[index] ?? 0,
			lineCount: layout.lineCounts[index] ?? 0,
			block: this.blockForEntry(entry, width),
		}));
	}

	measuredLineCountForEntries(width: number, entryIds: readonly string[]): number {
		if (entryIds.length === 0) return 0;

		const layout = this.layoutForWidth(width);
		const indexes = [...new Set(entryIds
			.map((entryId) => layout.positions.get(entryId))
			.filter((index): index is number => index !== undefined))]
			.sort((left, right) => left - right);

		let lineCount = 0;
		for (const index of indexes) {
			this.ensureEntryMeasured(layout, width, index);
			lineCount += layout.lineCounts[index] ?? 0;
		}
		return lineCount;
	}

	private queuedEntries(): Entry[] {
		const session = this.host.session;
		const entries: Entry[] = [];

		for (const [index, text] of (session?.getSteeringMessages() ?? []).entries()) {
			entries.push({
				id: `queued-sdk-steering-${index}-${shortHash(text)}`,
				kind: "queued",
				mode: "steering",
				text,
				queueSource: "sdk-steering",
				queueIndex: index,
			});
		}

		for (const [index, text] of (session?.getFollowUpMessages() ?? []).entries()) {
			entries.push({
				id: `queued-sdk-follow-up-${index}-${shortHash(text)}`,
				kind: "queued",
				mode: "follow-up",
				text,
				queueSource: "sdk-follow-up",
				queueIndex: index,
			});
		}

		for (const [index, message] of this.host.deferredUserMessages.entries()) {
			entries.push({
				id: `${message.id}-${index}`,
				kind: "queued",
				mode: "steering",
				text: message.displayText,
				queueSource: "deferred",
				queueIndex: index,
			});
		}

		return entries;
	}

	private layoutForWidth(width: number): ViewportLayoutCache {
		const queued = this.queuedEntries();
		const entries = queued.length === 0 ? this.host.entries : [...this.host.entries, ...queued];
		const queuedSignature = queued.map((entry) => entry.id).join("\n");
		const superCompactTools = Boolean(this.host.superCompactTools);
		const allThinkingExpanded = Boolean(this.host.allThinkingExpanded);

		let layout = this.layoutCachesByWidth.get(width);
		if (!layout || this.layoutStructureChanged(layout, entries, queuedSignature, superCompactTools, allThinkingExpanded)) {
			layout = this.buildLayout(entries, width, queuedSignature, superCompactTools, allThinkingExpanded);
			this.layoutCachesByWidth.set(width, layout);
		} else {
			this.refreshDirtyLayoutEntries(layout, width);
		}

		if (this.host.hasDynamicConversationBlock?.()) {
			this.refreshDynamicLayoutEntries(layout, width);
		}

		return layout;
	}

	private buildLayout(entries: readonly Entry[], width: number, queuedSignature: string, superCompactTools: boolean, allThinkingExpanded: boolean): ViewportLayoutCache {
		const entryIds: string[] = [];
		const lineCounts: number[] = [];
		const measuredLineCounts: boolean[] = [];
		const offsets: number[] = [];
		const positions = new Map<string, number>();
		let totalLineCount = 0;
		const estimatedBlockLineCounts = entries.map((entry) => this.estimatedBlockLineCountForEntry(entry, width));

		for (const [index, entry] of entries.entries()) {
			entryIds.push(entry.id);
			positions.set(entry.id, index);
			offsets.push(totalLineCount);
			const lineCount = this.lineCountWithGap(entry, estimatedBlockLineCounts[index] ?? 0, this.nextEstimatedVisibleEntry(entries, estimatedBlockLineCounts, index));
			lineCounts.push(lineCount);
			measuredLineCounts.push(false);
			totalLineCount += lineCount;
		}

		offsets.push(totalLineCount);
		return { entries, entryIds, lineCounts, measuredLineCounts, offsets, positions, dirtyEntryIds: new Set(), totalLineCount, queuedSignature, superCompactTools, allThinkingExpanded };
	}

	private layoutStructureChanged(layout: ViewportLayoutCache, entries: readonly Entry[], queuedSignature: string, superCompactTools: boolean, allThinkingExpanded: boolean): boolean {
		if (layout.entries.length !== entries.length || layout.queuedSignature !== queuedSignature || layout.superCompactTools !== superCompactTools || layout.allThinkingExpanded !== allThinkingExpanded) return true;
		if (layout.entries.length === 0) return false;

		return layout.entryIds[0] !== entries[0]?.id || layout.entryIds[layout.entryIds.length - 1] !== entries[entries.length - 1]?.id;
	}

	private refreshDirtyLayoutEntries(layout: ViewportLayoutCache, width: number): void {
		if (layout.dirtyEntryIds.size === 0) return;

		const indexes = new Set<number>();
		for (const entryId of layout.dirtyEntryIds) {
			const position = layout.positions.get(entryId);
			if (position === undefined) continue;
			indexes.add(position);
			if (position > 0) indexes.add(position - 1);
		}
		for (const position of [...indexes].sort((left, right) => left - right)) this.refreshLayoutEntry(layout, width, position, true);
		layout.dirtyEntryIds.clear();
	}

	private blockCacheForWidth(width: number): Map<string, ConversationBlockCache> {
		let blockCache = this.blockCachesByWidth.get(width);
		if (!blockCache) {
			blockCache = new Map();
			this.blockCachesByWidth.set(width, blockCache);
		}
		return blockCache;
	}

	private refreshDynamicLayoutEntries(layout: ViewportLayoutCache, width: number): void {
		for (let index = 0; index < layout.entries.length; index += 1) {
			if (this.host.isDynamicConversationBlock(layout.entries[index]!)) this.refreshLayoutEntry(layout, width, index, true);
		}
	}

	private ensureEntryMeasured(layout: ViewportLayoutCache, width: number, index: number): boolean {
		const entry = layout.entries[index];
		if (!entry) return false;
		if (layout.measuredLineCounts[index] === true && !this.host.isDynamicConversationBlock(entry)) return false;
		return this.refreshLayoutEntry(layout, width, index, true);
	}

	private refreshLayoutEntry(layout: ViewportLayoutCache, width: number, index: number, measure: boolean): boolean {
		const entry = layout.entries[index];
		if (!entry) return false;

		const previousLineCount = layout.lineCounts[index] ?? 0;
		const nextLineCount = measure
			? this.measuredLineCountForEntry(entry, layout.entries, index, width)
			: this.estimatedLineCountForEntry(entry, layout.entries, index, width);
		layout.measuredLineCounts[index] = measure;
		if (previousLineCount === nextLineCount) return false;

		const delta = nextLineCount - previousLineCount;
		layout.lineCounts[index] = nextLineCount;
		layout.totalLineCount += delta;
		for (let offsetIndex = index + 1; offsetIndex < layout.offsets.length; offsetIndex += 1) {
			layout.offsets[offsetIndex] = (layout.offsets[offsetIndex] ?? 0) + delta;
		}
		return true;
	}

	private measuredLineCountForEntry(entry: Entry, entries: readonly Entry[], index: number, width: number): number {
		const block = this.blockForEntry(entry, width);
		return this.lineCountWithGap(entry, block.lineCount, this.nextVisibleEntry(entries, index, width));
	}

	private estimatedLineCountForEntry(entry: Entry, entries: readonly Entry[], index: number, width: number): number {
		const blockLineCount = this.estimatedBlockLineCountForEntry(entry, width);
		const blockLineCounts = entries.map((candidate) => this.estimatedBlockLineCountForEntry(candidate, width));
		return this.lineCountWithGap(entry, blockLineCount, this.nextEstimatedVisibleEntry(entries, blockLineCounts, index));
	}

	private lineCountWithGap(entry: Entry, blockLineCount: number, nextEntry: Entry | undefined): number {
		if (blockLineCount === 0) return 0;
		return blockLineCount + (this.gapAfterEntry(entry, nextEntry) ? 1 : 0);
	}

	private estimatedBlockLineCountForEntry(entry: Entry, width: number): number {
		if (width <= 0) return 0;
		switch (entry.kind) {
			case "assistant":
				return estimateWrappedLineCount(entry.text, width);
			case "system":
			case "error":
			case "custom":
			case "session-aborted":
				return estimateWrappedLineCount(entry.text, width);
			case "user": {
				const { contentWidth } = horizontalPaddingLayout(width);
				return 2 + estimateWrappedLineCount(entry.text, contentWidth);
			}
			case "queued": {
				const { contentWidth } = horizontalPaddingLayout(width);
				return estimateWrappedLineCount(entry.text, contentWidth);
			}
			case "thinking": {
				const expanded = entry.expanded || this.host.allThinkingExpanded === true;
				return expanded ? 1 + estimateWrappedLineCount(entry.text, Math.max(1, width - 2)) : 1;
			}
			case "shell":
				return estimateToolLikeLineCount("shell", entry.expanded, `${entry.output}\n${entry.status}`, width, this.host.pixConfig, this.host.superCompactTools === true, true);
			case "tool":
				return estimateToolLikeLineCount(entry.toolName, entry.expanded, entry.output, width, this.host.pixConfig, this.host.superCompactTools === true, false);
			default:
				return 1;
		}
	}

	private nextVisibleEntry(entries: readonly Entry[], index: number, width: number): Entry | undefined {
		for (let nextIndex = index + 1; nextIndex < entries.length; nextIndex += 1) {
			const nextEntry = entries[nextIndex];
			if (!nextEntry) continue;
			if (this.blockForEntry(nextEntry, width).lineCount > 0) return nextEntry;
		}
		return undefined;
	}

	private nextEstimatedVisibleEntry(entries: readonly Entry[], lineCounts: readonly number[], index: number): Entry | undefined {
		for (let nextIndex = index + 1; nextIndex < entries.length; nextIndex += 1) {
			const nextEntry = entries[nextIndex];
			if (!nextEntry) continue;
			if ((lineCounts[nextIndex] ?? 0) > 0) return nextEntry;
		}
		return undefined;
	}

	private gapAfterEntry(entry: Entry, nextEntry: Entry | undefined): boolean {
		if (!this.host.superCompactTools) return true;
		if (!nextEntry) return false;
		return !(this.isSuperCompactGaplessEntry(entry) || this.isSuperCompactGaplessEntry(nextEntry));
	}

	private isSuperCompactGaplessEntry(entry: Entry): boolean {
		return entry.kind === "tool" || entry.kind === "thinking" || entry.kind === "shell";
	}

	private entryIndexForOffset(offsets: readonly number[], start: number): number {
		let low = 0;
		let high = Math.max(0, offsets.length - 2);
		let result = 0;

		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			if ((offsets[mid + 1] ?? 0) <= start) {
				low = mid + 1;
			} else {
				result = mid;
				high = mid - 1;
			}
		}

		return result;
	}
}

function estimateWrappedLineCount(text: string, width: number): number {
	const safeWidth = Math.max(1, width);
	if (!text) return 0;
	let count = 0;
	for (const line of text.split("\n")) {
		const displayWidth = stringDisplayWidth(line);
		count += Math.max(1, Math.ceil(displayWidth / safeWidth));
	}
	return count;
}

function estimateToolLikeLineCount(
	toolName: string,
	expanded: boolean,
	output: string,
	width: number,
	pixConfig: PixConfig,
	superCompactTools: boolean,
	includeStatusLine: boolean,
): number {
	const rule = resolveToolRule(toolName, pixConfig.toolRenderer);
	if (rule.hidden) return 0;
	if (expanded) return 1 + estimateWrappedLineCount(output, Math.max(1, width - 2));
	if (rule.compactHidden || (rule.defaultExpanded === true && !superCompactTools)) return 1;
	const bodyLineCount = estimateWrappedLineCount(output, Math.max(1, width - 2));
	const previewLineCount = Math.min(rule.previewLines, bodyLineCount);
	const extraStatusLine = includeStatusLine && output.trimEnd().length === 0 ? 1 : 0;
	return superCompactTools ? 1 : 1 + Math.max(extraStatusLine, previewLineCount);
}
