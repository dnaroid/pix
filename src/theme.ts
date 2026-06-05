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
		userMessageBackground: string;
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
		info: string;
		toolMutation: string;
		toolSearch: string;
		toolTitle: string;
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
			assistantForeground: "#c9d1d9",
			muted: "#7d8590",
			headerForeground: "#c9d1d9",
			headerBackground: "#161b22",
			statusForeground: "#8b949e",
			statusBackground: "#090d13",
			inputForeground: "#f0f6fc",
			inputBackground: "#090d13",
			inputBorder: "#30363d",
			userMessageBackground: "#1e1e1e",
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
			info: "#7fb3c8",
			toolMutation: "#d47aa2",
			toolSearch: "#a889d6",
			toolTitle: "#9aa7b4",
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
			statusForeground: "#475569",
			statusBackground: "#f8fafc",
			inputForeground: "#0f172a",
			inputBackground: "#f8fafc",
			inputBorder: "#334155",
			userMessageBackground: "#ffffff",
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
			info: "#246b8e",
			toolMutation: "#a33a68",
			toolSearch: "#6d52a5",
			toolTitle: "#526070",
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

export function parseThemeName(value: string): ThemeName | undefined {
	return value === "dark" || value === "light" ? value : undefined;
}

export function colorize(text: string, options: TextStyleOptions): string {
	const codes: string[] = [];
	if (options.bold) codes.push("1");
	if (options.underline) codes.push("4");
	if (options.strikethrough) codes.push("9");
	if (options.foreground) codes.push(rgbCode("38", options.foreground));
	if (options.background) codes.push(rgbCode("48", options.background));
	return codes.length === 0 ? text : `\x1b[${codes.join(";")}m${text}${ANSI_RESET}`;
}

export function colorLine(text: string, width: number, options: TextStyleOptions): string {
	return colorize(padOrTrimPlain(text, width), options);
}

export function padOrTrimPlain(text: string, width: number): string {
	return padOrTrimDisplay(text, width);
}

function rgbCode(prefix: "38" | "48", hex: string): string {
	const normalized = hex.replace(/^#/, "");
	const red = Number.parseInt(normalized.slice(0, 2), 16);
	const green = Number.parseInt(normalized.slice(2, 4), 16);
	const blue = Number.parseInt(normalized.slice(4, 6), 16);
	return `${prefix};2;${red};${green};${blue}`;
}
