import { applyOutputFilters, type PixConfig } from "../../config.js";
import { renderMarkdownTextLines } from "../../markdown-format.js";
import type { Theme } from "../../theme.js";
import { attachImageClickTargets } from "../screen/image-click-targets.js";
import { APP_ICONS } from "../icons.js";
import { horizontalPaddingLayout, padHorizontalText, wrapText } from "./render-text.js";
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
	superCompactTools?: boolean;
	allThinkingExpanded?: boolean;
	renderInlineUserMessageMenu: (entry: Extract<Entry, { kind: "user" }>, context: InlineUserMessageMenuContext) => RenderedLine[];
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
		colorOverride: options.colors.inputForeground,
		backgroundOverride: options.colors.userMessageBackground,
		...(segments && segments.length > 0 ? { segments: segments.map((segment) => ({ ...segment, start: segment.start + userContentLeft, end: segment.end + userContentLeft })) } : {}),
		...(syntaxHighlight === undefined ? {} : { syntaxHighlight }),
		...(entryId === undefined ? {} : { target: { kind: "user-message" as const, id: entryId } }),
	});
	const queuedLine = (text: string, entryId: string, segments?: readonly StyledSegment[]): RenderedLine => ({
		text,
		variant: "muted" as const,
		backgroundOverride: options.colors.userMessageBackground,
		...(segments && segments.length > 0 ? { segments } : {}),
		target: { kind: "queue-message" as const, id: entryId },
	});
	const userMessageLines = (userEntry: Extract<Entry, { kind: "user" }>): RenderedLine[] => {
		const lines = [
			userLine("", userEntry.id),
			...renderMarkdownTextLines(userEntry.text, userContentWidth, userContentLeft).map((line) =>
				userLine(line.text, userEntry.id, line.syntaxHighlight, line.segments),
			),
		];

		lines.push(...options.renderInlineUserMessageMenu(userEntry, { userContentWidth, userContentLeft, userLine }));
		lines.push(userLine("", userEntry.id));
		return attachImageClickTargets(lines, userEntry.id, userEntry.images, { foreground: options.colors.info, underline: true });
	};
	const queuedMessageLines = (queuedEntry: Extract<Entry, { kind: "queued" }>): RenderedLine[] => {
		const icon = queuedEntry.queueSource === "deferred" ? APP_ICONS.pause : APP_ICONS.timerSand;
		const contentLines = wrapText(`${icon} ${queuedEntry.text}`, width);
		return contentLines.map((text, index) => queuedLine(text, queuedEntry.id, index === 0 ? [{ start: 0, end: icon.length, foreground: options.colors.info }] : undefined));
	};

	switch (entry.kind) {
		case "system":
			return wrapText(`system: ${entry.text}`, width).map((text) => ({ text, variant: "muted" as const }));
		case "user":
			return userMessageLines(entry);
		case "queued":
			return queuedMessageLines(entry);
		case "assistant":
			return renderAssistantLines(entry.text, width, options);
		case "custom":
			return renderCustomEntry(entry, width);
		case "session-aborted":
			return wrapText(entry.text, width).map((text) => ({ text, variant: "error" as const }));
		case "shell":
			return renderConversationShellEntry(entry, width, options);
		case "thinking":
			return renderThinkingEntry(entry, width, options);
		case "error":
			return wrapText(`error: ${entry.text}`, width).map((text) => ({ text, variant: "error" as const }));
		case "tool":
			return renderConversationToolEntry(entry, width, options);
	}
}

function renderCustomEntry(entry: Extract<Entry, { kind: "custom" }>, width: number): RenderedLine[] {
	const label = `[${entry.customType}]`;
	return wrapText(`${label}\n${entry.text}`, width).map((text, index) => ({
		text,
		variant: index === 0 ? "accent" as const : "normal" as const,
	}));
}

function renderAssistantLines(text: string, width: number, options: ConversationEntryRenderOptions): RenderedLine[] {
	const displayText = applyOutputFilters(text, options.outputFilters).trimEnd();
	if (!displayText) return [];
	const { left: contentLeft, contentWidth } = horizontalPaddingLayout(width);
	const background = options.colors.assistantMessageBackground;
	const contentLines = renderMarkdownTextLines(displayText, contentWidth, contentLeft);
	if (contentLines.length === 0) return [];
	const lines: RenderedLine[] = [{ text: padHorizontalText("", width), backgroundOverride: background }];
	for (const line of contentLines) {
		lines.push({
			text: padHorizontalText(line.text, width),
			colorOverride: options.colors.assistantForeground,
			backgroundOverride: background,
			...(line.segments && line.segments.length > 0 ? { segments: line.segments.map((segment) => ({ ...segment, start: segment.start + contentLeft, end: segment.end + contentLeft })) } : {}),
			...(line.syntaxHighlight ? { syntaxHighlight: line.syntaxHighlight } : {}),
		});
	}
	lines.push({ text: padHorizontalText("", width), backgroundOverride: background });
	return lines;
}
