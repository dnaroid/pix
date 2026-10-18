import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Value } from "typebox/value";
import { PixDesktopConfigSchema } from "../src/schemas/pix-desktop-schema.js";

test("Desktop search schema retains RAG and intent preferences without semantic consent flags", () => {
	assert.equal(Value.Check(PixDesktopConfigSchema, {}), true);
	const search = PixDesktopConfigSchema.properties.search;
	assert.deepEqual(Object.keys(search.properties), ["ragModelRef", "ragThinking", "intentModelRef"]);
	for (const key of ["semanticEnabled", "sessionTitlesEnabled", "tasksSemanticEnabled"]) {
		assert.equal(Value.Check(PixDesktopConfigSchema, { search: { [key]: true } }), true, "obsolete flags remain harmless unknown fields, not controls");
	}
	assert.equal(Value.Check(PixDesktopConfigSchema, { search: { ragModelRef: "openai-codex/gpt-6.1-sol", ragThinking: "high" } }), true);
	assert.equal(Value.Check(PixDesktopConfigSchema, { search: { ragModelRef: "", ragThinking: "off" } }), true);
	assert.equal(Value.Check(PixDesktopConfigSchema, { search: { intentModelRef: "openrouter/~typesafe/jev-latest" } }), true);
	assert.equal(Value.Check(PixDesktopConfigSchema, { search: { ragThinking: "unlimited" } }), false);
	assert.equal((search.properties.ragModelRef as { default?: string }).default, "");
	assert.equal((search.properties.intentModelRef as { default?: string }).default, "");
	assert.equal(Object.keys(search.properties).some(key => /key|credential|token/i.test(key)), false);
	assert.equal(Value.Check(PixDesktopConfigSchema, { search: { messageFilterEnabled: true } }), true, "legacy unknown keys are ignored");
});

test("generated Desktop search schema matches the source and does not advertise keys", () => {
	const schema = JSON.parse(readFileSync(new URL("../schemas/pix-desktop.json", import.meta.url), "utf8"));
	assert.deepEqual(schema.properties.search, JSON.parse(JSON.stringify(PixDesktopConfigSchema.properties.search)));
});
