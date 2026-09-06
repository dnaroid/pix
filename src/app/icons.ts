// Centralized icon themes. The default theme uses Nerd Font / Material Design
// private-use glyphs; the fallback theme avoids icon-font codepoints so Pix is
// still readable when the terminal font is missing.
//
// Use codepoint escapes for private-use characters so editors cannot silently
// substitute visually similar glyphs.
//
// Theme-name parsing/resolution lives in the dependency-free src/icon-theme.ts so
// configuration loading can resolve the theme without importing this app/ module
// (breaks the src/config.ts <-> src/app/icons.ts import cycle).

import {
	resolveAppIconThemeNameFromEnv,
	type AppIconThemeName,
} from "../icon-theme.js";

// Re-exported for existing importers; the canonical home is src/icon-theme.ts.
export {
	appIconThemeFromFallbackFlag,
	appIconThemeOverrideFromEnv,
	parseAppIconThemeName,
	resolveAppIconThemeNameFromEnv,
	PIX_ICON_THEME_ENV,
	PIX_USE_FALLBACK_ICONS_ENV,
	type AppIconThemeName,
} from "../icon-theme.js";

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
	fork: "└",
	lightbulb: "\u{f0335}",
	microphone: "\u{f036c}",
	plus: "\u{f0415}",
	pause: "\u{f03e4}",
	play: "\u{f040a}",
	record: "\u{f044a}",
	refresh: "\u{f0450}",
	volumeHigh: "\u{f057e}",
	volumeOff: "\u{f0581}",
	user: "\u{f0004}",
	compactTools: "\u{f035c}",
	clipboardPaste: "\u{f0192}",
	thinkingExpanded: "\u{f0335}",
	stopCircle: "\u{f0665}",
	timerSand: "\u{f051f}",
	toolBodyEnd: "└",
	toolBodyGutter: "│",
	toolPreviewTruncated: "⊞",
	up: "↑",
	down: "↓",
	// Sub-agent icons (agent .md frontmatter `icon:` names). Values are shared
	// with the Pix Desktop lucide mapping in desktop/src/lib/agent-icons.ts.
	agent: "\u{f06a9}", // nf-md-robot
	search: "\u{f0349}", // nf-md-magnify
	code: "\u{f0174}", // nf-md-code_tags
	flask: "\u{f0093}", // nf-md-flask
	globe: "\u{f01e7}", // nf-md-earth
	sparkles: "\u{f0ae2}", // nf-md-star_four_points
	brain: "\u{f09d1}", // nf-md-brain
	wrench: "\u{f05b7}", // nf-md-wrench
	terminal: "\u{f018d}", // nf-md-console
	bug: "\u{f00e4}", // nf-md-bug
	book: "\u{f00ba}", // nf-md-book
	eye: "\u{f0208}", // nf-md-eye
	zap: "\u{f0241}", // nf-md-flash
	rocket: "\u{f0463}", // nf-md-rocket
} as const;

export type AppIconName = keyof typeof NERD_FONT_ICONS;
export type AppIconMap = Record<AppIconName, string>;

const FALLBACK_ICONS: AppIconMap = {
	alert: "⚠",
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
	fork: "└",
	lightbulb: "💡",
	microphone: "m",
	plus: "+",
	pause: "⏸",
	play: "▶",
	record: "●",
	refresh: "↻",
	volumeHigh: "♪",
	volumeOff: "ø",
	user: "@",
	compactTools: "≡",
	clipboardPaste: "P",
	thinkingExpanded: ">",
	stopCircle: "■",
	timerSand: "⏳",
	toolBodyEnd: "`",
	toolBodyGutter: "|",
	toolPreviewTruncated: "+",
	up: "↑",
	down: "↓",
	// Sub-agent icon fallbacks (no icon-font codepoints; readable when the
	// terminal font lacks Nerd Font glyphs). Emoji follow the existing fallback
	// precedent (lightbulb, timerSand).
	agent: "◇",
	search: "⌕",
	code: "{}",
	flask: "∆",
	globe: "⊕",
	sparkles: "✦",
	brain: "∞",
	wrench: "⚙",
	terminal: ">_",
	bug: "🐛",
	book: "▤",
	eye: "◉",
	zap: "↯",
	rocket: "🚀",
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

export function setAppIconTheme(themeName: AppIconThemeName): void {
	currentAppIconThemeName = themeName;
	Object.assign(APP_ICONS, APP_ICON_THEMES[themeName]);
}
