import { colorLine, type Theme } from "../theme.js";
import { stringDisplayWidth, wrapDisplayLine } from "../terminal-width.js";
import type { ToastEntry, ToastKind } from "../ui.js";
import { APP_ICONS } from "./icons.js";
import { padOrTrimPlain, sanitizeText } from "./render-text.js";

export type ToastOverlay = { id: number; row: number; column: number; text: string; output: string };

export function renderToastOverlays(
	states: readonly ToastEntry[],
	width: number,
	maxRows: number,
	theme: Theme,
): ToastOverlay[] {
	if (maxRows <= 0) return [];

	const overlays: ToastOverlay[] = [];
	for (const state of [...states].reverse()) {
		if (overlays.length >= maxRows) break;

		const icon = toastKindIcon(state.kind);
		const lines = toastMessageLines(state.message, icon, Math.max(1, width - 6));
		const visibleLines = lines.slice(0, Math.max(0, maxRows - overlays.length));
		if (visibleLines.length === 0) continue;

		const contentWidth = Math.max(...visibleLines.map((line) => stringDisplayWidth(line)));
		const toastWidth = Math.min(Math.max(12, contentWidth + 2), Math.max(1, width - 4));
		const leftWidth = Math.max(0, width - toastWidth - 2);
		const column = leftWidth + 1;

		for (const line of visibleLines) {
			const message = ` ${padOrTrimPlain(line, Math.max(0, toastWidth - 2))} `;
			const text = padOrTrimPlain(message, toastWidth);
			const output = colorLine(message, toastWidth, {
				...toastKindStyle(state.kind, theme),
				bold: true,
			});

			overlays.push({ id: state.id, row: overlays.length + 1, column, text, output });
		}
	}

	return overlays;
}

function toastMessageLines(message: string, icon: string, maxWidth: number): string[] {
	const firstPrefix = `${icon} `;
	const continuationPrefix = " ".repeat(stringDisplayWidth(firstPrefix));
	const safeMaxWidth = Math.max(1, maxWidth);
	const safeContinuationPrefix = stringDisplayWidth(continuationPrefix) < safeMaxWidth ? continuationPrefix : "";

	const lines: string[] = [];
	const logicalLines = sanitizeText(message).split("\n");
	for (const [index, logicalLine] of logicalLines.entries()) {
		const prefix = index === 0 ? firstPrefix : continuationPrefix;
		const prefixWidth = stringDisplayWidth(prefix);
		const effectivePrefix = prefixWidth < safeMaxWidth ? prefix : "";
		const wrapWidth = Math.max(1, safeMaxWidth - stringDisplayWidth(effectivePrefix));
		const wrappedLines = wrapDisplayLine(logicalLine, wrapWidth);

		for (const [wrappedIndex, wrappedLine] of wrappedLines.entries()) {
			lines.push(`${wrappedIndex === 0 ? effectivePrefix : safeContinuationPrefix}${wrappedLine}`);
		}
	}

	return lines.length > 0 ? lines : [firstPrefix.trimEnd()];
}

function toastKindIcon(kind: ToastKind): string {
	switch (kind) {
		case "success":
			return APP_ICONS.checkCircle;
		case "error":
			return APP_ICONS.closeCircle;
		case "warning":
			return APP_ICONS.alert;
		case "info":
			return APP_ICONS.info;
	}
}

function toastKindStyle(kind: ToastKind, theme: Theme): { foreground: string; background: string } {
	switch (kind) {
		case "success":
			return { foreground: theme.colors.toastForeground, background: theme.colors.toastBackground };
		case "error":
			return { foreground: theme.colors.background, background: theme.colors.error };
		case "warning":
			return { foreground: theme.colors.background, background: theme.colors.warning };
		case "info":
			return { foreground: theme.colors.background, background: theme.colors.info };
	}
}
