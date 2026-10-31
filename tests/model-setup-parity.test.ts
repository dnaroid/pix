import assert from "node:assert/strict";
import { test } from "node:test";

import { applyRolesToPixConfig, applyRolesToSuiteConfig, applyRolesToDesktopConfig, MODEL_SLOTS as ACP_SLOTS, suggestRoles } from "../acp/src/acp/model-setup.js";
import { applyModelRolesToPixConfig, applyModelRolesToSuiteConfig, applyModelRolesToDesktopConfig, MODEL_SLOTS, suggestModelRoles } from "../src/setup/model-profile.js";

// acp cannot import root src, so the writers are duplicated; this keeps them identical.
const roles = { main: "p/a", fast: "p/b", strong: "p/c" };
const models = [
	{ provider: "p1", id: "alpha-flash" },
	{ provider: "p1", id: "alpha", costOutput: 3 },
	{ provider: "p1", id: "alpha-pro", reasoning: true },
	{ provider: "p2", id: "beta-mini", contextWindow: 1000 },
];
const sources = ["", "{\n  // keep\n  \"x\": 1\n}\n"];

test("acp and root pix config writers agree", () => {
	for (const s of sources) assert.equal(applyRolesToPixConfig(s, roles), applyModelRolesToPixConfig(s, roles));
});

test("acp and root suite config writers agree", () => {
	for (const s of sources) assert.equal(applyRolesToSuiteConfig(s, roles), applyModelRolesToSuiteConfig(s, roles));
});

test("acp and root role suggestions agree", () => {
	assert.deepEqual(suggestRoles(models), suggestModelRoles(models));
});

test("both wizards expose identical judge slots and preserve independent config fields", () => {
	assert.deepEqual(ACP_SLOTS, MODEL_SLOTS);
	const source = '{ // Keep reports and search separate\n"knowledgeCheck":{"modelRef":"old/judge","thinking":"high","reportLanguage":"ru"},"search":{"ragModelRef":"p/rag","ragThinking":"max"}}';
	for (const overrides of [{}, { "knowledge-judge": "p/judge", "knowledge-judge:thinking": "low" },
		{ "knowledge-judge-desktop": "p/override", "knowledge-judge-desktop:thinking": "off" },
		{ "knowledge-judge-desktop": "", "knowledge-judge-desktop:thinking": "" },
		{ "knowledge-judge:thinking": "", "knowledge-judge-desktop:thinking": "high" }]) {
		assert.equal(applyRolesToSuiteConfig(source, roles, overrides), applyModelRolesToSuiteConfig(source, roles, overrides));
		assert.equal(applyRolesToPixConfig(source, roles, overrides), applyModelRolesToPixConfig(source, roles, overrides));
		assert.equal(applyRolesToDesktopConfig(source, roles, overrides), applyModelRolesToDesktopConfig(source, roles, overrides));
	}
});

test("writers agree with slot overrides, optional fallbacks and search", async () => {
	const { applySearchToSuiteConfig } = await import("../acp/src/acp/model-setup.js");
	const { applySearchToSuiteConfig: rootSearch } = await import("../src/setup/model-profile.js");
	const overrides = { autocomplete: "p/z", "autocomplete-fallback": "p/f", "agent-research": "p/y", lookup: "p/v", "lookup-fallback": "p/w" };
	const full = "{\n  \"autocomplete\": {},\n  \"modelRouting\": { \"tiers\": [{ \"id\": \"simple\" }] }\n}\n";
	for (const s of [...sources, full]) {
		assert.equal(applyRolesToPixConfig(s, roles, overrides), applyModelRolesToPixConfig(s, roles, overrides));
		assert.equal(applyRolesToSuiteConfig(s, roles, overrides), applyModelRolesToSuiteConfig(s, roles, overrides));
	}
	const search = { provider: "ollama" as const, model: "emb", vectorSize: 768, reranker: "r/x" };
	assert.equal(applySearchToSuiteConfig("", search), rootSearch("", search));
});
