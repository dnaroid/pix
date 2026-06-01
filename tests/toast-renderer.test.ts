import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APP_ICONS } from "../src/app/icons.js";
import { renderToastOverlays } from "../src/app/toast-renderer.js";
import { stringDisplayWidth } from "../src/terminal-width.js";
import { THEMES } from "../src/theme.js";
import type { ToastEntry } from "../src/ui.js";

describe("renderToastOverlays", () => {
	it("renders multiline toasts as separate full-width overlay rows", () => {
		const overlays = renderToastOverlays([
			toast("DCP — Dynamic Context Pruning\nCommands:\n  /dcp context — Show context window usage breakdown"),
		], 80, 5, THEMES.dark);

		assert.equal(overlays.length, 3);
		assert.deepEqual(overlays.map((overlay) => overlay.row), [1, 2, 3]);
		assert.ok(overlays[0]?.text.includes("DCP — Dynamic Context Pruning"));
		assert.ok(overlays[1]?.text.includes("Commands:"));
		assert.ok(overlays[2]?.text.includes("/dcp context"));
		assert.equal(overlays.every((overlay) => !overlay.output.includes("\n")), true);
		assert.deepEqual(overlays.map((overlay) => stringDisplayWidth(overlay.text)), [80, 80, 80]);
	});

	it("limits multiline toasts by available overlay rows", () => {
		const overlays = renderToastOverlays([
			toast("one\ntwo\nthree"),
		], 40, 2, THEMES.dark);

		assert.deepEqual(overlays.map((overlay) => overlay.text.trim()), [
			`${APP_ICONS.info} one`,
			"two",
		]);
	});
});

function toast(message: string): ToastEntry {
	return { id: 1, message, kind: "info", createdAt: 0 };
}
