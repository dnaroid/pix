import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Value } from "typebox/value";
import { PixDesktopConfigSchema } from "../src/schemas/pix-desktop-schema.js";

test("Desktop tray icon is an optional boolean, defaults off, and is generated", () => {
	for (const config of [{}, { desktop: {} }, { desktop: { trayOnly: false } }, { desktop: { trayOnly: true } }]) {
		assert.equal(Value.Check(PixDesktopConfigSchema, config), true);
	}
	assert.equal(Value.Check(PixDesktopConfigSchema, { desktop: { trayOnly: "true" } }), false);
	const property = PixDesktopConfigSchema.properties.desktop.properties.trayOnly;
	assert.equal((property as { default?: boolean }).default, false);
	const schema = JSON.parse(readFileSync(new URL("../schemas/pix-desktop.json", import.meta.url), "utf8"));
	assert.deepEqual(schema.properties.desktop.properties.trayOnly, JSON.parse(JSON.stringify(property)));
});

test("enabling the tray leaves native application presentation and window cycling untouched", () => {
	const source = readFileSync(new URL("../desktop/src-tauri/src/desktop_tray.rs", import.meta.url), "utf8");
	assert.doesNotMatch(source, /ActivationPolicy|set_activation_policy|desktop_window_cycle/);
	assert.doesNotMatch(source, /app\.(?:set_menu|remove_menu|on_menu_event)\s*\(/);
	assert.match(source, /TrayIconBuilder::with_id\(TRAY_ID\)/);
});
