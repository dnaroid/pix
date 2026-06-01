import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ANSI_RESET, THEMES, colorLine, colorize, padOrTrimPlain, parseThemeName } from "../src/theme.js";
import { PopupMenu, Toast } from "../src/ui.js";

describe("theme helpers", () => {
	it("parses known themes and colorizes text", () => {
		assert.equal(parseThemeName("dark"), "dark");
		assert.equal(parseThemeName("light"), "light");
		assert.equal(parseThemeName("nope"), undefined);
		assert.equal(colorize("plain", {}), "plain");
		assert.equal(colorize("x", { foreground: "#010203", background: "#040506", bold: true }), "\u001b[1;38;2;1;2;3;48;2;4;5;6mx" + ANSI_RESET);
		assert.equal(colorize("x", { underline: true }), "\u001b[4mx" + ANSI_RESET);
		assert.equal(colorize("x", { strikethrough: true }), "\u001b[9mx" + ANSI_RESET);
		assert.equal(colorLine("abc", 5, { foreground: "#000000" }), "\u001b[38;2;0;0;0mabc  " + ANSI_RESET);
		assert.equal(padOrTrimPlain("abcdef", 3), "abc");
	});

	it("keeps semantic text colors WCAG AA readable", () => {
		const semanticTextColors = ["accent", "success", "warning", "info", "toolMutation", "toolSearch", "toolTitle", "thinkingXHigh", "modelOpenAI", "error"] as const;

		for (const theme of Object.values(THEMES)) {
			for (const colorName of semanticTextColors) {
				assert.ok(
					contrastRatio(theme.colors[colorName], theme.colors.background) >= 4.5,
					`${theme.name}.${colorName} should contrast with background`,
				);
			}
		}
	});
});

function contrastRatio(foreground: string, background: string): number {
	const foregroundLuminance = relativeLuminance(foreground);
	const backgroundLuminance = relativeLuminance(background);
	const lighter = Math.max(foregroundLuminance, backgroundLuminance);
	const darker = Math.min(foregroundLuminance, backgroundLuminance);
	return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(hex: string): number {
	const normalized = hex.replace(/^#/, "");
	const [red, green, blue] = [0, 2, 4]
		.map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255)
		.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
	return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

describe("PopupMenu", () => {
	it("opens, clamps selection, scrolls, and reports visible rows", () => {
		const menu = new PopupMenu<number>({ maxVisibleRows: 2 });
		menu.openWithItems([{ value: 1, label: "one" }, { value: 2, label: "two" }, { value: 3, label: "three" }]);
		assert.equal(menu.open, true);
		assert.equal(menu.selectedItem()?.value, 1);

		menu.moveSelection(2);
		assert.equal(menu.selectedIndex, 2);
		assert.equal(menu.scrollOffset, 1);
		assert.deepEqual(menu.visibleItems().map((item) => [item.value, item.index, item.selected]), [[2, 1, false], [3, 2, true]]);

		menu.scroll(-1);
		assert.equal(menu.scrollOffset, 0);
		assert.equal(menu.selectedIndex, 1);
		menu.setItems([{ value: 9, label: "nine" }]);
		assert.equal(menu.selectedIndex, 0);
		menu.close();
		assert.equal(menu.open, false);
	});

	it("handles empty menus and one-row minimum", () => {
		const menu = new PopupMenu<string>({ maxVisibleRows: 0 });
		assert.equal(menu.maxVisibleRows, 1);
		menu.moveSelection(1);
		assert.equal(menu.selectedItem(), undefined);
		assert.deepEqual(menu.visibleItems(), []);
	});

	it("renders the last item as a normal scrollable row", () => {
		const menu = new PopupMenu<string>({ maxVisibleRows: 3 });
		menu.openWithItems([
			{ value: "one", label: "one" },
			{ value: "two", label: "two" },
			{ value: "three", label: "three" },
			{ value: "cancel", label: "Cancel" },
		]);

		assert.deepEqual(menu.visibleItems().map((item) => [item.value, item.index, item.selected]), [
			["one", 0, true],
			["two", 1, false],
			["three", 2, false],
		]);

		menu.moveSelection(2);
		assert.deepEqual(menu.visibleItems().map((item) => [item.value, item.index, item.selected]), [
			["one", 0, false],
			["two", 1, false],
			["three", 2, true],
		]);

		menu.moveSelection(1);
		assert.equal(menu.selectedItem()?.value, "cancel");
		assert.deepEqual(menu.visibleItems().map((item) => [item.value, item.index, item.selected]), [
			["two", 1, false],
			["three", 2, false],
			["cancel", 3, true],
		]);
	});
});

describe("Toast", () => {
	it("shows stacked toasts, hides individually, and exposes visibility", () => {
		const toast = new Toast();
		assert.equal(toast.visible, false);
		const savedId = toast.show("saved", "success");
		assert.deepEqual(toast.state, { message: "saved", kind: "success" });
		assert.equal(toast.visible, true);
		const warningId = toast.show("warning", "warning");
		const infoId = toast.show("info");
		assert.deepEqual(toast.state, { message: "info", kind: "info" });
		assert.deepEqual(toast.visibleStates.map((entry) => [entry.id, entry.message, entry.kind]), [
			[savedId, "saved", "success"],
			[warningId, "warning", "warning"],
			[infoId, "info", "info"],
		]);
		toast.hide(warningId);
		assert.deepEqual(toast.visibleStates.map((entry) => entry.kind), ["success", "info"]);
		toast.hide();
		assert.equal(toast.visible, false);
	});
});
