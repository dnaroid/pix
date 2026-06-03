import { expandTabs, padOrTrimDisplay, sliceByDisplayWidth, stringDisplayWidth } from "../terminal-width.js";
import { APP_ICONS } from "./icons.js";

export function sanitizeText(text: string): string {
	return expandTabs(text.replace(/⚠️?|\u{f0026}/gu, APP_ICONS.alert).replace(/\x1b/g, "␛").replace(/\r/g, ""));
}

export function normalizePastedTextForDuplicateKey(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function ellipsizeDisplay(text: string, width: number): string {
	const safeWidth = Math.max(0, width);
	if (safeWidth === 0) return "";
	if (stringDisplayWidth(text) <= safeWidth) return text;
	if (safeWidth === 1) return "…";

	return `${sliceByDisplayWidth(text, safeWidth - 1)}…`;
}

export function horizontalPaddingLayout(width: number): { left: number; right: number; contentWidth: number } {
	const safeWidth = Math.max(1, width);
	const left = safeWidth > 1 ? 1 : 0;
	const right = safeWidth > 2 ? 1 : 0;
	return { left, right, contentWidth: Math.max(1, safeWidth - left - right) };
}

export function padOrTrimPlain(text: string, width: number): string {
	return padOrTrimDisplay(text, width);
}
