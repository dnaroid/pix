import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultModelFromParsed, loadPixDefaultModel } from "../src/acp/default-model.js";

function fixture(): { home: string; cwd: string; globalPath: string; projectPath: string } {
	const root = mkdtempSync(join(tmpdir(), "pix-acp-default-model-"));
	const home = join(root, "home");
	const cwd = join(root, "project");
	const globalPath = join(home, ".config", "pi", "pix.jsonc");
	const projectPath = join(cwd, ".pi", "pix.jsonc");
	mkdirSync(join(home, ".config", "pi"), { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	return { home, cwd, globalPath, projectPath };
}

test("uses the same first-launch default as the Pix TUI", () => {
	const { home, cwd } = fixture();
	assert.deepEqual(loadPixDefaultModel(cwd, home), {
		provider: "openai-codex",
		modelId: "gpt-5.6-sol",
		thinkingLevel: "medium",
	});
});

test("project Pix config overrides the global default model", () => {
	const { home, cwd, globalPath, projectPath } = fixture();
	writeFileSync(globalPath, `{
		// global default
		"defaultModel": { "modelRef": "openai-codex/gpt-5.5", "thinking": "medium" }
	}`);
	writeFileSync(projectPath, `{ "modelDefault": "zai/glm-5-turbo:low" }`);

	assert.deepEqual(loadPixDefaultModel(cwd, home), {
		provider: "zai",
		modelId: "glm-5-turbo",
		thinkingLevel: "low",
	});
});

test("an existing global config without a default leaves model selection to pi", () => {
	const { home, cwd, globalPath } = fixture();
	writeFileSync(globalPath, `{ "autocomplete": { "modelRef": "zai/glm-5-turbo" } }`);
	assert.equal(loadPixDefaultModel(cwd, home), undefined);
});

test("object thinking overrides a model-reference suffix", () => {
	assert.deepEqual(defaultModelFromParsed({
		defaultModel: { model: "zai/glm-5-turbo:low", thinkingLevel: "xhigh" },
	}), {
		modelRef: "zai/glm-5-turbo",
		thinking: "xhigh",
	});
});
