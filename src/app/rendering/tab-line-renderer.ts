import { stringDisplayWidth } from "../../terminal-width.js";
import type { Theme } from "../../theme.js";
import { APP_ICONS } from "../icons.js";
import { ellipsizeDisplay } from "./render-text.js";
import type { ScreenStyler } from "../screen/screen-styler.js";
import type { SessionTab, StyledSegment, TabLineLayout, TabLineTarget } from "../types.js";

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

const TAB_SEPARATOR = " │ ";
const EMPTY_NEW_TAB_PREFIX = "│ ";
const DEFAULT_SESSION_TITLE_PATTERN = /^session [0-9a-f]{8}$/iu;
export const TAB_PANEL_ROWS = 2;

export function tabPanelRows(tabLineVisible: boolean, terminalRows: number, tabCount = TAB_PANEL_ROWS): number {
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
		const separator = TAB_SEPARATOR;
		const separatorWidth = stringDisplayWidth(separator);
		const separatorCount = Math.max(0, tabs.length - 1);
		const newTabWidth = stringDisplayWidth(APP_ICONS.plus);
		const newTabPrefix = tabs.length > 0 ? separator : EMPTY_NEW_TAB_PREFIX;
		const newTabPrefixWidth = stringDisplayWidth(newTabPrefix);
		const tabsWidth = Math.max(0, width - newTabWidth - newTabPrefixWidth);
		const naturalButtons = tabs.map((tab) => this.buttonLayout(tab));
		const naturalWidth = naturalButtons.reduce((sum, button) => sum + stringDisplayWidth(button.text), 0)
			+ separatorCount * separatorWidth;
		const buttonMaxWidth = naturalWidth <= tabsWidth
			? undefined
			: Math.max(7, Math.floor(Math.max(1, tabsWidth - separatorCount * separatorWidth) / tabs.length));
		const buttons = buttonMaxWidth === undefined ? naturalButtons : tabs.map((tab) => this.buttonLayout(tab, buttonMaxWidth));
		const segments: StyledSegment[] = [];
		const targets: TabLineTarget[] = [];
		const separatorColumns: number[] = [];
		let text = "";
		let displayColumn = 1;

		for (let index = 0; index < tabs.length; index += 1) {
			if (index > 0) {
				const separatorOffset = text.length;
				separatorColumns.push(displayColumn + 1);
				text += separator;
				segments.push({
					start: separatorOffset + 1,
					end: separatorOffset + 2,
					foreground: this.host.theme.colors.tabBorder,
				});
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
		const lineText = `${tabsText}${newTabPrefix}${APP_ICONS.plus}`;
		const newTabDividerColumn = renderedTabsWidth + (tabs.length > 0 ? 2 : 1);
		const plusStartColumn = renderedTabsWidth + newTabPrefixWidth + 1;
		const newTabDividerOffset = tabsText.length + (tabs.length > 0 ? 1 : 0);
		segments.push({
			start: newTabDividerOffset,
			end: newTabDividerOffset + 1,
			foreground: this.host.theme.colors.tabBorder,
		});
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
				...(newTabDividerColumn <= width ? [newTabDividerColumn] : []),
			],
		};
	}

	render(row: number, layout: TabLineLayout, width: number): string {
		return this.host.screenStyler.styleLineSegments(row, layout.text, width, {
			foreground: this.host.theme.colors.statusForeground,
		}, layout.segments);
	}

	renderBottom(row: number, layout: TabLineLayout, width: number): string {
		return this.host.screenStyler.styleLine(row, this.bottomText(layout, width), width, {
			foreground: this.host.theme.colors.tabBorder,
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
		if (tab.status !== "active") {
			this.pushSegment(segments, textOffset + button.statusStart, textOffset + button.statusEnd, {
				...statusStyle,
			});
			this.pushSegment(segments, textOffset + button.closeStart, textOffset + button.closeEnd, {
				foreground: this.host.theme.colors.muted,
			});
			return;
		}

		const statusStart = textOffset + button.statusStart;
		const statusEnd = textOffset + button.statusEnd;
		const closeStart = textOffset + button.closeStart;
		const closeEnd = textOffset + button.closeEnd;
		const end = textOffset + button.text.length;

		this.pushSegment(segments, statusStart, statusEnd, {
			...statusStyle,
		});
		this.pushSegment(segments, statusEnd, closeStart, { foreground: this.host.theme.colors.selectionForeground });
		this.pushSegment(segments, closeStart, closeEnd, { foreground: this.host.theme.colors.muted });
		this.pushSegment(segments, closeEnd, end, { foreground: this.host.theme.colors.selectionForeground });
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
