import { applyOutputFilters, type PixConfig } from "../../config.js";
import { renderMarkdownTextLines } from "../../markdown-format.js";
import type { Theme } from "../../theme.js";
import { attachImageClickTargets } from "../screen/image-click-targets.js";
import { APP_ICONS } from "../icons.js";
import { horizontalPaddingLayout, padHorizontalText, wrapTextLines } from "./render-text.js";
import { renderConversationShellEntry } from "./conversation-shell-renderer.js";
import { renderConversationToolEntry, renderThinkingEntry } from "./conversation-tool-renderer.js";
import type { Entry, RenderedLine, StyledSegment } from "../types.js";

export type InlineUserMessageMenuContext = {
	userContentWidth: number;
	userContentLeft: number;
	userLine: (text: string, entryId?: string, syntaxHighlight?: RenderedLine["syntaxHighlight"]) => RenderedLine;
};

export type ConversationEntryRenderOptions = {
	cwd: string;
	colors: Theme["colors"];
	pixConfig: PixConfig;
	outputFilters: readonly RegExp[];
	availableThinkingLevels?: readonly string[];
	superCompactTools?: boolean;
	allThinkingExpanded?: boolean;
	currentTimeMs?: number;
	renderInlineUserMessageMenu: (entry: Extract<Entry, { kind: "user" }>, context: InlineUserMessageMenuContext) => RenderedLine[];
	renderExtensionEntry?: (entry: Extract<Entry, { kind: "extension-entry" }>, width: number) => RenderedLine[];
};

export function renderConversationEntry(entry: Entry, width: number, options: ConversationEntryRenderOptions): RenderedLine[] {
	const { left: userContentLeft, contentWidth: userContentWidth } = horizontalPaddingLayout(width);
	const userLine = (
		text: string,
		entryId?: string,
		syntaxHighlight?: RenderedLine["syntaxHighlight"],
		segments?: RenderedLine["segments"],
	): RenderedLine => ({
		text: padHorizontalText(text, width),
		colorOverride: options.colors.userForeground,
		backgroundOverride: options.colors.userMessageBackground,
		...(segments && segments.length > 0 ? { segments: segments.map((segment) => ({ ...segment, start: segment.start + userContentLeft, end: segment.end + userContentLeft })) } : {}),
		...(syntaxHighlight === undefined ? {} : { syntaxHighlight }),
		...(entryId === undefined ? {} : { target: { kind: "user-message" as const, id: entryId } }),
	});
	const queuedLine = (text: string, entryId: string, segments?: readonly StyledSegment[]): RenderedLine => ({
		text,
		colorOverride: options.colors.userForeground,
		...(segments && segments.length > 0 ? { segments } : {}),
		target: { kind: "queue-message" as const, id: entryId },
	});
	const userMessageLines = (userEntry: Extract<Entry, { kind: "user" }>): RenderedLine[] => {
		const lines = renderMarkdownTextLines(userEntry.text, userContentWidth, userContentLeft).map((line) =>
			({
				...userLine(line.text, userEntry.id, line.syntaxHighlight, line.segments),
				...(line.copyText === undefined ? {} : { copyText: line.copyText }),
				...(line.continuesOnNextLine ? { continuesOnNextLine: true } : {}),
			}),
		);

		return attachImageClickTargets(lines, userEntry.id, userEntry.images, { foreground: options.colors.info, underline: true });
	};
	const queuedMessageLines = (queuedEntry: Extract<Entry, { kind: "queued" }>): RenderedLine[] => {
		const icon = queuedEntry.queueSource === "deferred" ? APP_ICONS.pause : APP_ICONS.timerSand;
		const contentLines = wrapTextLines(`${icon} ${queuedEntry.text}`, width);
		return contentLines.map((line, index) => ({
			...queuedLine(line.text, queuedEntry.id, index === 0 ? [{ start: 0, end: icon.length, foreground: options.colors.info }] : undefined),
			copyText: line.copyText,
			...(line.continuesOnNextLine ? { continuesOnNextLine: true } : {}),
		}));
	};

	switch (entry.kind) {
		case "system":
			return wrapTextLines(`system: ${entry.text}`, width).map((line) => ({ text: line.text, copyText: line.copyText, ...(line.continuesOnNextLine ? { continuesOnNextLine: true } : {}), variant: "muted" as const }));
		case "user":
			return userMessageLines(entry);
		case "queued":
			return queuedMessageLines(entry);
		case "assistant":
			return renderAssistantLines(entry.text, width, options);
		case "custom":
			return renderCustomEntry(entry, width);
		case "extension-entry":
			return options.renderExtensionEntry?.(entry, width) ?? [];
		case "session-aborted":
			return wrapTextLines(entry.text, width).map((line) => ({ text: line.text, copyText: line.copyText, ...(line.continuesOnNextLine ? { continuesOnNextLine: true } : {}), variant: "error" as const }));
		case "shell":
			return renderConversationShellEntry(entry, width, options);
		case "thinking":
			return renderThinkingEntry(entry, width, options);
		case "error":
			return wrapTextLines(`error: ${entry.text}`, width).map((line) => ({ text: line.text, copyText: line.copyText, ...(line.continuesOnNextLine ? { continuesOnNextLine: true } : {}), variant: "error" as const }));
		case "tool":
			return renderConversationToolEntry(entry, width, options);
	}
}

function renderCustomEntry(entry: Extract<Entry, { kind: "custom" }>, width: number): RenderedLine[] {
	const label = `[${entry.customType}]`;
	return wrapTextLines(`${label}\n${entry.text}`, width).map((line, index) => ({
		text: line.text,
		copyText: line.copyText,
		...(line.continuesOnNextLine ? { continuesOnNextLine: true } : {}),
		variant: index === 0 ? "accent" as const : "normal" as const,
	}));
}

function renderAssistantLines(text: string, width: number, options: ConversationEntryRenderOptions): RenderedLine[] {
	const displayText = applyOutputFilters(text, options.outputFilters).trimEnd();
	if (!displayText) return [];
	const { left: contentLeft, contentWidth } = horizontalPaddingLayout(width);
	const contentLines = renderMarkdownTextLines(displayText, contentWidth, contentLeft, { preserveWrappedWordSeparator: true });
	if (contentLines.length === 0) return [];
	const lines: RenderedLine[] = [];
	for (const line of contentLines) {
		const headingSegment: StyledSegment | undefined = line.heading
			? { start: contentLeft, end: contentLeft + line.text.length, foreground: options.colors.assistantForeground, bold: true }
			: undefined;
		const existingSegments = line.segments?.map((segment) => ({ ...segment, start: segment.start + contentLeft, end: segment.end + contentLeft })) ?? [];
		const allSegments = headingSegment ? [headingSegment, ...existingSegments] : existingSegments;
		lines.push({
			text: padHorizontalText(line.text, width),
			...(line.copyText === undefined ? {} : { copyText: line.copyText }),
			...(line.continuesOnNextLine ? { continuesOnNextLine: true } : {}),
			colorOverride: options.colors.assistantForeground,
			backgroundOverride: options.colors.assistantMessageBackground,
			...(allSegments.length > 0 ? { segments: allSegments } : {}),
			...(line.syntaxHighlight ? { syntaxHighlight: line.syntaxHighlight } : {}),
		});
	}
	return lines;
}
