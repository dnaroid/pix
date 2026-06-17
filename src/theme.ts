import { padOrTrimDisplay } from "./terminal-width.js";

export type ThemeName = "dark" | "light";

export type Theme = {
	name: ThemeName;
	colors: {
		background: string;
		foreground: string;
		assistantForeground: string;
		muted: string;
		headerForeground: string;
		headerBackground: string;
		statusForeground: string;
		statusBackground: string;
		inputForeground: string;
		inputBackground: string;
		inputBorder: string;
		inputBorderWidgetBackground: string;
		tabBorder: string;
		assistantMessageBackground: string;
		userMessageBackground: string;
		thinkingMessageBackground: string;
		inputCursorBackground: string;
		popupForeground: string;
		popupBackground: string;
		popupHeaderBackground: string;
		popupBorder: string;
		popupMuted: string;
		popupSelectedForeground: string;
		popupSelectedBackground: string;
		selectionForeground: string;
		selectionBackground: string;
		toastForeground: string;
		toastBackground: string;
		accent: string;
		success: string;
		warning: string;
		heading: string;
		info: string;
		toolMutation: string;
		toolSearch: string;
		toolTitle: string;
		toolBash: string;
		toolRead: string;
		toolIndex: string;
		toolEdit: string;
		toolWeb: string;
		toolMeta: string;
		thinkingForeground: string;
		userForeground: string;
		thinkingXHigh: string;
		modelOpenAI: string;
		statusDotBase: string;
		statusDotRunningDim: string;
		statusDotThinkingDim: string;
		error: string;
	};
};

export const THEMES: Record<ThemeName, Theme> = {
	dark: {
		name: "dark",
		colors: {
			background: "#090d13",
			foreground: "#d6deeb",
			assistantForeground: "#a4bce0",
			muted: "#7d8590",
			headerForeground: "#c9d1d9",
			headerBackground: "#161b22",
			statusForeground: "#9ba5af",
			statusBackground: "#0f1520",
			inputForeground: "#f0f6fc",
			inputBackground: "#090d13",
			inputBorder: "#30363d",
			inputBorderWidgetBackground: "#2a2f36",
			tabBorder: "#7d8590",
			assistantMessageBackground: "",
			userMessageBackground: "",
			thinkingMessageBackground: "",
			inputCursorBackground: "#7fb3c8",
			popupForeground: "#e6edf3",
			popupBackground: "#1e1e1e",
			popupHeaderBackground: "#263241",
			popupBorder: "#1e1e1e",
			popupMuted: "#8a8a8a",
			popupSelectedForeground: "#e6edf3",
			popupSelectedBackground: "#2a2f36",
			selectionForeground: "#ffffff",
			selectionBackground: "#3b82f6",
			toastForeground: "#0d1117",
			toastBackground: "#a7f3d0",
			accent: "#7aa2d6",
			success: "#7ca982",
			warning: "#d49a4a",
			heading: "#d4b35e",
			info: "#7fb3c8",
			toolMutation: "#b87f98",
			toolSearch: "#9780bb",
			toolTitle: "#858f99",
			toolBash: "#b88862",
			toolRead: "#639b7c",
			toolIndex: "#698bb4",
			toolEdit: "#b46680",
			toolWeb: "#768ab6",
			toolMeta: "#787d92",
			thinkingForeground: "#64748b",
			userForeground: "#d97706",
			thinkingXHigh: "#ff8a86",
			modelOpenAI: "#c8b45a",
			statusDotBase: "#30363d",
			statusDotRunningDim: "#30363d",
			statusDotThinkingDim: "#30363d",
			error: "#c96a67",
		},
	},
	light: {
		name: "light",
		colors: {
			background: "#f8fafc",
			foreground: "#1f2937",
			assistantForeground: "#1f2937",
			muted: "#64748b",
			headerForeground: "#0f172a",
			headerBackground: "#e2e8f0",
			statusForeground: "#566578",
			statusBackground: "#edf0f4",
			inputForeground: "#0f172a",
			inputBackground: "#f8fafc",
			inputBorder: "#334155",
			inputBorderWidgetBackground: "#f1f5f9",
			tabBorder: "#64748b",
			assistantMessageBackground: "",
			userMessageBackground: "",
			thinkingMessageBackground: "",
			inputCursorBackground: "#0284c7",
			popupForeground: "#0f172a",
			popupBackground: "#ffffff",
			popupHeaderBackground: "#dbeafe",
			popupBorder: "#ffffff",
			popupMuted: "#64748b",
			popupSelectedForeground: "#0f172a",
			popupSelectedBackground: "#f1f5f9",
			selectionForeground: "#ffffff",
			selectionBackground: "#2563eb",
			toastForeground: "#064e3b",
			toastBackground: "#bbf7d0",
			accent: "#315f9f",
			success: "#47794c",
			warning: "#9a631d",
			heading: "#b88a28",
			info: "#246b8e",
			toolMutation: "#8c526a",
			toolSearch: "#68578c",
			toolTitle: "#5d6978",
			toolBash: "#8c704b",
			toolRead: "#477a5d",
			toolIndex: "#497496",
			toolEdit: "#8c4d65",
			toolWeb: "#52638c",
			toolMeta: "#747b8a",
			thinkingForeground: "#6b5491",
			userForeground: "#854d0e",
			thinkingXHigh: "#cf333d",
			modelOpenAI: "#75671f",
			statusDotBase: "#334155",
			statusDotRunningDim: "#334155",
			statusDotThinkingDim: "#334155",
			error: "#a44949",
		},
	},
};

export const ANSI_RESET = "\x1b[0m";

export type TextStyleOptions = {
	foreground?: string;
	background?: string;
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
};

const rgbCodeCache = new Map<string, string>();
const stylePrefixCache = new Map<string, string>();

export function parseThemeName(value: string): ThemeName | undefined {
	return value === "dark" || value === "light" ? value : undefined;
}

export function colorize(text: string, options: TextStyleOptions): string {
	const prefix = ansiStylePrefix(options);
	return prefix ? `${prefix}${text}${ANSI_RESET}` : text;
}

export function ansiStylePrefix(options: TextStyleOptions): string {
	const cacheKey = styleCacheKey(options);
	const cached = stylePrefixCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const codes: string[] = [];
	if (options.bold) codes.push("1");
	if (options.underline) codes.push("4");
	if (options.strikethrough) codes.push("9");
	if (options.foreground) codes.push(rgbCode("38", options.foreground));
	if (options.background) codes.push(rgbCode("48", options.background));
	const prefix = codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
	stylePrefixCache.set(cacheKey, prefix);
	return prefix;
}

export function colorLine(text: string, width: number, options: TextStyleOptions): string {
	return colorize(padOrTrimPlain(text, width), options);
}

export function padOrTrimPlain(text: string, width: number): string {
	return padOrTrimDisplay(text, width);
}

function rgbCode(prefix: "38" | "48", hex: string): string {
	const normalized = hex.replace(/^#/, "");
	const cacheKey = `${prefix}:${normalized}`;
	const cached = rgbCodeCache.get(cacheKey);
	if (cached) return cached;

	const red = Number.parseInt(normalized.slice(0, 2), 16);
	const green = Number.parseInt(normalized.slice(2, 4), 16);
	const blue = Number.parseInt(normalized.slice(4, 6), 16);
	const code = `${prefix};2;${red};${green};${blue}`;
	rgbCodeCache.set(cacheKey, code);
	return code;
}

function styleCacheKey(options: TextStyleOptions): string {
	return `${options.bold ? 1 : 0}|${options.underline ? 1 : 0}|${options.strikethrough ? 1 : 0}|${options.foreground ?? ""}|${options.background ?? ""}`;
}
