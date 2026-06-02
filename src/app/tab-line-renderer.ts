import { stringDisplayWidth } from "../terminal-width.js";
import type { Theme } from "../theme.js";
import { APP_ICONS } from "./icons.js";
import { ellipsizeDisplay } from "./render-text.js";
import type { ScreenStyler } from "./screen-styler.js";
import type { SessionTab, StyledSegment, TabLineLayout, TabLineTarget } from "./types.js";

export type TabLineRendererHost = {
	readonly theme: Theme;
	readonly screenStyler: ScreenStyler;
	readonly tabs: readonly SessionTab[];
};

type TabButtonLayout = {
	text: string;
	statusStart: number;
	statusEnd: number;
	closeStart: number;
	closeEnd: number;
};

const TAB_SEPARATOR = "│";
const ACTIVE_TAB_LEFT_EDGE = "▌";
const ACTIVE_TAB_RIGHT_EDGE = "▐";
const TAB_PANEL_BACKGROUND = "#f3f4f6";
const INACTIVE_TAB_FOREGROUND = "#000000";
const EMPTY_NEW_TAB_PREFIX = "  ";
const DEFAULT_SESSION_TITLE_PATTERN = /^session [0-9a-f]{8}$/iu;
export const TAB_PANEL_ROWS = 1;

export function tabPanelRows(tabLineVisible: boolean, terminalRows: number, _tabCount = TAB_PANEL_ROWS): number {
	if (!tabLineVisible) return 0;
	const desiredRows = TAB_PANEL_ROWS;
	return Math.min(desiredRows, Math.max(0, terminalRows - 1));
}

export class TabLineRenderer {
	constructor(private readonly host: TabLineRendererHost) {}

	panelRows(terminalRows: number): number {
		return tabPanelRows(true, terminalRows, this.host.tabs.length);
	}

	layout(width: number): TabLineLayout {
		if (width <= 0) return { text: "", segments: [], targets: [], separatorColumns: [] };

		const tabs = this.host.tabs;
		const tabSeparators = tabs.slice(1).map((tab, index) => this.tabSeparatorText(tabs[index]?.status === "active", tab.status === "active"));
		const tabSeparatorsWidth = tabSeparators.reduce((sum, separator) => sum + stringDisplayWidth(separator), 0);
		const newTabWidth = stringDisplayWidth(APP_ICONS.plus);
		const newTabPrefix = this.newTabPrefixText();
		const newTabPrefixWidth = stringDisplayWidth(newTabPrefix);
		const tabsWidth = Math.max(0, width - newTabWidth - newTabPrefixWidth);
		const naturalButtons = tabs.map((tab) => this.buttonLayout(tab));
		const naturalWidth = naturalButtons.reduce((sum, button) => sum + stringDisplayWidth(button.text), 0)
			+ tabSeparatorsWidth;
		const buttonMaxWidth = naturalWidth <= tabsWidth
			? undefined
			: Math.max(7, Math.floor(Math.max(1, tabsWidth - tabSeparatorsWidth) / tabs.length));
		const buttons = buttonMaxWidth === undefined ? naturalButtons : tabs.map((tab) => this.buttonLayout(tab, buttonMaxWidth));
		const segments: StyledSegment[] = [];
		const targets: TabLineTarget[] = [];
		const separatorColumns: number[] = [];
		let text = "";
		let displayColumn = 1;

		for (let index = 0; index < tabs.length; index += 1) {
			if (index > 0) {
				const tabSeparator = tabSeparators[index - 1] ?? TAB_SEPARATOR;
				const separatorVisible = tabSeparator === TAB_SEPARATOR;
				const separatorWidth = stringDisplayWidth(tabSeparator);
				const separatorOffset = text.length;
				if (separatorVisible) separatorColumns.push(displayColumn);
				text += tabSeparator;
				if (separatorVisible) {
					segments.push({
						start: separatorOffset,
						end: separatorOffset + tabSeparator.length,
						foreground: this.terminalBackgroundColor(),
					});
				} else {
					segments.push({
						start: separatorOffset,
						end: separatorOffset + tabSeparator.length,
						foreground: TAB_PANEL_BACKGROUND,
						background: this.terminalBackgroundColor(),
					});
				}
				displayColumn += separatorWidth;
			}

			const tab = tabs[index];
			const button = buttons[index];
			if (!tab || !button) continue;

			const textOffset = text.length;
			const buttonWidth = stringDisplayWidth(button.text);
			text += button.text;

			this.addButtonSegments(tab, button, textOffset, segments);

			const closeColumnOffset = stringDisplayWidth(button.text.slice(0, button.closeStart));
			// Keep the more specific close target before the tab target because the
			// tab target intentionally spans the whole button, including the close icon.
			targets.push({
				kind: "close",
				tabId: tab.id,
				startColumn: displayColumn + closeColumnOffset,
				endColumn: displayColumn + closeColumnOffset + stringDisplayWidth(button.text.slice(button.closeStart, button.closeEnd)),
			});
			targets.push({
				kind: "tab",
				tabId: tab.id,
				active: tab.status === "active",
				startColumn: displayColumn,
				endColumn: displayColumn + buttonWidth,
			});

			displayColumn += buttonWidth;
		}
		const tabsText = ellipsizeDisplay(text, tabsWidth);
		const renderedTabsWidth = stringDisplayWidth(tabsText);
		const showNewTabDivider = tabs.length > 0 && tabs.at(-1)?.status !== "active";
		const renderedNewTabPrefix = newTabPrefix;
		const lineText = `${tabsText}${renderedNewTabPrefix}${APP_ICONS.plus}`;
		const newTabDividerColumn = renderedTabsWidth + 1;
		const plusStartColumn = renderedTabsWidth + newTabPrefixWidth + 1;
		const newTabDividerOffset = tabsText.length;
		if (showNewTabDivider) {
			segments.push({
				start: newTabDividerOffset,
				end: newTabDividerOffset + 1,
				foreground: this.terminalBackgroundColor(),
			});
		} else if (tabs.length > 0) {
			segments.push({
				start: tabsText.length,
				end: tabsText.length + renderedNewTabPrefix.length,
				foreground: TAB_PANEL_BACKGROUND,
				background: this.terminalBackgroundColor(),
			});
		}
		segments.push({
			start: lineText.length - APP_ICONS.plus.length,
			end: lineText.length,
			foreground: this.host.theme.colors.info,
			bold: true,
		});
		targets.push({
			kind: "new-tab",
			startColumn: plusStartColumn,
			endColumn: plusStartColumn + newTabWidth,
		});

		return {
			text: ellipsizeDisplay(lineText, width),
			segments,
			targets: targets.filter((target) => target.startColumn <= width),
			separatorColumns: [
				...separatorColumns.filter((column) => column <= Math.min(width, renderedTabsWidth)),
				...(showNewTabDivider && newTabDividerColumn <= width ? [newTabDividerColumn] : []),
			],
		};
	}

	render(row: number, layout: TabLineLayout, width: number): string {
		return this.host.screenStyler.styleLineSegments(row, layout.text, width, {
			foreground: INACTIVE_TAB_FOREGROUND,
			background: TAB_PANEL_BACKGROUND,
		}, layout.segments);
	}

	renderBottom(row: number, layout: TabLineLayout, width: number): string {
		return this.host.screenStyler.styleLine(row, this.bottomText(layout, width), width, {
			foreground: this.host.theme.colors.inputBorder,
		});
	}

	bottomText(layout: TabLineLayout, width: number): string {
		const chars = Array.from({ length: Math.max(0, width) }, () => "─");
		const activeTabTarget = layout.targets.find((target) => target.kind === "tab" && target.active);
		if (activeTabTarget) {
			const leftSeparator = Math.max(0, ...layout.separatorColumns.filter((column) => column < activeTabTarget.startColumn));
			const rightSeparator = Math.min(width + 1, ...layout.separatorColumns.filter((column) => column >= activeTabTarget.endColumn));
			const clearStart = Math.max(1, leftSeparator + 1);
			const clearEnd = Math.min(width, rightSeparator - 1);
			for (let column = clearStart; column <= clearEnd; column += 1) {
				chars[column - 1] = " ";
			}
		}
		for (const column of layout.separatorColumns) {
			if (column < 1 || column > width) continue;
			const hasLeftLine = chars[column - 2] === "─";
			const hasRightLine = chars[column] === "─";
			chars[column - 1] = hasLeftLine && hasRightLine ? "┴" : hasLeftLine ? "┘" : hasRightLine ? "└" : "╵";
		}

		return chars.join("");
	}

	private buttonLayout(tab: SessionTab, maxWidth?: number): TabButtonLayout {
		const statusText = this.statusIndicatorIcon(tab);
		const prefix = `${statusText} `;
		const suffix = ` ${APP_ICONS.close}`;
		const title = this.displayTitle(tab);
		const naturalText = `${prefix}${title}${suffix}`;
		const naturalWidth = stringDisplayWidth(naturalText);
		if (maxWidth === undefined || naturalWidth <= maxWidth) return this.buttonLayoutFromText(naturalText, 0, statusText.length);

		const titleWidth = maxWidth - stringDisplayWidth(prefix) - stringDisplayWidth(suffix);
		if (titleWidth <= 0) return this.buttonLayoutFromText(ellipsizeDisplay(`${statusText}${APP_ICONS.close}`, maxWidth), 0, statusText.length);

		return this.buttonLayoutFromText(`${prefix}${ellipsizeDisplay(title, titleWidth)}${suffix}`, 0, statusText.length);
	}

	private displayTitle(tab: SessionTab): string {
		const title = tab.title.trim();
		if (!DEFAULT_SESSION_TITLE_PATTERN.test(title)) return tab.title;
		return tab.titlePlaceholder === "loading" ? "Loading…" : "New";
	}

	private buttonLayoutFromText(text: string, statusStart: number, statusLength: number): TabButtonLayout {
		const closeStart = Math.max(0, text.lastIndexOf(APP_ICONS.close));
		return {
			text,
			statusStart,
			statusEnd: Math.min(text.length, statusStart + statusLength),
			closeStart,
			closeEnd: closeStart + APP_ICONS.close.length,
		};
	}

	private addButtonSegments(tab: SessionTab, button: TabButtonLayout, textOffset: number, segments: StyledSegment[]): void {
		const statusStyle = this.statusIndicatorStyle(tab);
		const statusStart = textOffset + button.statusStart;
		const statusEnd = textOffset + button.statusEnd;
		const closeStart = textOffset + button.closeStart;
		const closeEnd = textOffset + button.closeEnd;
		const end = textOffset + button.text.length;
		if (tab.status !== "active") {
			this.pushSegment(segments, statusStart, statusEnd, {
				...statusStyle,
			});
			this.pushSegment(segments, statusEnd, closeStart, {
				foreground: INACTIVE_TAB_FOREGROUND,
			});
			this.pushSegment(segments, closeStart, closeEnd, {
				foreground: INACTIVE_TAB_FOREGROUND,
			});
			this.pushSegment(segments, closeEnd, end, {
				foreground: INACTIVE_TAB_FOREGROUND,
			});
			return;
		}

		this.pushSegment(segments, statusStart, statusEnd, {
			...statusStyle,
			background: this.host.theme.colors.background,
		});
		this.pushSegment(segments, statusEnd, closeStart, {
			foreground: this.host.theme.colors.selectionForeground,
			background: this.host.theme.colors.background,
		});
		this.pushSegment(segments, closeStart, closeEnd, {
			foreground: this.host.theme.colors.muted,
			background: this.host.theme.colors.background,
		});
		this.pushSegment(segments, closeEnd, end, {
			foreground: this.host.theme.colors.selectionForeground,
			background: this.host.theme.colors.background,
		});
	}

	private statusIndicatorStyle(tab: SessionTab): Omit<StyledSegment, "start" | "end"> {
		if (tab.status !== "active" && tab.attention === "terminal-bell" && tab.attentionVisible !== false) {
			return { foreground: this.host.theme.colors.error, bold: true };
		}

		if (tab.activity === "running" || tab.activity === "thinking") {
			return { foreground: this.host.theme.colors.success, bold: true };
		}

		return { foreground: this.host.theme.colors.statusDotBase };
	}

	private statusIndicatorIcon(tab: SessionTab): string {
		if (tab.status !== "active" && tab.attention === "terminal-bell" && tab.attentionVisible !== false) {
			return APP_ICONS.alert;
		}

		if (tab.activity === "running" || tab.activity === "thinking") {
			return APP_ICONS.timerSand;
		}

		return APP_ICONS.checkCircle;
	}

	private terminalBackgroundColor(): string {
		return this.host.theme.colors.background || "#000000";
	}

	private tabSeparatorText(previousTabActive: boolean, currentTabActive: boolean): string {
		if (currentTabActive) return ACTIVE_TAB_LEFT_EDGE;
		if (previousTabActive) return ACTIVE_TAB_RIGHT_EDGE;
		return TAB_SEPARATOR;
	}

	private newTabPrefixText(): string {
		if (this.host.tabs.length === 0) return EMPTY_NEW_TAB_PREFIX;
		return this.host.tabs.at(-1)?.status === "active" ? ACTIVE_TAB_RIGHT_EDGE : TAB_SEPARATOR;
	}

	private pushSegment(
		segments: StyledSegment[],
		start: number,
		end: number,
		style: Omit<StyledSegment, "start" | "end">,
	): void {
		if (end <= start) return;
		segments.push({ start, end, ...style });
	}
}
