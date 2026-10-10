import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Value } from "typebox/value";
import { PixDesktopConfigSchema } from "../src/schemas/pix-desktop-schema.js";

test("Desktop search schema models optional explicit boolean consent without credentials", () => {
	assert.equal(Value.Check(PixDesktopConfigSchema, {}), true);
	for (const enabled of [true, false]) assert.equal(Value.Check(PixDesktopConfigSchema, { search: { semanticEnabled: enabled } }), true);
	for (const enabled of [true, false]) assert.equal(Value.Check(PixDesktopConfigSchema, { search: { sessionTitlesEnabled: enabled } }), true);
	for (const enabled of [true, false]) assert.equal(Value.Check(PixDesktopConfigSchema, { search: { tasksSemanticEnabled: enabled } }), true);
	assert.equal(Value.Check(PixDesktopConfigSchema, { search: { semanticEnabled: "true" } }), false);
	assert.equal(Value.Check(PixDesktopConfigSchema, { search: { sessionTitlesEnabled: "true" } }), false);
	assert.equal(Value.Check(PixDesktopConfigSchema, { search: { tasksSemanticEnabled: "true" } }), false);
	const search = PixDesktopConfigSchema.properties.search;
	assert.equal((search.properties.semanticEnabled as { default?: boolean }).default, false);
	assert.equal((search.properties.sessionTitlesEnabled as { default?: boolean }).default, false);
	assert.equal((search.properties.tasksSemanticEnabled as { default?: boolean }).default, false);
	assert.deepEqual(Object.keys(search.properties), ["semanticEnabled", "sessionTitlesEnabled", "tasksSemanticEnabled", "ragModelRef", "ragThinking"]);
	assert.equal(Value.Check(PixDesktopConfigSchema, { search: { ragModelRef: "openai-codex/gpt-6.1-sol", ragThinking: "high" } }), true);
	assert.equal(Value.Check(PixDesktopConfigSchema, { search: { ragModelRef: "", ragThinking: "off" } }), true);
	assert.equal(Value.Check(PixDesktopConfigSchema, { search: { ragThinking: "unlimited" } }), false);
	assert.equal((search.properties.ragModelRef as { default?: string }).default, "");
	assert.equal(Object.keys(search.properties).some(key => /key|credential|token/i.test(key)), false);
	assert.equal(Value.Check(PixDesktopConfigSchema, { search: { messageFilterEnabled: true } }), true, "legacy unknown keys are ignored");
});

test("generated Desktop search schema matches the source and does not advertise keys", () => {
	const schema = JSON.parse(readFileSync(new URL("../schemas/pix-desktop.json", import.meta.url), "utf8"));
	assert.deepEqual(schema.properties.search, JSON.parse(JSON.stringify(PixDesktopConfigSchema.properties.search)));
});
