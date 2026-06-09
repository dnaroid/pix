import { colorLine, type Theme } from "../../theme.js";
import { stringDisplayWidth } from "../../terminal-width.js";
import { resolveColor, resolveModelColor, type ModelColorsConfig } from "../../config.js";
import type { PopupMenu, PopupMenuItem } from "../../ui.js";
import {
	SLASH_COMMAND_DESCRIPTION_COLUMN,
} from "../constants.js";
import { APP_ICONS } from "../icons.js";
import type { ScreenStyler } from "../screen/screen-styler.js";
import type {
	Entry,
	ModelMenuValue,
	PixMenuItem,
	PixMenuOptions,
	QueueMessageMenuValue,
	RenderedLine,
	ResumeMenuValue,
	SlashCommand,
	StyledSegment,
	ThinkingMenuValue,
	UserMessageJumpMenuValue,
	UserMessageMenuValue,
} from "../types.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { ellipsizeDisplay, padOrTrimPlain, sanitizeText } from "./render-text.js";
import { modelProviderThemeColor, thinkingLevelThemeColor } from "./status-line-renderer.js";

const POPUP_MENU_ESCAPE_BUTTON = "Esc";
const POPUP_MENU_DESCRIPTION_GAP = "  ";
const POPUP_MENU_HEADER_SIDE_PADDING = 2;

export type PopupMenuRendererHost = {
	readonly theme: Theme;
	readonly screenStyler: ScreenStyler;
	readonly entries: readonly Entry[];
	readonly session: AgentSession | undefined;
	readonly modelColors?: ModelColorsConfig;
	readonly resumeLoading: boolean;
	readonly resumeSessionCount: number;
	readonly userMessageJumpLoading: boolean;
};

export class PopupMenuRenderer {
	constructor(private readonly host: PopupMenuRendererHost) {}

	popupMenuWidth(columns: number): number {
		return columns;
	}

	popupMenuMargin(columns: number): number {
		return columns > 44 ? 2 : 0;
	}

	effectivePopupMenuWidth(columns: number): number {
		const sideMargin = this.popupMenuMargin(columns);
		return Math.min(this.popupMenuWidth(columns), Math.max(1, columns - sideMargin * 2));
	}

	styleOverlayLine(row: number, line: RenderedLine, width: number, activeMenu: PopupMenu<unknown>): string {
		const colors = this.host.theme.colors;
		const margin = this.popupMenuMargin(width);
		const menuWidth = this.effectivePopupMenuWidth(width);
		const rightMargin = Math.max(0, width - margin - menuWidth);
		const selected = line.target?.kind === "popup-menu" && activeMenu.selectedIndex === line.target.index;
		const foreground = this.popupLineForeground(line);
		const background = this.popupLineBackground(line, selected);
		const plain = `${" ".repeat(margin)}${padOrTrimPlain(line.text, menuWidth)}${" ".repeat(rightMargin)}`;

		if (this.host.screenStyler.selectionRangeForRow(row, width)) {
			return this.host.screenStyler.styleLine(row, plain, width, { foreground, background });
		}

		return [
			colorLine("", margin, { background: colors.background }),
			line.segments && line.segments.length > 0
				? this.host.screenStyler.styleLineSegments(row, line.text, menuWidth, { foreground, background, bold: selected }, line.segments)
				: colorLine(line.text, menuWidth, { foreground, background, bold: selected }),
			colorLine("", rightMargin, { background: colors.background }),
		].join("");
	}

	overlayPlainText(line: RenderedLine, width: number): string {
		const margin = this.popupMenuMargin(width);
		const menuWidth = this.effectivePopupMenuWidth(width);
		const rightMargin = Math.max(0, width - margin - menuWidth);
		return `${" ".repeat(margin)}${padOrTrimPlain(line.text, menuWidth)}${" ".repeat(rightMargin)}`;
	}

	renderUserMessageMenu(
		width: number,
		menu: PopupMenu<UserMessageMenuValue>,
	): RenderedLine[] {
		const lines: RenderedLine[] = [this.popupMenuHeader("Message actions", width)];
		for (const item of menu.visibleItems()) {
			const marker = item.selected ? "▶ " : "  ";
			const text = `${marker}${this.labelDescriptionText(item.label, item.description, width - 2, 18)}`;
			const labelStart = 2;
			const labelEnd = Math.min(text.length, labelStart + item.label.length);
			const description = item.description ? sanitizeText(item.description).replace(/\s+/gu, " ") : "";
			const descriptionStart = description ? text.indexOf(description, labelEnd) : -1;
			const line: RenderedLine = {
				text,
				target: { kind: "popup-menu", index: item.index },
				segments: [
				...(item.selected ? [{ start: 0, end: 1, foreground: this.host.theme.colors.accent, bold: true }] : []),
				{
					start: labelStart,
					end: labelEnd,
					foreground: this.userMessageActionForeground(item.value),
					bold: item.selected,
				},
				...(descriptionStart >= 0
					? [{ start: descriptionStart, end: text.length, foreground: this.host.theme.colors.muted }]
					: []),
				],
			};
			lines.push(line);
		}
		return lines;
	}

	renderSlashCommandMenu(width: number, menu: PopupMenu<SlashCommand>): RenderedLine[] {
		const lines: RenderedLine[] = [this.popupMenuHeader("Commands", width)];
		const visibleItems = menu.visibleItems();
		if (!this.hasPopupActionItems(menu.items)) {
			lines.push({ text: "  No matching slash commands", variant: "muted" });
		}

		for (const item of visibleItems) {
			const marker = item.selected ? "▶ " : "  ";
			const text = `${marker}${this.labelDescriptionText(item.label, item.description, width - 2)}`;
			lines.push({
				text,
				variant: "normal",
				segments: this.itemHighlightSegments(item, text),
				target: { kind: "popup-menu", index: item.index },
			});
		}
		return lines;
	}

	renderModelMenu(width: number, menu: PopupMenu<ModelMenuValue>): RenderedLine[] {
		const lines: RenderedLine[] = [this.popupMenuHeader("Select model", width)];
		const visibleItems = menu.visibleItems();
		if (!this.hasPopupActionItems(menu.items)) {
			lines.push({
				text: this.host.session ? "  No matching favorite models" : "  Model menu unavailable",
				variant: "muted",
			});
		}

		for (const item of visibleItems) {
			const marker = item.selected ? "▶ " : "  ";
			const text = `${marker}${this.labelDescriptionText(item.label, item.description, width - 2)}`;
			lines.push({
				text,
				variant: this.selectableItemVariant(item.value),
				segments: [...this.modelMenuItemSegments(item.value), ...this.itemHighlightSegments(item, text)],
				target: { kind: "popup-menu", index: item.index },
			});
		}
		return lines;
	}

	renderThinkingMenu(width: number, menu: PopupMenu<ThinkingMenuValue>): RenderedLine[] {
		const lines: RenderedLine[] = [this.popupMenuHeader("Thinking level", width)];
		const visibleItems = menu.visibleItems();
		if (!this.hasPopupActionItems(menu.items)) {
			lines.push({ text: "  No matching thinking levels", variant: "muted" });
		}

		for (const item of visibleItems) {
			const marker = item.selected ? "▶ " : "  ";
			const text = `${marker}${this.labelDescriptionText(item.label, item.description, width - 2)}`;
			lines.push({
				text,
				variant: this.selectableItemVariant(item.value),
				segments: this.thinkingMenuItemSegments(item.value),
				target: { kind: "popup-menu", index: item.index },
			});
		}
		return lines;
	}

	renderResumeMenu(
		width: number,
		menu: PopupMenu<ResumeMenuValue>,
		state: { directQuery: string; allSessionsLoaded: boolean; loadedSessionCount: number },
	): RenderedLine[] {
		const title = this.host.resumeLoading ? `Resume session ${APP_ICONS.timerSand}` : "Resume session";
		const lines: RenderedLine[] = [this.popupMenuHeader(title, width)];
		const visibleItems = menu.visibleItems();
		if (!this.host.resumeLoading && !this.hasPopupActionItems(menu.items)) {
			lines.push({
				text: this.host.resumeSessionCount === 0 ? "  No sessions found" : "  No matching sessions",
				variant: "muted",
			});
		}

		for (const item of visibleItems) {
			const label = item.label;
			const description = item.description ?? "";
			const marker = item.selected ? "▶ " : "  ";
			const text = `${marker}${label}  ${description}`;
			const segments = [...(this.resumeMenuItemSegments(item.value, label, description, text) ?? []), ...this.itemHighlightSegments(item, text)];
			lines.push({
				text,
				variant: "normal",
				...(segments.length === 0 ? {} : { segments }),
				target: { kind: "popup-menu", index: item.index },
			});
		}

		if (!state.allSessionsLoaded && state.loadedSessionCount > 0) {
			lines.push({ text: `  Loaded ${state.loadedSessionCount} sessions · scroll for more`, variant: "muted" });
		}

		if (state.directQuery) {
			lines.push({ text: `  Search: ${state.directQuery}`, variant: "muted" });
		}

		return lines;
	}

	renderUserMessageJumpMenu(width: number, menu: PopupMenu<UserMessageJumpMenuValue>, directQuery: string): RenderedLine[] {
		const lines: RenderedLine[] = [this.popupMenuHeader("Jump to user message", width)];
		if (this.host.userMessageJumpLoading) {
			lines.push({ text: `  ${APP_ICONS.timerSand} Loading user messages`, variant: "muted" });
		} else if (!this.hasPopupActionItems(menu.items)) {
			lines.push({
				text: this.host.entries.some((entry) => entry.kind === "user") ? "  No matching user messages" : "  No user messages yet",
				variant: "muted",
			});
		}

		const labelWidth = Math.max(1, width - 2);
		for (const item of menu.visibleItems()) {
			const label = ellipsizeDisplay(item.label, labelWidth);
			const marker = item.selected ? "▶ " : "  ";
			const text = `${marker}${label}`;
			lines.push({
				text,
				variant: "normal",
				segments: this.itemHighlightSegments(item, text),
				target: { kind: "popup-menu", index: item.index },
			});
		}

		if (directQuery) {
			lines.push({ text: `  Search: ${directQuery}`, variant: "muted" });
		}
		return lines;
	}

	renderQueueMessageMenu(width: number, menu: PopupMenu<QueueMessageMenuValue>): RenderedLine[] {
		const lines: RenderedLine[] = [this.popupMenuHeader("Queued message", width)];
		for (const item of menu.visibleItems()) {
			const marker = item.selected ? "▶ " : "  ";
			lines.push({
				text: `${marker}${this.labelDescriptionText(item.label, item.description, width - 2, 16)}`,
				variant: this.queueMessageItemVariant(item.value),
				target: { kind: "popup-menu", index: item.index },
			});
		}
		return lines;
	}

	renderSdkMenu(
		width: number,
		menu: PopupMenu<PixMenuItem<unknown>>,
		request: { options: PixMenuOptions } | undefined,
		directQuery: string,
	): RenderedLine[] {
		const lines: RenderedLine[] = [this.popupMenuHeader(request?.options.title ?? "Menu", width)];
		if (!this.hasPopupActionItems(menu.items)) {
			lines.push({ text: `  ${request?.options.emptyText ?? "No matching items"}`, variant: "muted" });
		}

		for (const item of menu.visibleItems()) {
			const marker = item.selected ? "▶ " : "  ";
			const text = `${marker}${this.labelDescriptionText(item.label, item.description, width - 2)}`;
			const segments = this.sdkMenuItemSegments(item, text);
			lines.push({
				text,
				variant: this.sdkItemVariant(item.value),
				...(segments.length === 0 ? {} : { segments }),
				target: { kind: "popup-menu", index: item.index },
			});
		}

		if (request?.options.searchable !== false && directQuery) {
			lines.push({ text: `  ${request?.options.placeholder ?? "Search"}: ${directQuery}`, variant: "muted" });
		}

		return lines;
	}

	private hasPopupActionItems<T>(items: readonly PopupMenuItem<T>[]): boolean {
		return items.length > 0;
	}

	private labelDescriptionText(label: string, description: string | undefined, width: number, labelColumn = SLASH_COMMAND_DESCRIPTION_COLUMN): string {
		const safeLabel = sanitizeText(label).replace(/\s+/gu, " ");
		const safeDescription = description ? sanitizeText(description).replace(/\s+/gu, " ") : "";
		if (!safeDescription) return ellipsizeDisplay(safeLabel, width);

		const gapWidth = stringDisplayWidth(POPUP_MENU_DESCRIPTION_GAP);
		const labelDisplayWidth = stringDisplayWidth(safeLabel);
		const descriptionDisplayWidth = stringDisplayWidth(safeDescription);
		if (width <= gapWidth + 1) return ellipsizeDisplay(safeLabel, width);

		if (labelDisplayWidth <= labelColumn && labelColumn + gapWidth + descriptionDisplayWidth <= width) {
			return `${safeLabel}${" ".repeat(labelColumn - labelDisplayWidth)}${POPUP_MENU_DESCRIPTION_GAP}${safeDescription}`;
		}

		if (labelDisplayWidth + gapWidth + descriptionDisplayWidth <= width) {
			return `${safeLabel}${POPUP_MENU_DESCRIPTION_GAP}${safeDescription}`;
		}

		const labelWidth = descriptionDisplayWidth < width - gapWidth - 1
			? Math.max(1, width - gapWidth - descriptionDisplayWidth)
			: Math.max(1, Math.min(labelColumn, width - gapWidth - 1));
		const visibleLabel = ellipsizeDisplay(safeLabel, labelWidth);
		const padding = " ".repeat(Math.max(0, labelWidth - stringDisplayWidth(visibleLabel)));
		return `${visibleLabel}${padding}${POPUP_MENU_DESCRIPTION_GAP}${safeDescription}`;
	}

	private userMessageActionForeground(value: UserMessageMenuValue): string {
		if (value === "undo") return this.host.theme.colors.error;
		return this.host.theme.colors.inputForeground;
	}

	private selectableItemVariant(value: ModelMenuValue | ThinkingMenuValue): NonNullable<RenderedLine["variant"]> {
		return value.current ? "muted" : "normal";
	}

	private thinkingMenuItemSegments(value: ThinkingMenuValue): StyledSegment[] {
		const markerOffset = 2; // "▶ " or "  "
		return [{
			start: markerOffset,
			end: markerOffset + value.level.length,
			foreground: thinkingLevelThemeColor(value.level, this.host.theme.colors, this.availableThinkingLevels()),
		}];
	}

	private modelMenuItemSegments(value: ModelMenuValue): StyledSegment[] {
		const markerOffset = 2; // "▶ " or "  "
		return [{
			start: markerOffset,
			end: markerOffset + value.ref.length,
			foreground: this.modelMenuItemColor(value),
		}];
	}

	private modelMenuItemColor(value: ModelMenuValue): string {
		const configuredColor = this.host.modelColors
			? resolveModelColor(value.ref, this.host.modelColors)
			: undefined;
		return configuredColor
			? resolveColor(configuredColor, this.host.theme.colors)
			: modelProviderThemeColor(value.model.provider, this.host.theme.colors);
	}

	private availableThinkingLevels(): string[] {
		const levels = this.host.session?.getAvailableThinkingLevels();
		return Array.isArray(levels) && levels.length > 0 ? levels.map(String) : ["off", "minimal", "low", "medium", "high", "xhigh"];
	}

	private queueMessageItemVariant(value: QueueMessageMenuValue): NonNullable<RenderedLine["variant"]> {
		return value === "cancel" ? "error" : "normal";
	}

	private sdkItemVariant(value: PixMenuItem<unknown>): NonNullable<RenderedLine["variant"]> {
		return value.variant ?? "normal";
	}

	private sdkMenuItemSegments(item: PopupMenuItem<PixMenuItem<unknown>>, text: string): StyledSegment[] {
		return [
			...this.highlightSegments(item.labelHighlightRanges ?? item.value.labelHighlightRanges ?? [], text, 2),
			...this.descriptionHighlightSegments(item.description, item.descriptionHighlightRanges ?? item.value.descriptionHighlightRanges ?? [], text),
		];
	}

	private itemHighlightSegments(item: PopupMenuItem<unknown>, text: string): StyledSegment[] {
		return this.highlightSegments(item.labelHighlightRanges ?? [], text, 2);
	}

	private highlightSegments(ranges: readonly { start: number; end: number }[], text: string, markerOffset: number): StyledSegment[] {
		if (ranges.length === 0) return [];
		return ranges.flatMap((range): StyledSegment[] => {
			const start = Math.max(markerOffset, markerOffset + range.start);
			const end = Math.min(text.length, markerOffset + range.end);
			if (end <= start) return [];
			return [{
				start,
				end,
				foreground: this.host.theme.colors.accent,
				bold: true,
			}];
		});
	}

	private descriptionHighlightSegments(description: string | undefined, ranges: readonly { start: number; end: number }[], text: string): StyledSegment[] {
		if (!description || ranges.length === 0) return [];
		const safeDescription = sanitizeText(description).replace(/\s+/gu, " ");
		const descriptionStart = text.indexOf(safeDescription, 2);
		if (descriptionStart < 0) return [];
		return this.highlightSegments(ranges, text, descriptionStart);
	}

	private resumeMenuItemSegments(value: ResumeMenuValue, label: string, description: string, text: string): StyledSegment[] | undefined {
		if (value.kind !== "session") return undefined;

		const sessionLabel = value.session.name ?? value.session.firstMessage.slice(0, 50);
		const markerOffset = 2; // "▶ " or "  "
		const sessionLabelStart = Math.max(0, label.length - sessionLabel.length) + markerOffset;
		const muted = this.host.theme.colors.popupMuted;
		const segments: StyledSegment[] = [];

		if (sessionLabelStart > markerOffset) segments.push({ start: markerOffset, end: sessionLabelStart, foreground: muted });
		if (description.length > 0) segments.push({ start: markerOffset + label.length, end: text.length, foreground: muted });

		return segments.length > 0 ? segments : undefined;
	}

	private popupMenuHeader(title: string, width: number): RenderedLine {
		return {
			text: formatPopupMenuHeader(title, width),
			variant: "accent",
			backgroundOverride: this.host.theme.colors.popupHeaderBackground,
			target: { kind: "popup-menu-close" },
		};
	}

	private popupLineForeground(line: RenderedLine): string {
		const colors = this.host.theme.colors;
		if (line.colorOverride) return line.colorOverride;

		switch (line.variant) {
			case "accent":
				return colors.accent;
			case "muted":
				return colors.popupMuted;
			case "error":
				return colors.error;
			case "normal":
			case undefined:
				return colors.popupForeground;
		}
		return colors.popupForeground;
	}

	private popupLineBackground(line: RenderedLine, selected: boolean): string {
		const colors = this.host.theme.colors;
		if (selected) return colors.popupSelectedBackground;
		return line.backgroundOverride ?? colors.popupBackground;
	}
}

export function formatPopupMenuHeader(title: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const sanitizedTitle = sanitizeText(title).replace(/\s+/g, " ").trim() || "Menu";
	const buttonWidth = stringDisplayWidth(POPUP_MENU_ESCAPE_BUTTON);

	if (safeWidth <= buttonWidth + 1) return padOrTrimPlain(POPUP_MENU_ESCAPE_BUTTON, safeWidth);

	const sidePadding = safeWidth >= buttonWidth + POPUP_MENU_HEADER_SIDE_PADDING * 2 + 2
		? POPUP_MENU_HEADER_SIDE_PADDING
		: 1;
	const contentWidth = Math.max(1, safeWidth - sidePadding * 2);
	if (contentWidth <= buttonWidth + 1) {
		return padOrTrimPlain(`${" ".repeat(sidePadding)}${POPUP_MENU_ESCAPE_BUTTON}`, safeWidth);
	}

	const titleWidth = contentWidth - buttonWidth - 1;
	const titleText = ellipsizeDisplay(sanitizedTitle, titleWidth);
	const gapWidth = Math.max(1, contentWidth - stringDisplayWidth(titleText) - buttonWidth);
	return `${" ".repeat(sidePadding)}${titleText}${" ".repeat(gapWidth)}${POPUP_MENU_ESCAPE_BUTTON}${" ".repeat(sidePadding)}`;
}
