import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	APP_ICONS,
	appIconThemeFromFallbackFlag,
	currentAppIconTheme,
	parseAppIconThemeName,
	resolveAppIconThemeNameFromEnv,
	setAppIconTheme,
} from "../src/app/icons.js";

describe("app icon themes", () => {
	it("switches the centralized icon map to fallback glyphs", () => {
		setAppIconTheme("nerdFont");
		assert.equal(currentAppIconTheme(), "nerdFont");
		assert.equal(APP_ICONS.plus, "\u{f0415}");

		setAppIconTheme("fallback");
		assert.equal(currentAppIconTheme(), "fallback");
		assert.equal(APP_ICONS.plus, "+");
		assert.equal(APP_ICONS.closeCircle, "×");

		setAppIconTheme("nerdFont");
	});

	it("parses config names and fallback flags", () => {
		assert.equal(parseAppIconThemeName("fallback"), "fallback");
		assert.equal(parseAppIconThemeName("nerd-font"), "nerdFont");
		assert.equal(appIconThemeFromFallbackFlag("1"), "fallback");
		assert.equal(appIconThemeFromFallbackFlag("false"), "nerdFont");
		assert.equal(resolveAppIconThemeNameFromEnv({ PIX_USE_FALLBACK_ICONS: "yes" }), "fallback");
		assert.equal(resolveAppIconThemeNameFromEnv({ PIX_ICON_THEME: "plain" }), "fallback");
		assert.equal(resolveAppIconThemeNameFromEnv({}), "nerdFont");
	});
});
