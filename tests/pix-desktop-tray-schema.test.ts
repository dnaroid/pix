import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Value } from "typebox/value";
import { PixDesktopConfigSchema } from "../src/schemas/pix-desktop-schema.js";

test("Desktop tray mode is an optional boolean, defaults to Dock, and is generated", () => {
	for (const config of [{}, { desktop: {} }, { desktop: { trayOnly: false } }, { desktop: { trayOnly: true } }]) {
		assert.equal(Value.Check(PixDesktopConfigSchema, config), true);
	}
	assert.equal(Value.Check(PixDesktopConfigSchema, { desktop: { trayOnly: "true" } }), false);
	const property = PixDesktopConfigSchema.properties.desktop.properties.trayOnly;
	assert.equal((property as { default?: boolean }).default, false);
	const schema = JSON.parse(readFileSync(new URL("../schemas/pix-desktop.json", import.meta.url), "utf8"));
	assert.deepEqual(schema.properties.desktop.properties.trayOnly, JSON.parse(JSON.stringify(property)));
});
