import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APP_ICONS, setAppIconTheme } from "../src/app/icons.js";
import { sanitizeText } from "../src/app/rendering/render-text.js";

describe("render text sanitization", () => {
	it("renders warning emoji as the active app alert icon", () => {
		setAppIconTheme("nerdFont");
		assert.equal(sanitizeText("⚠️ typescript:"), `${APP_ICONS.alert} typescript:`);

		setAppIconTheme("fallback");
		assert.equal(sanitizeText("⚠ typescript:"), "! typescript:");

		setAppIconTheme("nerdFont");
	});
});
