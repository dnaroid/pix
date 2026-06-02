import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { compactProgressBarSegments, formatCompactProgressBar } from "../context-progress-bar.js";
import type { Theme } from "../theme.js";
import { padOrTrimPlain } from "./render-text.js";
import type {
	SessionActivity,
	StatusCompactToolsTarget,
	StatusContextTarget,
	StatusLineLayout,
	StatusModelTarget,
	StatusModelUsageTarget,
	StatusPromptEnhancerTarget,
	StatusSessionTarget,
	StatusTerminalBellSoundTarget,
	StatusThinkingExpandTarget,
	StatusThinkingTarget,
	StatusUserJumpTarget,
	StatusVoiceLanguageTarget,
	StatusVoiceMicTarget,
	StyledSegment,
} from "./types.js";
import type { ScreenStyler } from "./screen-styler.js";
import { stringDisplayWidth } from "../terminal-width.js";
import { APP_ICONS } from "./icons.js";
import { resolveColor, resolveModelColor, type ModelColorsConfig } from "../config.js";

const MODEL_USAGE_PROGRESS_BAR_WIDTH = stringDisplayWidth(formatCompactProgressBar(100));

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
	userMessageJumpMenuActive?(): boolean;
	allThinkingExpandedActive?(): boolean;
	superCompactToolsActive?(): boolean;
};

export class StatusLineRenderer {
	constructor(private readonly host: StatusLineRendererHost) {}

	layout(width: number): StatusLineLayout {
		const contentWidth = Math.max(1, width);
		const left = 0;
		const statusDot = APP_ICONS.record;
		const userJumpButton = APP_ICONS.user;
		const thinkingExpandButton = APP_ICONS.thinkingExpanded;
		const compactToolsButton = APP_ICONS.compactTools;
		const terminalBellSoundWidgetText = this.host.terminalBellSoundStatusWidgetText();
		const promptEnhancerWidgetText = this.host.promptEnhancerStatusWidgetText();
		const voiceWidgetText = this.host.voiceStatusWidgetText();
		const rightWidgetText = [userJumpButton, terminalBellSoundWidgetText, thinkingExpandButton, compactToolsButton, promptEnhancerWidgetText, voiceWidgetText].filter((text) => text.length > 0).join(" ");
		const rightWidgetWidth = stringDisplayWidth(rightWidgetText);
		const leftWidth = rightWidgetWidth > 0 && contentWidth > rightWidgetWidth + 1 ? contentWidth - rightWidgetWidth - 1 : contentWidth;
		const baseStatus = this.host.currentStatus();
		const workspaceLabel = this.host.statusWorkspaceLabel();
		const modelUsageLabel = this.host.modelUsageStatusLabel();
		const workspaceDetailsLabel = modelUsageLabel ? `${workspaceLabel} ${modelUsageLabel}` : workspaceLabel;
		const contextBarLabel = this.contextBarLabel(baseStatus, leftWidth, workspaceDetailsLabel);
		const status = contextBarLabel ? `${baseStatus} ${contextBarLabel}` : baseStatus;
		const sessionLabel = "";
		const details = `${status} ${workspaceDetailsLabel}`;
		const leftText = padOrTrimPlain(`${statusDot} ${details}`, leftWidth);
		const innerText = leftWidth < contentWidth ? `${leftText} ${rightWidgetText}` : padOrTrimPlain(leftText, contentWidth);
		const text = padOrTrimPlain(innerText, width);
		let nextWidgetStartColumn = left + leftWidth + 2;
		const userJumpWidget = leftWidth < contentWidth
			? this.widgetLayout(nextWidgetStartColumn, userJumpButton)
			: undefined;
		if (userJumpWidget) nextWidgetStartColumn = userJumpWidget.endColumn + 1;
		const terminalBellSoundWidget = leftWidth < contentWidth && terminalBellSoundWidgetText.length > 0
			? this.widgetLayout(nextWidgetStartColumn, terminalBellSoundWidgetText)
			: undefined;
		if (terminalBellSoundWidget) nextWidgetStartColumn = terminalBellSoundWidget.endColumn + 1;
		const thinkingExpandWidget = leftWidth < contentWidth
			? this.widgetLayout(nextWidgetStartColumn, thinkingExpandButton)
			: undefined;
		if (thinkingExpandWidget) nextWidgetStartColumn = thinkingExpandWidget.endColumn + 1;
		const compactToolsWidget = leftWidth < contentWidth
			? this.widgetLayout(nextWidgetStartColumn, compactToolsButton)
			: undefined;
		if (compactToolsWidget) nextWidgetStartColumn = compactToolsWidget.endColumn + 1;
		const promptEnhancerWidget = leftWidth < contentWidth && promptEnhancerWidgetText.length > 0
			? this.widgetLayout(nextWidgetStartColumn, promptEnhancerWidgetText)
			: undefined;
		if (promptEnhancerWidget) nextWidgetStartColumn = promptEnhancerWidget.endColumn + 1;
		const voiceWidget = leftWidth < contentWidth && voiceWidgetText.length > 0 ? this.voiceWidgetLayout(nextWidgetStartColumn, voiceWidgetText) : undefined;

		return {
			details,
			text,
			sessionLabel,
			workspaceLabel,
			...(userJumpWidget ? { userJumpWidget } : {}),
			...(thinkingExpandWidget ? { thinkingExpandWidget } : {}),
			...(compactToolsWidget ? { compactToolsWidget } : {}),
			...(terminalBellSoundWidget ? { terminalBellSoundWidget } : {}),
			...(modelUsageLabel ? { modelUsageLabel } : {}),
			...(contextBarLabel ? { contextBarLabel } : {}),
			...(promptEnhancerWidget ? { promptEnhancerWidget } : {}),
			...(voiceWidget ? { voiceWidget } : {}),
		};
	}

	render(row: number, layout: StatusLineLayout, width: number): string {
		const colors = this.host.theme.colors;
		return this.host.screenStyler.styleLineSegments(row, layout.text, width, {
			foreground: colors.statusForeground,
		}, this.segments(layout.text, layout));
	}

	modelTarget(statusText: string, row: number): StatusModelTarget | undefined {
		const session = this.host.session;
		if (!session) return undefined;

		const label = this.host.statusModelLabel(session);
		const marker = `${label} ${this.host.statusThinkingLabel(session)} `;
		const startIndex = statusText.indexOf(marker);
		if (startIndex < 0) return undefined;

		return { row, startColumn: startIndex + 1, endColumn: startIndex + label.length + 1 };
	}

	thinkingTarget(statusText: string, row: number): StatusThinkingTarget | undefined {
		const session = this.host.session;
		if (!session) return undefined;

		const label = this.host.statusThinkingLabel(session);
		const marker = ` ${label} ${this.host.formatContextUsagePercent(session)}`;
		const markerIndex = statusText.indexOf(marker);
		const startIndex = markerIndex >= 0 ? markerIndex + 1 : statusText.indexOf(label);
		if (startIndex < 0) return undefined;

		return { row, startColumn: startIndex + 1, endColumn: startIndex + label.length + 1 };
	}

	contextTarget(statusText: string, row: number, layout: StatusLineLayout): StatusContextTarget | undefined {
		const session = this.host.session;
		if (!session) return undefined;

		const thinkingLabel = this.host.statusThinkingLabel(session);
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
		this.pushUserJumpWidgetSegment(segments, statusText);
		this.pushThinkingExpandWidgetSegment(segments, statusText);
		this.pushCompactToolsWidgetSegment(segments, statusText);
		this.pushTerminalBellSoundWidgetSegment(segments, statusText);
		this.pushWorkspaceSegments(segments, statusText, layout.workspaceLabel);
		if (layout.modelUsageLabel) this.pushModelUsageSegments(segments, statusText, layout.modelUsageLabel);
		this.pushPromptEnhancerWidgetSegment(segments, statusText);
		this.pushVoiceWidgetSegment(segments, statusText);

		const session = this.host.session;
		if (!session) return segments;

		const modelLabel = this.host.statusModelLabel(session);
		const thinkingLabel = this.host.statusThinkingLabel(session);
		const contextLabel = this.host.formatContextUsagePercent(session);
		this.pushSegment(segments, statusText.indexOf(`${modelLabel} ${thinkingLabel} `), modelLabel.length, this.modelProviderColor(session));

		const thinkingMarkerStart = statusText.indexOf(` ${thinkingLabel} ${contextLabel}`);
		const thinkingStart = thinkingMarkerStart >= 0 ? thinkingMarkerStart + 1 : -1;
		this.pushSegment(segments, thinkingStart, thinkingLabel.length, this.thinkingLevelColor(thinkingLabel));

		const contextPercent = this.host.roundedContextUsagePercent(session);
		if (contextPercent !== undefined && thinkingStart >= 0) {
			const contextStart = thinkingStart + thinkingLabel.length + 1;
			this.pushSegment(segments, contextStart, contextLabel.length, this.host.contextUsagePercentColor(contextPercent));

			if (layout.contextBarLabel) {
				const barStart = contextStart + contextLabel.length + 1;
				this.pushContextBarSegments(segments, barStart, contextPercent);
			}
		}

		this.pushSegment(segments, statusText.lastIndexOf(layout.sessionLabel), layout.sessionLabel.length, this.host.theme.colors.selectionForeground);
		return segments;
	}

	private pushPromptEnhancerWidgetSegment(segments: StyledSegment[], statusText: string): void {
		const widgetText = this.host.promptEnhancerStatusWidgetText();
		const start = statusText.lastIndexOf(widgetText);
		if (start < 0 || widgetText.length <= 0) return;
		const foreground = this.host.promptEnhancerStatusWidgetActive()
			? this.host.theme.colors.warning
			: this.host.promptEnhancerStatusWidgetEnabled()
				? this.host.theme.colors.info
				: this.host.theme.colors.muted;

		this.pushSegment(segments, start, widgetText.length, foreground);
	}

	private pushUserJumpWidgetSegment(segments: StyledSegment[], statusText: string): void {
		const buttonText = APP_ICONS.user;
		const start = statusText.indexOf(buttonText);
		if (start < 0) return;

		const foreground = this.host.userMessageJumpMenuActive?.()
			? this.host.theme.colors.info
			: this.host.theme.colors.muted;
		this.pushSegment(segments, start, buttonText.length, foreground);
	}

	private pushThinkingExpandWidgetSegment(segments: StyledSegment[], statusText: string): void {
		const buttonText = APP_ICONS.thinkingExpanded;
		const start = statusText.indexOf(buttonText);
		if (start < 0) return;
		this.pushSegment(segments, start, buttonText.length, this.host.allThinkingExpandedActive?.() ? this.host.theme.colors.info : this.host.theme.colors.muted);
	}

	private pushCompactToolsWidgetSegment(segments: StyledSegment[], statusText: string): void {
		const buttonText = APP_ICONS.compactTools;
		const start = statusText.indexOf(buttonText);
		if (start < 0) return;
		this.pushSegment(segments, start, buttonText.length, this.host.superCompactToolsActive?.() ? this.host.theme.colors.info : this.host.theme.colors.muted);
	}

	private pushTerminalBellSoundWidgetSegment(segments: StyledSegment[], statusText: string): void {
		const widgetText = this.host.terminalBellSoundStatusWidgetText();
		const start = statusText.lastIndexOf(widgetText);
		if (start < 0 || widgetText.length <= 0) return;
		this.pushSegment(segments, start, widgetText.length, this.host.terminalBellSoundStatusWidgetEnabled() ? this.host.theme.colors.info : this.host.theme.colors.muted);
	}

	private pushVoiceWidgetSegment(segments: StyledSegment[], statusText: string): void {
		const widgetText = this.host.voiceStatusWidgetText();
		const start = statusText.lastIndexOf(widgetText);
		if (start < 0 || widgetText.length <= 0) return;

		if (this.host.voiceStatusWidgetActive()) {
			const separatorIndex = widgetText.indexOf(" ");
			const micLength = separatorIndex >= 0 ? separatorIndex : widgetText.length;
			this.pushSegment(segments, start, micLength, this.host.theme.colors.error);
			return;
		}

		const separatorIndex = widgetText.indexOf(" ");
		const micLength = separatorIndex >= 0 ? separatorIndex : widgetText.length;
		this.pushSegment(segments, start, micLength, this.host.theme.colors.muted);
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

			if (!prefixColored) {
				prefixColored = true;
				const prefixLength = modelUsageLabel.slice(0, localStart).trimEnd().length;
				this.pushSegment(segments, labelStart, prefixLength, this.host.theme.colors.selectionForeground);
			}

			const percent = Number.parseInt(percentText, 10);
			if (!Number.isFinite(percent)) continue;

			const start = labelStart + localStart;
			const color = this.modelUsageProgressColor(percent);
			this.pushSegment(segments, start, percentToken.length, color);

			const barStart = start + percentToken.length + 1;
			segments.push(...compactProgressBarSegments(barStart, percent, {
				fill: color,
				track: this.host.theme.colors.statusDotBase,
			}, MODEL_USAGE_PROGRESS_BAR_WIDTH));

			const resetStart = barStart + MODEL_USAGE_PROGRESS_BAR_WIDTH + 1;
			const resetLength = this.modelUsageResetLength(modelUsageLabel, resetStart - labelStart);
			this.pushSegment(segments, resetStart, resetLength, this.host.theme.colors.muted);
		}
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
		const levels = this.availableThinkingLevels();
		const rank = levels.indexOf(label);
		if (rank >= 0) return this.thinkingRankColor(label, rank, levels.length);

		const fallbackLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
		const fallbackRank = fallbackLevels.indexOf(label);
		return fallbackRank >= 0
			? this.thinkingRankColor(label, fallbackRank, fallbackLevels.length)
			: this.host.theme.colors.info;
	}

	private availableThinkingLevels(): string[] {
		const levels = this.host.session?.getAvailableThinkingLevels();
		return Array.isArray(levels) && levels.length > 0 ? levels.map(String) : ["off", "minimal", "low", "medium", "high", "xhigh"];
	}

	private thinkingRankColor(label: string, rank: number, count: number): string {
		const baseColors = [
			this.host.theme.colors.muted,
			this.host.theme.colors.success,
			this.host.theme.colors.warning,
			this.host.theme.colors.toolMutation,
			this.host.theme.colors.error,
			this.host.theme.colors.thinkingXHigh,
		];
		const colors = count > baseColors.length ? [this.host.theme.colors.statusForeground, ...baseColors] : baseColors;
		const fallbackLevels = ["off", "minimal", "low", "medium", "high", "xhigh"];
		const fallbackRank = fallbackLevels.indexOf(label);
		const colorIndex = count <= baseColors.length && fallbackRank >= 0 ? fallbackRank : rank;
		return colors[Math.max(0, Math.min(colors.length - 1, colorIndex))] ?? this.host.theme.colors.info;
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

	private voiceWidgetLayout(startColumn: number, widgetText: string): StatusLineLayout["voiceWidget"] {
		const separatorIndex = widgetText.indexOf(" ");
		const micText = separatorIndex >= 0 ? widgetText.slice(0, separatorIndex) : widgetText;
		const languageStartOffset = separatorIndex >= 0 ? stringDisplayWidth(widgetText.slice(0, separatorIndex + 1)) : stringDisplayWidth(widgetText);
		const afterLanguageIndex = widgetText.indexOf(" ", separatorIndex + 1);
		const languageTextEndIndex = afterLanguageIndex >= 0 ? afterLanguageIndex : widgetText.length;
		const languageEndOffset = stringDisplayWidth(widgetText.slice(0, languageTextEndIndex));
		return {
			startColumn,
			micEndColumn: startColumn + stringDisplayWidth(micText),
			languageStartColumn: startColumn + languageStartOffset,
			languageEndColumn: startColumn + languageEndOffset,
			endColumn: startColumn + stringDisplayWidth(widgetText),
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
