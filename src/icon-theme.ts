// Pure icon-theme name resolution. This module is intentionally dependency-free
// and lives at the root level so that low-level configuration loading (src/config.ts)
// can resolve the configured icon theme without reaching into the app/ layer,
// which keeps src/config.ts <-> src/app/icons.ts from forming an import cycle.

export const PIX_ICON_THEME_ENV = "PIX_ICON_THEME";
export const PIX_USE_FALLBACK_ICONS_ENV = "PIX_USE_FALLBACK_ICONS";

export type AppIconThemeName = "nerdFont" | "fallback";

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
