import { ANSI_RESET, ansiStylePrefix, type TextStyleOptions, type Theme } from "../../theme.js";
import { expandTabs, stringDisplayWidth, wrapDisplayLine } from "../../terminal-width.js";
import type { ToastEntry, ToastKind } from "../../ui.js";
import { APP_ICONS } from "../icons.js";
import { padOrTrimPlain } from "./render-text.js";
import type { ToastLineTarget } from "../types.js";

export type ToastOverlay = { id: number; row: number; column: number; text: string; output: string; target?: ToastLineTarget };

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
		if (state.variant === "dialog") {
			overlays.push(...renderDialogToastOverlay(state, width, Math.max(0, maxRows - overlays.length), theme, overlays.length));
			continue;
		}

		const icon = toastKindIcon(state.kind);
		const lines = toastMessageLines(state.message, icon, Math.max(1, width - 6));
		const visibleLines = lines.slice(0, Math.max(0, maxRows - overlays.length));
		if (visibleLines.length === 0) continue;

		const contentWidth = Math.max(...visibleLines.map((line) => stringDisplayWidth(line)));
		const toastWidth = Math.min(Math.max(12, contentWidth + 2), Math.max(1, width - 4));
		const leftWidth = Math.max(0, width - toastWidth - 2);
		const column = leftWidth + 1;
		const style = toastStyle(state, theme);

		for (const line of visibleLines) {
			const message = ` ${padOrTrimPlain(line, Math.max(0, toastWidth - 2))} `;
			const text = padOrTrimPlain(` ${padOrTrimPlain(stripToastAnsi(line), Math.max(0, toastWidth - 2))} `, toastWidth);
			const output = colorToastLine(message, toastWidth, {
				...style,
				bold: true,
			});

			overlays.push({
				id: state.id,
				row: overlays.length + 1,
				column,
				text,
				output,
				target: { kind: "toast", id: state.id, action: "toast", startColumn: column, endColumn: column + toastWidth },
			});
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
	const logicalLines = sanitizeToastText(message).split("\n");
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

function renderDialogToastOverlay(
	state: ToastEntry,
	width: number,
	maxRows: number,
	theme: Theme,
	rowOffset: number,
): ToastOverlay[] {
	if (maxRows <= 0 || width <= 0) return [];

	const maxDialogWidth = Math.max(1, Math.min(width - 4, 72));
	const closeLabel = `[${APP_ICONS.close}]`;
	const wrappedLines = dialogMessageLines(state.message, Math.max(1, maxDialogWidth - 4));
	const requiredWidth = Math.max(
		16,
		stringDisplayWidth(closeLabel) + 4,
		...wrappedLines.map((line) => stringDisplayWidth(line) + 4),
	);
	const dialogWidth = Math.min(maxDialogWidth, Math.max(16, requiredWidth));
	const bodyWidth = Math.max(1, dialogWidth - 4);
	const bodyLines = dialogMessageLines(state.message, bodyWidth);
	const bodyRows = Math.max(0, maxRows - 2);
	const visibleBodyLines = bodyLines.slice(0, bodyRows);
	const includeBottom = maxRows > 1;
	const dialogRows = [
		toastRow(dialogTopLine(closeLabel, dialogWidth)),
		...visibleBodyLines.map((line) => toastRow(`│ ${padOrTrimPlain(line, bodyWidth)} │`, `│ ${padOrTrimPlain(stripToastAnsi(line), bodyWidth)} │`)),
		...(includeBottom ? [toastRow(`╰${"─".repeat(Math.max(0, dialogWidth - 2))}╯`)] : []),
	].slice(0, maxRows);
	const leftWidth = Math.max(0, width - dialogWidth - 2);
	const column = leftWidth + 1;
	const style = toastStyle(state, theme);
	const closeStartColumn = column + 1 + dialogTopCloseOffset(closeLabel, dialogWidth);
	const closeEndColumn = closeStartColumn + stringDisplayWidth(closeLabel);

	return dialogRows.map((row, index) => ({
		id: state.id,
		row: rowOffset + index + 1,
		column,
		text: row.text,
		output: colorToastLine(row.output, dialogWidth, { ...style, bold: true }),
		target: index === 0
			? { kind: "toast", id: state.id, action: "close", startColumn: closeStartColumn, endColumn: closeEndColumn }
			: { kind: "toast", id: state.id, action: "body", startColumn: column, endColumn: column + dialogWidth },
	}));
}

function dialogMessageLines(message: string, maxWidth: number): string[] {
	const safeMaxWidth = Math.max(1, maxWidth);
	const lines = sanitizeToastText(message).split("\n").flatMap((line) => wrapDisplayLine(line, safeMaxWidth));
	return lines.length > 0 ? lines : [""];
}

function toastRow(output: string, text = output): { output: string; text: string } {
	return { output, text };
}

function sanitizeToastText(text: string): string {
	return expandTabs(text.replace(/⚠️?|\u{f0026}/gu, APP_ICONS.alert).replace(/\r/g, ""))
		.replace(/\x1b(?!\[[\d;:]*m)/gu, "␛");
}

function stripToastAnsi(text: string): string {
	return text.replace(/\x1b\[[\d;:]*m/gu, "");
}

function hasToastAnsiColor(text: string): boolean {
	return /\x1b\[[\d;:]*m/u.test(text);
}

function colorToastLine(text: string, width: number, options: TextStyleOptions): string {
	const line = padOrTrimPlain(text, width);
	const prefix = ansiStylePrefix(options);
	if (!prefix) return line;
	return `${prefix}${line.replaceAll(ANSI_RESET, `${ANSI_RESET}${prefix}`)}${ANSI_RESET}`;
}

function dialogTopLine(closeLabel: string, width: number): string {
	const innerWidth = Math.max(0, width - 2);
	const closeOffset = dialogTopCloseOffset(closeLabel, width);
	const closeWidth = stringDisplayWidth(closeLabel);
	const rightWidth = Math.max(0, innerWidth - closeOffset - closeWidth);
	return `╭${"─".repeat(closeOffset)}${padOrTrimPlain(closeLabel, Math.min(closeWidth, innerWidth - closeOffset))}${"─".repeat(rightWidth)}╮`;
}

function dialogTopCloseOffset(closeLabel: string, width: number): number {
	const innerWidth = Math.max(0, width - 2);
	const closeWidth = stringDisplayWidth(closeLabel);
	return Math.max(0, innerWidth - closeWidth - 1);
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

function toastStyle(state: ToastEntry, theme: Theme): { foreground: string; background: string } {
	const style = toastKindStyle(state.kind, theme);
	return hasToastAnsiColor(state.message) ? { ...style, background: "#000000" } : style;
}
