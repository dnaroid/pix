import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import { modelsConfigured, parseRoles, setupConfigPaths, suggestRoles, writeRoles } from "../src/acp/model-setup.js";

const models = [
	{ provider: "p1", id: "alpha-flash" },
	{ provider: "p1", id: "alpha" },
	{ provider: "p1", id: "alpha-pro" },
];

test("suggests roles from name hints", () => {
	assert.deepEqual(suggestRoles(models), { main: "p1/alpha", fast: "p1/alpha-flash", strong: "p1/alpha-pro" });
	assert.equal(suggestRoles([]), undefined);
});

test("parseRoles rejects malformed refs", () => {
	assert.throws(() => parseRoles({ main: "x", fast: "p/a", strong: "p/b" }));
	assert.deepEqual(parseRoles({ main: "p/a", fast: "p/b", strong: "p/c" }), { main: "p/a", fast: "p/b", strong: "p/c" });
});

test("writeRoles writes pix + suite, desktop only if it exists", () => {
	const home = mkdtempSync(join(tmpdir(), "model-setup-"));
	const paths = setupConfigPaths(home);
	assert.equal(modelsConfigured(home), false);
	const written = writeRoles({ main: "p/a", fast: "p/b", strong: "p/c" }, home);
	assert.deepEqual(written, [paths.pix, paths.suite]);
	assert.equal(parse(readFileSync(paths.pix, "utf8")).defaultModel.modelRef, "p/a");
	assert.deepEqual(parse(readFileSync(paths.suite, "utf8")).frontierModels, [{ model: "p/c" }]);
	assert.equal(modelsConfigured(home), true);
	writeFileSync(paths.desktop, "{ // keep\n}\n");
	assert.equal(writeRoles({ main: "p/a", fast: "p/b", strong: "p/c" }, home).includes(paths.desktop), true);
	assert.match(readFileSync(paths.desktop, "utf8"), /keep/);
});

test("currentRoles reads roles back from written config", async () => {
	const { currentRoles } = await import("../src/acp/model-setup.js");
	const home = mkdtempSync(join(tmpdir(), "model-setup-cur-"));
	assert.equal(currentRoles(home), undefined);
	writeRoles({ main: "p/a", fast: "p/b", strong: "p/c" }, home);
	assert.deepEqual(currentRoles(home), { main: "p/a", fast: "p/b", strong: "p/c" });
});

test("slot overrides win over roles and are read back", async () => {
	const { currentSlotValues, MODEL_SLOTS } = await import("../src/acp/model-setup.js");
	const home = mkdtempSync(join(tmpdir(), "model-setup-slots-"));
	writeRoles({ main: "p/a", fast: "p/b", strong: "p/c" }, home, { autocomplete: "p/z", "agent-research": "p/y" });
	const cur = currentSlotValues(home);
	assert.equal(cur["autocomplete"], "p/z");
	assert.equal(cur["agent-research"], "p/y");
	assert.equal(cur["default"], "p/a");
	assert.equal(cur["git-review"], "p/c");
	assert.ok(MODEL_SLOTS.length > 15);
});

test("fallback, lookup and search settings are written and cleared", async () => {
	const { currentSlotValues, currentSlotLists } = await import("../src/acp/model-setup.js");
	const home = mkdtempSync(join(tmpdir(), "model-setup-fb-"));
	writeRoles({ main: "p/a", fast: "p/b", strong: "p/c" }, home, { "autocomplete-fallback": "p/f", lookup: "p/v", "lookup-fallback": "p/w" }, { provider: "ollama", model: "emb", vectorSize: 768, reranker: "r/x" });
	let cur = currentSlotValues(home);
	assert.deepEqual(currentSlotLists(home)["autocomplete-fallback"], ["p/f"]);
	assert.equal(cur["lookup"], "p/v");
	assert.deepEqual(currentSlotLists(home)["lookup-fallback"], ["p/w"]);
	const suite = parse(readFileSync(setupConfigPaths(home).suite, "utf8"));
	assert.equal(suite.search.embedding.embeddingModel, "emb");
	assert.equal(suite.search.rerankerModel, "r/x");
	writeRoles({ main: "p/a", fast: "p/b", strong: "p/c" }, home, { "autocomplete-fallback": "", lookup: "" });
	cur = currentSlotValues(home);
	assert.deepEqual(currentSlotLists(home)["autocomplete-fallback"], []);
	assert.equal(cur["lookup"], undefined);
});

test("frontierModels keeps existing entries and puts the primary first; search is read back", async () => {
	const { currentSearch } = await import("../src/acp/model-setup.js");
	const home = mkdtempSync(join(tmpdir(), "model-setup-fr-"));
	mkdirSync(dirname(setupConfigPaths(home).suite), { recursive: true });
	writeFileSync(setupConfigPaths(home).suite, JSON.stringify({ frontierModels: [{ model: "old/x", expensive: true, aliases: ["*x*"] }] }));
	writeRoles({ main: "p/a", fast: "p/b", strong: "p/c" }, home, {}, { provider: "ollama", model: "emb", vectorSize: 768 });
	const suite = parse(readFileSync(setupConfigPaths(home).suite, "utf8"));
	assert.deepEqual(suite.frontierModels.map((e: { model: string }) => e.model), ["p/c", "old/x"]);
	assert.equal(suite.frontierModels[1].expensive, true);
	assert.equal(currentSearch(home)?.model, "emb");
});

test("fallback lists are de-duplicated and never repeat the primary; thinking is written", () => {
	const home = mkdtempSync(join(tmpdir(), "setup-lists-"));
	const p = setupConfigPaths(home);
	mkdirSync(dirname(p.pix), { recursive: true });
	writeFileSync(p.pix, '{ "defaultModel": { "modelRef": "x/y", "fallbackModels": [], "thinking": "low" } }\n');
	writeRoles({ main: "p/a", fast: "p/b", strong: "p/c" }, home, {
		"default-fallback": ["p/a", "p/b", "p/b", "p/c"],
		"default:thinking": "high",
		"git-review:thinking": "xhigh",
	});
	const pix = parse(readFileSync(p.pix, "utf8"));
	assert.deepEqual(pix.defaultModel.fallbackModels, ["p/b", "p/c"]);
	assert.equal(pix.defaultModel.thinking, "high");
});

test("frontier list: no role default leaks in; explicit extras replace the tail and keep flags", () => {
	const home = mkdtempSync(join(tmpdir(), "setup-frontier-"));
	const p = setupConfigPaths(home);
	mkdirSync(dirname(p.suite), { recursive: true });
	writeFileSync(p.suite, '{ "frontierModels": [{ "model": "p/c" }, { "model": "q/x", "expensive": true }] }\n');
	const roles = { main: "p/a", fast: "p/b", strong: "p/c" };
	writeRoles(roles, home);
	assert.deepEqual(parse(readFileSync(p.suite, "utf8")).frontierModels, [{ model: "p/c" }, { model: "q/x", expensive: true }]);
	writeRoles(roles, home, { "frontier-extra": ["q/x", "p/c", "q/x"] });
	assert.deepEqual(parse(readFileSync(p.suite, "utf8")).frontierModels, [{ model: "p/c" }, { model: "q/x", expensive: true }]);
	writeRoles(roles, home, { "frontier-extra": [] });
	assert.deepEqual(parse(readFileSync(p.suite, "utf8")).frontierModels, [{ model: "p/c" }]);
});
