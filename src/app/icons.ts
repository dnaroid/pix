// Centralized icon themes. The default theme uses Nerd Font / Material Design
// private-use glyphs; the fallback theme avoids icon-font codepoints so Pix is
// still readable when the terminal font is missing.
//
// Use codepoint escapes for private-use characters so editors cannot silently
// substitute visually similar glyphs.

export const PIX_ICON_THEME_ENV = "PIX_ICON_THEME";
export const PIX_USE_FALLBACK_ICONS_ENV = "PIX_USE_FALLBACK_ICONS";

const NERD_FONT_ICONS = {
	alert: "\u{f0026}",
	autoFix: "\u{f0068}",
	check: "\u{f012c}",
	checkCircle: "\u{f05e0}",
	circle: "\u{f0765}",
	circleOutline: "\u{f0766}",
	close: "\u{f0156}",
	closeCircle: "\u{f0159}",
	deleted: "\u{f0159}",
	deferred: "\u{f0377}",
	info: "\u{f02fc}",
	microphone: "\u{f036c}",
	plus: "\u{f0415}",
	record: "\u{f044a}",
	refresh: "\u{f0450}",
	volumeHigh: "\u{f057e}",
	volumeOff: "\u{f0581}",
	user: "\u{f0004}",
	compactTools: "\u{f035c}",
	thinkingExpanded: "\u{f0335}",
	stopCircle: "\u{f0665}",
	timerSand: "\u{f051f}",
	down: "\u{f0045}",
} as const;

export type AppIconName = keyof typeof NERD_FONT_ICONS;
export type AppIconMap = Record<AppIconName, string>;
export type AppIconThemeName = "nerdFont" | "fallback";

const FALLBACK_ICONS: AppIconMap = {
	alert: "!",
	autoFix: "*",
	check: "✓",
	checkCircle: "✓",
	circle: "●",
	circleOutline: "○",
	close: "×",
	closeCircle: "×",
	deleted: "×",
	deferred: "↷",
	info: "i",
	microphone: "m",
	plus: "+",
	record: "●",
	refresh: "↻",
	volumeHigh: "♪",
	volumeOff: "ø",
	user: "@",
	compactTools: "≡",
	thinkingExpanded: ">",
	stopCircle: "■",
	timerSand: "⏳",
	down: "v",
};

export const APP_ICON_THEMES: Record<AppIconThemeName, AppIconMap> = {
	nerdFont: NERD_FONT_ICONS,
	fallback: FALLBACK_ICONS,
};

let currentAppIconThemeName = resolveAppIconThemeNameFromEnv();

export const APP_ICONS: AppIconMap = { ...APP_ICON_THEMES[currentAppIconThemeName] };

export function currentAppIconTheme(): AppIconThemeName {
	return currentAppIconThemeName;
}

export function parseAppIconThemeName(value: unknown): AppIconThemeName | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase().replace(/[\s_-]+/gu, "");
	if (normalized === "fallback" || normalized === "plain" || normalized === "ascii") return "fallback";
	if (normalized === "nerdfont" || normalized === "font" || normalized === "icons") return "nerdFont";
	return undefined;
}

export function appIconThemeFromFallbackFlag(value: unknown): AppIconThemeName | undefined {
	if (typeof value === "boolean") return value ? "fallback" : "nerdFont";
	if (typeof value !== "string") return undefined;

	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on", "fallback"].includes(normalized)) return "fallback";
	if (["0", "false", "no", "off", "nerdfont", "nerd-font"].includes(normalized)) return "nerdFont";
	return undefined;
}

export function resolveAppIconThemeNameFromEnv(env: NodeJS.ProcessEnv = process.env): AppIconThemeName {
	return appIconThemeOverrideFromEnv(env) ?? "nerdFont";
}

export function appIconThemeOverrideFromEnv(env: NodeJS.ProcessEnv = process.env): AppIconThemeName | undefined {
	return appIconThemeFromFallbackFlag(env[PIX_USE_FALLBACK_ICONS_ENV])
		?? parseAppIconThemeName(env[PIX_ICON_THEME_ENV])
		?? undefined;
}

export function setAppIconTheme(themeName: AppIconThemeName): void {
	currentAppIconThemeName = themeName;
	Object.assign(APP_ICONS, APP_ICON_THEMES[themeName]);
}
