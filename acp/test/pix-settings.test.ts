import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse as parseJsonc } from "jsonc-parser";

import {
	loadPixCommandSettings,
	loadPixIgnoreContextFiles,
	parseModelRef,
	savePixAutocompleteModel,
	savePixDefaultModel,
	savePixDefaultThinking,
	saveProjectPixIgnoreContextFiles,
} from "../src/acp/pix-settings.js";

function fixture(): { home: string; path: string } {
	const home = mkdtempSync(join(tmpdir(), "pix-acp-settings-"));
	const path = join(home, ".config", "pi", "pix.jsonc");
	mkdirSync(join(home, ".config", "pi"), { recursive: true });
	return { home, path };
}

test("parseModelRef accepts an optional known thinking suffix", () => {
	assert.deepEqual(parseModelRef("openai-codex/gpt-5.6-sol:high"), {
		provider: "openai-codex",
		modelId: "gpt-5.6-sol",
		thinkingLevel: "high",
	});
	assert.deepEqual(parseModelRef("openai-codex/gpt-5.6-sol"), {
		provider: "openai-codex",
		modelId: "gpt-5.6-sol",
	});
	assert.equal(parseModelRef("missing-provider"), undefined);
	assert.equal(parseModelRef("openai/model:warp"), undefined);
});

test("default-model writes JSONC and preserves the configured thinking level when omitted", () => {
	const { home, path } = fixture();
	writeFileSync(path, `{
		// keep comments parseable
		"defaultModel": { "modelRef": "old/model", "thinking": "medium" }
	}`);

	assert.equal(savePixDefaultModel("openai/gpt-5", home), "openai/gpt-5:medium");
	const parsed = parseJsonc(readFileSync(path, "utf8")) as { defaultModel?: { modelRef?: string; thinking?: string } };
	assert.deepEqual(parsed.defaultModel, { modelRef: "openai/gpt-5", thinking: "medium" });
});

test("default-thinking uses the selected session model when no default exists", () => {
	const { home, path } = fixture();
	writeFileSync(path, `{ "autocomplete": { "modelRef": "zai/glm" } }`);

	assert.equal(savePixDefaultThinking("xhigh", "openai/gpt-5", home), "openai/gpt-5:xhigh");
	assert.deepEqual(loadPixCommandSettings(home).defaultModel, {
		provider: "openai",
		modelId: "gpt-5",
		thinkingLevel: "xhigh",
	});
});

test("autocomplete model can be selected and explicitly disabled", () => {
	const { home } = fixture();
	assert.equal(savePixAutocompleteModel("zai/glm-5-turbo:low", home), "zai/glm-5-turbo:low");
	assert.equal(loadPixCommandSettings(home).autocompleteModelRef, "zai/glm-5-turbo:low");
	assert.equal(savePixAutocompleteModel("", home), "");
	assert.equal(loadPixCommandSettings(home).autocompleteModelRef, "");
});

test("project no-context-files overrides the global Pix setting", () => {
	const { home, path } = fixture();
	const cwd = mkdtempSync(join(tmpdir(), "pix-acp-project-settings-"));
	writeFileSync(path, `{ "ignoreContextFiles": false }`);

	assert.equal(loadPixIgnoreContextFiles(cwd, home), false);
	assert.equal(saveProjectPixIgnoreContextFiles(cwd, true), true);
	assert.equal(loadPixIgnoreContextFiles(cwd, home), true);
	const project = parseJsonc(readFileSync(join(cwd, ".pi", "pix.jsonc"), "utf8")) as { ignoreContextFiles?: boolean };
	assert.equal(project.ignoreContextFiles, true);
});
