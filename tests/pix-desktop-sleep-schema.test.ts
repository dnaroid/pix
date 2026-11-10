import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Value } from "typebox/value";
import { PixDesktopConfigSchema } from "../src/schemas/pix-desktop-schema.js";

test("Desktop sleep duration defaults to six hours and validates its numeric range", () => {
	for (const config of [{}, { desktop: {} }, ...[0.5, 6, 8.5, 24].map(sleepHours => ({ desktop: { sleepHours } }))]) {
		assert.equal(Value.Check(PixDesktopConfigSchema, config), true);
	}
	for (const sleepHours of ["6", null, false, 0, -1, 25]) {
		assert.equal(Value.Check(PixDesktopConfigSchema, { desktop: { sleepHours } }), false);
	}
	const property = PixDesktopConfigSchema.properties.desktop.properties.sleepHours;
	assert.equal((property as { default?: number }).default, 6);
	const schema = JSON.parse(readFileSync(new URL("../schemas/pix-desktop.json", import.meta.url), "utf8"));
	assert.deepEqual(schema.properties.desktop.properties.sleepHours, JSON.parse(JSON.stringify(property)));
});
