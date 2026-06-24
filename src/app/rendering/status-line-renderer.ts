import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { compactProgressBarSegments, formatCompactProgressBar } from "../../context-progress-bar.js";
import type { Theme } from "../../theme.js";
import { ellipsizeDisplay, padOrTrimPlain } from "./render-text.js";
import type {
	SessionActivity,
	StatusCompactToolsTarget,
	StatusContextTarget,
	StatusDraftQueueTarget,
	StatusLineLayout,
	StatusModelTarget,
	StatusModelUsageTarget,
	StatusPromptEnhancerTarget,
	StatusQuickScrollTarget,
	StatusSessionTarget,
	StatusTerminalBellSoundTarget,
	StatusThinkingExpandTarget,
	StatusThinkingTarget,
	StatusUserJumpTarget,
	StatusVoiceLanguageTarget,
	StatusVoiceMicTarget,
	StyledSegment,
} from "../types.js";
import type { ScreenStyler } from "../screen/screen-styler.js";
import { displayIndexForColumn, stringDisplayWidth } from "../../terminal-width.js";
import { THINKING_LEVELS } from "../constants.js";
import { APP_ICONS } from "../icons.js";
import { resolveColor, resolveModelColor, type ModelColorsConfig } from "../../config.js";

const MODEL_USAGE_PROGRESS_BAR_WIDTH = stringDisplayWidth(formatCompactProgressBar(100));
const STATUS_WIDGET_GAP = " ";
const DEFAULT_THINKING_LEVEL_LABELS: readonly string[] = THINKING_LEVELS;

export type StatusLineRendererHost = {
	readonly theme: Theme;
	readonly screenStyler: ScreenStyler;
	readonly session: AgentSession | undefined;
	readonly modelColors?: ModelColorsConfig;
	readonly sessionActivity: SessionActivity;
	readonly statusDotBright: boolean;
	currentStatus(): string;
	statusWorkspaceLabel(): string;
	statusWorkspaceGitBranchLabel(): string | undefined;
	statusModelLabel(session: AgentSession): string;
	statusThinkingLabel(session: AgentSession): string;
	formatContextUsagePercent(session: AgentSession): string;
	roundedContextUsagePercent(session: AgentSession): number | undefined;
	contextUsagePercentColor(percent: number): string;
	modelUsageStatusLabel(): string;
	promptEnhancerStatusWidgetText(): string;
	promptEnhancerStatusWidgetActive(): boolean;
	promptEnhancerStatusWidgetEnabled(): boolean;
	terminalBellSoundStatusWidgetText(): string;
	terminalBellSoundStatusWidgetEnabled(): boolean;
	voiceStatusWidgetText(): string;
	voiceStatusWidgetActive(): boolean;
	conversationQuickScrollDirections?(): { up: boolean; down: boolean };
	queueableInputActive?(): boolean;
	userMessageJumpMenuActive?(): boolean;
	allThinkingExpandedActive?(): boolean;
	superCompactToolsActive?(): boolean;
};

export class StatusLineRenderer {
	constructor(private readonly host: StatusLineRendererHost) {}

	layout(width: number): StatusLineLayout {
		const contentWidth = Math.max(1, width);
		const statusDot = APP_ICONS.record;
		const baseStatus = this.host.currentStatus();
		const workspaceLabel = this.host.statusWorkspaceLabel();
		const modelUsageLabel = this.host.modelUsageStatusLabel();
		const widgetsLayout = this.inputBorderWidgetsLayout(contentWidth);
		const leftWidth = widgetsLayout?.inputBorderWidgetStartColumn
			? Math.max(0, widgetsLayout.inputBorderWidgetStartColumn - 2)
			: contentWidth;
		const fullWorkspaceDetailsLabel = modelUsageLabel ? `${workspaceLabel} ${modelUsageLabel}` : workspaceLabel;
		const contextBarLabel = this.contextBarLabel(baseStatus, leftWidth, fullWorkspaceDetailsLabel);
		const status = contextBarLabel ? `${baseStatus} ${contextBarLabel}` : baseStatus;
		const sessionLabel = "";
		const fittedWorkspaceLabel = this.fitWorkspaceLabel(statusDot, status, workspaceLabel, modelUsageLabel, leftWidth);
		const workspaceDetailsLabel = modelUsageLabel
			? `${fittedWorkspaceLabel ? `${fittedWorkspaceLabel} ` : ""}${modelUsageLabel}`
			: fittedWorkspaceLabel;
		const details = workspaceDetailsLabel ? `${status} ${workspaceDetailsLabel}` : status;
		const leftText = padOrTrimPlain(`${statusDot} ${details}`, leftWidth);
		const text = widgetsLayout?.inputBorderWidgetStartColumn
			? overlayText(padOrTrimPlain(leftText, contentWidth), widgetsLayout.inputBorderWidgetStartColumn, widgetsLayout.text)
			: padOrTrimPlain(leftText, contentWidth);

		return {
			...widgetsLayout,
			details,
			text,
			sessionLabel,
			workspaceLabel: fittedWorkspaceLabel,
			...(modelUsageLabel ? { modelUsageLabel } : {}),
			...(contextBarLabel ? { contextBarLabel } : {}),
		};
	}

	inputBorderWidgetsLayout(width: number): StatusLineLayout | undefined {
		const layout: StatusLineLayout = {
			details: "",
			text: "",
			sessionLabel: "",
			workspaceLabel: "",
		};
		const widgets: { text: string; assign: (startColumn: number, text: string) => void }[] = [];
		let hasParts = false;

		const appendWidget = (text: string, assign: (startColumn: number, text: string) => void): void => {
			if (text.length <= 0) return;
			widgets.push({ text, assign });
			hasParts = true;
		};

		const quickScrollDirections = this.host.conversationQuickScrollDirections?.() ?? { up: false, down: false };

		const draftQueueButton = this.draftQueueWidgetText();
		appendWidget(draftQueueButton ? this.iconButtonText(draftQueueButton) : "", (column, text) => {
			layout.draftQueueWidget = this.widgetLayout(column, text);
		});
		const promptEnhancerWidgetText = this.host.promptEnhancerStatusWidgetText();
		appendWidget(promptEnhancerWidgetText ? this.iconButtonText(promptEnhancerWidgetText) : "", (column, text) => {
			layout.promptEnhancerWidget = this.widgetLayout(column, text);
		});
		appendWidget(this.iconButtonText(APP_ICONS.user), (column, text) => {
			layout.userJumpWidget = this.widgetLayout(column, text);
		});
		const terminalBellSoundWidgetText = this.host.terminalBellSoundStatusWidgetText();
		appendWidget(terminalBellSoundWidgetText ? this.iconButtonText(terminalBellSoundWidgetText) : "", (column, text) => {
			layout.terminalBellSoundWidget = this.widgetLayout(column, text);
		});
		appendWidget(this.iconButtonText(APP_ICONS.thinkingExpanded), (column, text) => {
			layout.thinkingExpandWidget = this.widgetLayout(column, text);
		});
		appendWidget(this.iconButtonText(APP_ICONS.compactTools), (column, text) => {
			layout.compactToolsWidget = this.widgetLayout(column, text);
		});
		appendWidget(quickScrollDirections.up ? this.iconButtonText(APP_ICONS.up) : "", (column, text) => {
			layout.quickScrollUpWidget = this.widgetLayout(column, text);
		});
		appendWidget(quickScrollDirections.down ? this.iconButtonText(APP_ICONS.down) : "", (column, text) => {
			layout.quickScrollDownWidget = this.widgetLayout(column, text);
		});
		const voiceWidgetText = this.host.voiceStatusWidgetText();
		appendWidget(this.voiceBorderWidgetText(voiceWidgetText), (column, text) => {
			layout.voiceWidget = this.voiceWidgetLayout(column, voiceWidgetText, text);
		});

		if (!hasParts) return undefined;

		const parts: string[] = [];
		const gapWidth = stringDisplayWidth(STATUS_WIDGET_GAP);
		const totalWidth = widgets.reduce((total, widget, index) => total + stringDisplayWidth(widget.text) + (index > 0 ? gapWidth : 0), 0);
		const endColumn = Math.max(1, width + 1);
		const startColumn = endColumn - totalWidth;
		if (startColumn < 1) return undefined;

		layout.inputBorderWidgetStartColumn = startColumn;
		let nextColumn = startColumn;
		for (const [index, widget] of widgets.entries()) {
			if (index > 0) {
				parts.push(STATUS_WIDGET_GAP);
				nextColumn += gapWidth;
			}
			parts.push(widget.text);
			widget.assign(nextColumn, widget.text);
			nextColumn += stringDisplayWidth(widget.text);
		}

		layout.text = parts.join("");
		return layout;
	}

	render(row: number, layout: StatusLineLayout, width: number): string {
		const colors = this.host.theme.colors;
		return this.host.screenStyler.styleLineSegments(row, layout.text, width, {
			foreground: colors.statusForeground,
		}, this.segments(layout.text, layout));
	}

	renderInputBorderWidgets(row: number, layout: StatusLineLayout, borderText: string, width: number): string {
		const startColumn = layout.inputBorderWidgetStartColumn ?? 1;
		const text = overlayText(borderText, startColumn, layout.text);
		return this.host.screenStyler.styleLineSegments(row, text, width, {
			foreground: this.host.theme.colors.inputBorder,
		}, this.inputBorderWidgetSegments(layout, text));
	}

	private inputBorderWidgetSegments(layout: StatusLineLayout, text: string): StyledSegment[] {
		const colors = this.host.theme.colors;
		const segments: StyledSegment[] = [];
		const pushWidgetSegment = (widget: { startColumn: number; endColumn: number } | undefined, foreground: string): void => {
			if (!widget) return;
			segments.push({
				start: displayIndexForColumn(text, widget.startColumn),
				end: displayIndexForColumn(text, widget.endColumn),
				foreground,
			});
		};

		pushWidgetSegment(layout.draftQueueWidget, colors.info);
		pushWidgetSegment(layout.promptEnhancerWidget, this.host.promptEnhancerStatusWidgetActive()
			? colors.warning
			: this.host.promptEnhancerStatusWidgetEnabled()
				? colors.info
				: colors.muted);
		pushWidgetSegment(layout.quickScrollUpWidget, colors.info);
		pushWidgetSegment(layout.quickScrollDownWidget, colors.info);
		pushWidgetSegment(layout.userJumpWidget, this.host.userMessageJumpMenuActive?.() ? colors.info : colors.muted);
		pushWidgetSegment(layout.terminalBellSoundWidget, this.host.terminalBellSoundStatusWidgetEnabled() ? colors.info : colors.muted);
		pushWidgetSegment(layout.thinkingExpandWidget, this.host.allThinkingExpandedActive?.() ? colors.info : colors.muted);
		pushWidgetSegment(layout.compactToolsWidget, this.host.superCompactToolsActive?.() ? colors.info : colors.muted);

		const voiceWidget = layout.voiceWidget;
		if (voiceWidget) {
			segments.push({
				start: displayIndexForColumn(text, voiceWidget.startColumn),
				end: displayIndexForColumn(text, voiceWidget.micEndColumn),
				foreground: this.host.voiceStatusWidgetActive() ? colors.error : colors.muted,
			});
			if (voiceWidget.languageEndColumn > voiceWidget.languageStartColumn) {
				segments.push({
					start: displayIndexForColumn(text, voiceWidget.languageStartColumn),
					end: displayIndexForColumn(text, voiceWidget.languageEndColumn),
					foreground: colors.statusForeground,
				});
			}
		}

		return segments;
	}

	modelTarget(statusText: string, row: number): StatusModelTarget | undefined {
		const session = this.host.session;
		if (!session) return undefined;

		const label = this.host.statusModelLabel(session);
		const marker = `${label} ${this.statusThinkingDisplayLabel(session)} `;
		const startIndex = statusText.indexOf(marker);
		if (startIndex < 0) return undefined;

		return { row, startColumn: startIndex + 1, endColumn: startIndex + label.length + 1 };
	}

	thinkingTarget(statusText: string, row: number): StatusThinkingTarget | undefined {
		const session = this.host.session;
		if (!session) return undefined;

		const label = this.statusThinkingDisplayLabel(session);
		const marker = ` ${label} ${this.host.formatContextUsagePercent(session)}`;
		const markerIndex = statusText.indexOf(marker);
		const startIndex = markerIndex >= 0 ? markerIndex + 1 : statusText.indexOf(label);
		if (startIndex < 0) return undefined;

		return { row, startColumn: startIndex + 1, endColumn: startIndex + label.length + 1 };
	}

	contextTarget(statusText: string, row: number, layout: StatusLineLayout): StatusContextTarget | undefined {
		const session = this.host.session;
		if (!session) return undefined;

		const thinkingLabel = this.statusThinkingDisplayLabel(session);
		const contextLabel = this.host.formatContextUsagePercent(session);
		const marker = ` ${thinkingLabel} ${contextLabel}`;
		const markerIndex = statusText.indexOf(marker);
		if (markerIndex < 0) return undefined;

		const startIndex = markerIndex + thinkingLabel.length + 2;
		let endIndex = startIndex + contextLabel.length;
		if (layout.contextBarLabel) endIndex += 1 + layout.contextBarLabel.length;
		return { row, startColumn: startIndex + 1, endColumn: endIndex + 1 };
	}

	modelUsageTarget(statusText: string, row: number, layout: StatusLineLayout): StatusModelUsageTarget | undefined {
		const label = layout.modelUsageLabel;
		if (!label) return undefined;

		const startIndex = statusText.lastIndexOf(label);
		if (startIndex < 0) return undefined;

		return { row, startColumn: startIndex + 1, endColumn: startIndex + label.length + 1 };
	}

	promptEnhancerTarget(layout: StatusLineLayout, row: number): StatusPromptEnhancerTarget | undefined {
		if (!this.host.promptEnhancerStatusWidgetEnabled()) return undefined;
		const widget = layout.promptEnhancerWidget;
		if (!widget) return undefined;
		return { row, startColumn: widget.startColumn, endColumn: widget.endColumn };
	}

	voiceMicTarget(layout: StatusLineLayout, row: number): StatusVoiceMicTarget | undefined {
		const voiceWidget = layout.voiceWidget;
		if (!voiceWidget) return undefined;
		return { row, startColumn: voiceWidget.startColumn, endColumn: voiceWidget.micEndColumn };
	}

	voiceLanguageTarget(layout: StatusLineLayout, row: number): StatusVoiceLanguageTarget | undefined {
		const voiceWidget = layout.voiceWidget;
		if (!voiceWidget) return undefined;
		if (voiceWidget.languageStartColumn >= voiceWidget.languageEndColumn) return undefined;
		return { row, startColumn: voiceWidget.languageStartColumn, endColumn: voiceWidget.languageEndColumn };
	}

	userJumpTarget(layout: StatusLineLayout, row: number): StatusUserJumpTarget | undefined {
		const widget = layout.userJumpWidget;
		if (!widget) return undefined;
		return { row, startColumn: widget.startColumn, endColumn: widget.endColumn };
	}

	draftQueueTarget(layout: StatusLineLayout, row: number): StatusDraftQueueTarget | undefined {
		const widget = layout.draftQueueWidget;
		if (!widget) return undefined;
		return { row, startColumn: widget.startColumn, endColumn: widget.endColumn };
	}

	thinkingExpandTarget(layout: StatusLineLayout, row: number): StatusThinkingExpandTarget | undefined {
		const widget = layout.thinkingExpandWidget;
		if (!widget) return undefined;
		return { row, startColumn: widget.startColumn, endColumn: widget.endColumn };
	}

	compactToolsTarget(layout: StatusLineLayout, row: number): StatusCompactToolsTarget | undefined {
		const widget = layout.compactToolsWidget;
		if (!widget) return undefined;
		return { row, startColumn: widget.startColumn, endColumn: widget.endColumn };
	}

	quickScrollUpTarget(layout: StatusLineLayout, row: number): StatusQuickScrollTarget | undefined {
		const widget = layout.quickScrollUpWidget;
		if (!widget) return undefined;
		return { row, startColumn: widget.startColumn, endColumn: widget.endColumn, direction: "up" };
	}

	quickScrollDownTarget(layout: StatusLineLayout, row: number): StatusQuickScrollTarget | undefined {
		const widget = layout.quickScrollDownWidget;
		if (!widget) return undefined;
		return { row, startColumn: widget.startColumn, endColumn: widget.endColumn, direction: "down" };
	}

	terminalBellSoundTarget(layout: StatusLineLayout, row: number): StatusTerminalBellSoundTarget | undefined {
		const widget = layout.terminalBellSoundWidget;
		if (!widget) return undefined;
		return { row, startColumn: widget.startColumn, endColumn: widget.endColumn };
	}

	sessionTarget(statusText: string, row: number, label: string, workspaceLabel: string): StatusSessionTarget | undefined {
		if (!this.host.session || !label) return undefined;

		const marker = ` ${label} ${workspaceLabel}`;
		const markerIndex = statusText.lastIndexOf(marker);
		const startIndex = markerIndex >= 0 ? markerIndex + 1 : statusText.lastIndexOf(label);
		if (startIndex < 0) return undefined;

		const endIndex = Math.min(statusText.length, startIndex + label.length);
		if (endIndex <= startIndex) return undefined;

		return { row, startColumn: startIndex + 1, endColumn: endIndex + 1 };
	}

	private segments(statusText: string, layout: StatusLineLayout): StyledSegment[] {
		const statusDotStart = statusText.indexOf(APP_ICONS.record);
		const segments: StyledSegment[] = statusDotStart >= 0 ? [{
			start: statusDotStart,
			end: statusDotStart + APP_ICONS.record.length,
			foreground: this.statusDotColor(),
		}] : [];
		this.pushStatusWidgetSegments(segments, statusText, layout);
		this.pushWorkspaceSegments(segments, statusText, layout.workspaceLabel);
		if (layout.modelUsageLabel) this.pushModelUsageSegments(segments, statusText, layout.modelUsageLabel);

		const session = this.host.session;
		if (!session) return segments;

		const modelLabel = this.host.statusModelLabel(session);
		const thinkingLabel = this.host.statusThinkingLabel(session);
		const thinkingDisplayLabel = this.statusThinkingDisplayLabel(session);
		const contextLabel = this.host.formatContextUsagePercent(session);
		this.pushSegment(segments, statusText.indexOf(`${modelLabel} ${thinkingDisplayLabel} `), modelLabel.length, this.modelProviderColor(session));

		const thinkingMarkerStart = statusText.indexOf(` ${thinkingDisplayLabel} ${contextLabel}`);
		const thinkingStart = thinkingMarkerStart >= 0 ? thinkingMarkerStart + 1 : -1;
		this.pushSegment(segments, thinkingStart, thinkingDisplayLabel.length, this.thinkingLevelColor(thinkingLabel));

		const contextPercent = this.host.roundedContextUsagePercent(session);
		if (contextPercent !== undefined && thinkingStart >= 0) {
			const contextStart = thinkingStart + thinkingDisplayLabel.length + 1;
			this.pushSegment(segments, contextStart, contextLabel.length, this.host.contextUsagePercentColor(contextPercent));

			if (layout.contextBarLabel) {
				const barStart = contextStart + contextLabel.length + 1;
				this.pushContextBarSegments(segments, barStart, contextPercent);
			}
		}

		this.pushSegment(segments, statusText.lastIndexOf(layout.sessionLabel), layout.sessionLabel.length, this.host.theme.colors.selectionForeground);
		return segments;
	}

	private fitWorkspaceLabel(statusDot: string, status: string, workspaceLabel: string, modelUsageLabel: string, width: number): string {
		const modelUsageSuffix = modelUsageLabel ? ` ${modelUsageLabel}` : "";
		const available = width - stringDisplayWidth(`${statusDot} ${status} `) - stringDisplayWidth(modelUsageSuffix);
		if (available <= 0) return "";
		return ellipsizeDisplay(workspaceLabel, available);
	}

	private pushStatusWidgetSegments(segments: StyledSegment[], statusText: string, layout: StatusLineLayout): void {
		const colors = this.host.theme.colors;
		const widgets = [
			{ widget: layout.draftQueueWidget, foreground: colors.info },
			{ widget: layout.promptEnhancerWidget, foreground: this.host.promptEnhancerStatusWidgetActive()
				? colors.warning
				: this.host.promptEnhancerStatusWidgetEnabled()
					? colors.info
					: colors.muted },
			{ widget: layout.userJumpWidget, foreground: this.host.userMessageJumpMenuActive?.() ? colors.info : colors.muted },
			{ widget: layout.terminalBellSoundWidget, foreground: this.host.terminalBellSoundStatusWidgetEnabled() ? colors.info : colors.muted },
			{ widget: layout.thinkingExpandWidget, foreground: this.host.allThinkingExpandedActive?.() ? colors.info : colors.muted },
			{ widget: layout.compactToolsWidget, foreground: this.host.superCompactToolsActive?.() ? colors.info : colors.muted },
		].filter((entry): entry is { widget: { startColumn: number; endColumn: number }; foreground: string } => Boolean(entry.widget));

		for (const { widget, foreground } of widgets) {
			segments.push({
				start: displayIndexForColumn(statusText, widget.startColumn),
				end: displayIndexForColumn(statusText, widget.endColumn),
				foreground,
			});
		}

		const voiceWidget = layout.voiceWidget;
		if (voiceWidget) {
			segments.push({
				start: displayIndexForColumn(statusText, voiceWidget.startColumn),
				end: displayIndexForColumn(statusText, voiceWidget.micEndColumn),
				foreground: this.host.voiceStatusWidgetActive() ? colors.error : colors.muted,
			});
			if (voiceWidget.languageEndColumn > voiceWidget.languageStartColumn) {
				segments.push({
					start: displayIndexForColumn(statusText, voiceWidget.languageStartColumn),
					end: displayIndexForColumn(statusText, voiceWidget.languageEndColumn),
					foreground: colors.statusForeground,
				});
			}
		}
	}

	private draftQueueWidgetText(): string {
		return this.host.queueableInputActive?.() ? APP_ICONS.timerSand : "";
	}

	private pushWorkspaceSegments(segments: StyledSegment[], statusText: string, workspaceLabel: string): void {
		const start = statusText.lastIndexOf(workspaceLabel);
		if (start < 0 || workspaceLabel.length <= 0) return;

		const branchLabel = this.host.statusWorkspaceGitBranchLabel();
		if (!branchLabel) {
			this.pushSegment(segments, start, workspaceLabel.length, this.host.theme.colors.selectionForeground);
			return;
		}

		const branchStart = workspaceLabel.lastIndexOf(branchLabel);
		const branchEndsWorkspace = branchStart >= 0 && branchStart + branchLabel.length === workspaceLabel.length;
		if (!branchEndsWorkspace) {
			this.pushSegment(segments, start, workspaceLabel.length, this.host.theme.colors.selectionForeground);
			return;
		}

		this.pushSegment(segments, start, branchStart, this.host.theme.colors.selectionForeground);
		this.pushSegment(segments, start + branchStart, branchLabel.length, this.host.theme.colors.muted);
	}

	private pushModelUsageSegments(segments: StyledSegment[], statusText: string, modelUsageLabel: string): void {
		const labelStart = statusText.lastIndexOf(modelUsageLabel);
		if (labelStart < 0) return;

		const usageMatches = modelUsageLabel.matchAll(/(\d{1,3})% /gu);
		let prefixColored = false;
		for (const match of usageMatches) {
			const localStart = match.index;
			const percentToken = `${match[1]}%`;
			const percentText = match[1];
			if (localStart === undefined || !percentText) continue;

			const percent = Number.parseInt(percentText, 10);
			if (!Number.isFinite(percent)) continue;

			const start = labelStart + localStart;
			const color = this.modelUsageProgressColor(percent);
			if (!prefixColored) {
				prefixColored = true;
				const prefixLength = modelUsageLabel.slice(0, localStart).trimEnd().length;
				this.pushSegment(segments, labelStart, prefixLength, color);
			}

			this.pushSegment(segments, start, percentToken.length, color);

			const barStart = start + percentToken.length + 1;
			segments.push(...compactProgressBarSegments(barStart, percent, {
				fill: color,
				track: this.host.theme.colors.statusDotBase,
			}, MODEL_USAGE_PROGRESS_BAR_WIDTH));

			const defaultResetStart = barStart + MODEL_USAGE_PROGRESS_BAR_WIDTH + 1;
			const warningStart = this.modelUsageHasWarning(modelUsageLabel, defaultResetStart - labelStart)
				? defaultResetStart
				: undefined;
			const resetStart = warningStart === undefined
				? defaultResetStart
				: warningStart + APP_ICONS.alert.length + 1;
			if (warningStart !== undefined) {
				this.pushSegment(segments, warningStart, APP_ICONS.alert.length, this.host.theme.colors.warning);
			}
			const localResetStart = resetStart - labelStart;
			const resetLength = this.modelUsageResetLength(modelUsageLabel, localResetStart);
			const resetText = modelUsageLabel.slice(localResetStart, localResetStart + resetLength);
			this.pushResetDurationSegments(segments, resetStart, resetText);
		}
	}

	private pushResetDurationSegments(segments: StyledSegment[], resetStart: number, resetText: string): void {
		const colors = this.host.theme.colors;
		const muted = colors.muted;
		const bright = colors.statusForeground;
		for (const match of resetText.matchAll(/\d+|\D+/gu)) {
			const text = match[0];
			const localStart = match.index ?? 0;
			this.pushSegment(segments, resetStart + localStart, text.length, /\d/.test(text) ? bright : muted);
		}
	}

	private modelUsageHasWarning(modelUsageLabel: string, localStart: number): boolean {
		if (localStart < 0 || localStart >= modelUsageLabel.length) return false;
		return modelUsageLabel.startsWith(APP_ICONS.alert, localStart);
	}

	private modelUsageResetLength(modelUsageLabel: string, localStart: number): number {
		if (localStart < 0 || localStart >= modelUsageLabel.length) return 0;

		const nextSeparator = modelUsageLabel.indexOf(" • ", localStart);
		return (nextSeparator >= 0 ? nextSeparator : modelUsageLabel.length) - localStart;
	}

	private pushSegment(segments: StyledSegment[], start: number, length: number, foreground: string): void {
		if (start < 0 || length <= 0) return;
		segments.push({ start, end: start + length, foreground });
	}

	private pushContextBarSegments(segments: StyledSegment[], start: number, percent: number): void {
		segments.push(...compactProgressBarSegments(start, percent, {
			fill: this.host.contextUsagePercentColor(percent),
			track: this.host.theme.colors.statusDotBase,
		}));
	}

	private modelUsageProgressColor(percent: number): string {
		if (percent < 20) return this.host.theme.colors.error;
		if (percent < 50) return this.host.theme.colors.warning;
		return this.host.theme.colors.success;
	}

	private modelProviderColor(session: AgentSession): string {
		const provider = session.model?.provider;
		if (!provider) return this.host.theme.colors.selectionForeground;

		const modelId = session.model?.id;
		const configuredColor = modelId && this.host.modelColors
			? resolveModelColor(`${provider}/${modelId}`, this.host.modelColors)
			: undefined;
		return configuredColor
			? resolveColor(configuredColor, this.host.theme.colors)
			: modelProviderThemeColor(provider, this.host.theme.colors);
	}

	private thinkingLevelColor(label: string): string {
		return thinkingLevelThemeColor(label, this.host.theme.colors, this.availableThinkingLevels());
	}

	private statusThinkingDisplayLabel(session: AgentSession): string {
		return `${APP_ICONS.lightbulb} ${this.host.statusThinkingLabel(session)}`;
	}

	private availableThinkingLevels(): string[] {
		const levels = this.host.session?.getAvailableThinkingLevels();
		return Array.isArray(levels) && levels.length > 0 ? levels.map(String) : [...DEFAULT_THINKING_LEVEL_LABELS];
	}

	private contextBarLabel(status: string, width: number, workspaceLabel: string): string | undefined {
		const session = this.host.session;
		if (!session) return undefined;

		const contextPercent = this.host.roundedContextUsagePercent(session);
		if (contextPercent === undefined) return undefined;

		const contextLabel = this.host.formatContextUsagePercent(session);
		if (!status.endsWith(contextLabel)) return undefined;

		const label = formatCompactProgressBar(contextPercent);
		const details = `${status} ${label} ${workspaceLabel}`;
		return stringDisplayWidth(`${APP_ICONS.record} ${details}`) <= width ? label : undefined;
	}

	private widgetLayout(startColumn: number, widgetText: string): NonNullable<StatusLineLayout["promptEnhancerWidget"]> {
		return {
			startColumn,
			endColumn: startColumn + stringDisplayWidth(widgetText),
		};
	}

	private iconButtonText(icon: string): string {
		return icon;
	}

	private voiceBorderWidgetText(widgetText: string): string {
		const parts = this.voiceBorderWidgetParts(widgetText);
		if (!parts) return "";

		const micButton = this.iconButtonText(parts.buttonIconText);
		if (parts.languageText) {
			return `${micButton}${STATUS_WIDGET_GAP}${parts.languageText}`;
		}
		return micButton;
	}

	private voiceWidgetLayout(startColumn: number, sourceText: string, widgetText: string): NonNullable<StatusLineLayout["voiceWidget"]> {
		const parts = this.voiceBorderWidgetParts(sourceText);
		const micWidth = parts?.buttonIconText ? stringDisplayWidth(parts.buttonIconText) : stringDisplayWidth(widgetText);
		const languageStartOffset = parts?.languageText
			? micWidth + stringDisplayWidth(STATUS_WIDGET_GAP)
			: stringDisplayWidth(widgetText);
		const languageEndOffset = parts?.languageText
			? languageStartOffset + stringDisplayWidth(parts.languageText)
			: languageStartOffset;
		return {
			startColumn,
			micEndColumn: startColumn + micWidth,
			languageStartColumn: startColumn + languageStartOffset,
			languageEndColumn: startColumn + languageEndOffset,
			endColumn: startColumn + stringDisplayWidth(widgetText),
		};
	}

	private voiceBorderWidgetParts(widgetText: string): { buttonIconText: string; languageText: string } | undefined {
		const tokens = widgetText.trim().split(/\s+/u).filter((token) => token.length > 0);
		const iconText = tokens[0];
		if (!iconText) return undefined;

		const maybeLanguage = tokens[1] ?? "";
		const hasLanguage = /^[A-Z][A-Z0-9_-]*$/u.test(maybeLanguage);
		const suffixText = tokens.slice(hasLanguage ? 2 : 1).join(" ");
		return {
			buttonIconText: suffixText || iconText,
			languageText: hasLanguage ? maybeLanguage : "",
		};
	}

	private statusDotColor(): string {
		switch (this.host.sessionActivity) {
			case "thinking":
				return this.host.statusDotBright ? this.host.theme.colors.info : this.host.theme.colors.statusDotBase;
			case "running":
				return this.host.statusDotBright ? this.host.theme.colors.warning : this.host.theme.colors.statusDotBase;
			case "idle":
				return this.host.theme.colors.statusDotBase;
		}
	}
}

function overlayText(text: string, startColumn: number, overlay: string): string {
	const start = Math.max(0, startColumn - 1);
	const overlayWidth = stringDisplayWidth(overlay);
	const startIndex = displayIndexForColumn(text, start + 1);
	const endIndex = displayIndexForColumn(text, start + overlayWidth + 1);
	const padded = text.padEnd(startIndex, " ");
	return `${padded.slice(0, startIndex)}${overlay}${padded.slice(endIndex)}`;
}

export function thinkingLevelThemeColor(label: string, colors: Theme["colors"], availableLevels?: readonly string[]): string {
	const levels = availableLevels && availableLevels.length > 0 ? availableLevels.map(String) : DEFAULT_THINKING_LEVEL_LABELS;
	const rank = levels.indexOf(label);
	if (rank >= 0) return thinkingRankThemeColor(label, rank, levels.length, colors);

	const fallbackRank = DEFAULT_THINKING_LEVEL_LABELS.indexOf(label);
	return fallbackRank >= 0
		? thinkingRankThemeColor(label, fallbackRank, DEFAULT_THINKING_LEVEL_LABELS.length, colors)
		: colors.info;
}

function thinkingRankThemeColor(label: string, rank: number, count: number, colors: Theme["colors"]): string {
	const baseColors = [
		colors.muted,
		colors.success,
		colors.modelOpenAI,
		colors.warning,
		colors.error,
		colors.thinkingXHigh,
	];
	const palette = count > baseColors.length ? [colors.statusForeground, ...baseColors] : baseColors;
	const fallbackRank = DEFAULT_THINKING_LEVEL_LABELS.indexOf(label);
	const colorIndex = count <= baseColors.length && fallbackRank >= 0 ? fallbackRank : rank;
	return palette[Math.max(0, Math.min(palette.length - 1, colorIndex))] ?? colors.info;
}

export function modelProviderThemeColor(provider: string, colors: Theme["colors"]): string {
	const palette = modelProviderThemePalette(colors);
	const hash = hashString(provider.trim().toLowerCase());
	return palette[hash % palette.length] ?? colors.info;
}

function modelProviderThemePalette(colors: Theme["colors"]): string[] {
	return [
		colors.accent,
		colors.info,
		colors.toolSearch,
		colors.toolMutation,
		colors.success,
		colors.warning,
	];
}

function hashString(value: string): number {
	let hash = 1779033703 ^ value.length;
	for (let index = 0; index < value.length; index += 1) {
		hash = Math.imul(hash ^ value.charCodeAt(index), 3432918353);
		hash = (hash << 13) | (hash >>> 19);
	}
	hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
	hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
	return (hash ^ (hash >>> 16)) >>> 0;
}
