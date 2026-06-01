import type { Theme } from "./theme.js";

export type ProgressBarSegment = {
	start: number;
	end: number;
	foreground?: string;
	background?: string;
	bold?: boolean;
	strikethrough?: boolean;
};

export type CompactProgressBarColors = {
	fill: string;
	track: string;
	emptyForeground?: string;
};

const COMPACT_PROGRESS_BAR_WIDTH = 5;
const COMPACT_PROGRESS_BAR_FULL = "█";
const COMPACT_PROGRESS_BAR_EMPTY = " ";
const COMPACT_PROGRESS_BAR_PARTIALS = ["▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

export function formatCompactProgressBar(percent: number, width = COMPACT_PROGRESS_BAR_WIDTH): string {
	let result = "";
	for (let index = 0; index < width; index++) result += progressBarCell(percent, index, width);
	return result;
}

export function compactProgressBarSegments(start: number, percent: number, colors: CompactProgressBarColors, width = COMPACT_PROGRESS_BAR_WIDTH): ProgressBarSegment[] {
	if (start < 0) return [];

	const segments: ProgressBarSegment[] = [];
	for (let index = 0; index < width; index++) {
		const active = progressBarCellFill(percent, index, width) > 0;
		segments.push({
			start: start + index,
			end: start + index + 1,
			foreground: active ? colors.fill : colors.emptyForeground ?? colors.fill,
			background: colors.track,
		});
	}
	return segments;
}

export function contextUsageProgressColor(percent: number, colors: Theme["colors"]): string {
	if (percent <= 30) return colors.success;
	if (percent <= 50) return colors.warning;
	return colors.error;
}

function progressBarCell(percent: number, index: number, width: number): string {
	const fill = progressBarCellFill(percent, index, width);
	if (fill >= 1) return COMPACT_PROGRESS_BAR_FULL;
	if (fill <= 0) return COMPACT_PROGRESS_BAR_EMPTY;

	const partialIndex = Math.max(0, Math.min(COMPACT_PROGRESS_BAR_PARTIALS.length - 1, Math.ceil(fill * COMPACT_PROGRESS_BAR_PARTIALS.length) - 1));
	return COMPACT_PROGRESS_BAR_PARTIALS[partialIndex] ?? COMPACT_PROGRESS_BAR_EMPTY;
}

function progressBarCellFill(percent: number, index: number, width: number): number {
	const cellSize = 100 / Math.max(1, width);
	return Math.max(0, Math.min(1, (clampProgressPercent(percent) - index * cellSize) / cellSize));
}

function clampProgressPercent(percent: number): number {
	return Math.max(0, Math.min(100, percent));
}
