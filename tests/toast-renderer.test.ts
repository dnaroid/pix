import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APP_ICONS } from "../src/app/icons.js";
import { renderToastOverlays } from "../src/app/rendering/toast-renderer.js";
import { stringDisplayWidth } from "../src/terminal-width.js";
import { THEMES } from "../src/theme.js";
import type { ToastEntry } from "../src/ui.js";

describe("renderToastOverlays", () => {
	it("renders multiline toasts as compact overlay rows", () => {
		const overlays = renderToastOverlays([
			toast("DCP — Dynamic Context Pruning\nCommands:\n  /dcp context — Show context window usage breakdown"),
		], 80, 5, THEMES.dark);

		assert.equal(overlays.length, 3);
		assert.deepEqual(overlays.map((overlay) => overlay.row), [1, 2, 3]);
		assert.ok(overlays[0]?.text.includes("DCP — Dynamic Context Pruning"));
		assert.ok(overlays[1]?.text.includes("Commands:"));
		assert.ok(overlays[2]?.text.includes("/dcp context"));
		assert.equal(overlays.every((overlay) => !overlay.output.includes("\n")), true);
		assert.equal(overlays.every((overlay) => overlay.column > 1), true);
		assert.equal(overlays.every((overlay) => stringDisplayWidth(overlay.text) < 80), true);
		assert.equal(overlays.every((overlay) => overlay.column + stringDisplayWidth(overlay.text) <= 80), true);
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

	it("renders dialog toasts with a close target", () => {
		const overlays = renderToastOverlays([
			toast("Context usage\nTokens: 100 / 1000", "dialog"),
		], 80, 5, THEMES.dark);

		assert.equal(overlays.length, 4);
		assert.ok(overlays[0]?.text.includes("Dialog"));
		assert.ok(overlays[0]?.text.includes(APP_ICONS.close));
		assert.ok(overlays[1]?.text.includes("Context usage"));
		assert.ok(overlays[2]?.text.includes("Tokens: 100 / 1000"));
		assert.equal(overlays[0]?.target?.action, "close");
		assert.equal(overlays[1]?.target?.action, "body");
		assert.ok((overlays[0]?.target?.startColumn ?? 0) > overlays[0]!.column);
		assert.ok((overlays[0]?.target?.endColumn ?? 0) <= overlays[0]!.column + stringDisplayWidth(overlays[0]!.text));
		assert.equal(overlays.every((overlay) => overlay.column > 1), true);
		assert.equal(overlays.every((overlay) => overlay.column + stringDisplayWidth(overlay.text) <= 80), true);
	});
});

function toast(message: string, variant?: ToastEntry["variant"]): ToastEntry {
	return { id: 1, message, kind: "info", createdAt: 0, ...(variant ? { variant } : {}) };
}
