import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "jsonc-parser";

const PIX_SCHEMA_URL = "https://unpkg.com/pi-ui-extend/schemas/pix.json";

const testHome = mkdtempSync(join(tmpdir(), "pix-config-home-"));
const testConfigDir = join(testHome, ".config", "pi");
const testConfigPath = join(testConfigDir, "pix.jsonc");
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
delete process.env.PIX_ICON_THEME;
delete process.env.PIX_USE_FALLBACK_ICONS;

const {
	applyOutputFilters,
	compileOutputFilterPatterns,
	getPixConfigPath,
	getProjectPixConfigPath,
	loadPixConfig,
	resolveDefaultModelRef,
	resolveColor,
	resolveModelColor,
	resolveToolRule,
	savePixAutocompleteModel,
	savePixDefaultModel,
	savePixDefaultThinking,
	saveProjectPixIgnoreContextFiles,
	savePixDictationLanguage,
	upsertPixDefaultModelInJsonc,
	upsertPixDefaultThinkingInJsonc,
	upsertPixAutocompleteModelInJsonc,
	upsertPixDictationLanguageInJsonc,
	upsertPixIgnoreContextFilesInJsonc,
} = await import("../src/config.js");
type ToolRendererConfig = import("../src/config.js").ToolRendererConfig;

describe("config helpers", () => {
	it("resolves the user config path from a supplied home directory", () => {
		assert.equal(getPixConfigPath(testHome), join(testHome, ".config", "pi", "pix.jsonc"));
	});

	it("creates and loads default config when no file exists", () => {
		rmSync(testConfigDir, { recursive: true, force: true });
		const config = loadPixConfig();
		assert.equal(existsSync(testConfigPath), true);
		const created = readFileSync(testConfigPath, "utf8");
		const parsedCreated = parse(created) as { $schema?: string };
		assert.equal(parsedCreated.$schema, PIX_SCHEMA_URL);
		assert.match(created, /^\{\n  "\$schema":/u);
		assert.match(created, /pix renderer configuration/u);
		assert.match(created, /"sessionTitle"/u);
		assert.deepEqual([
			resolveToolRule("ls", config.toolRenderer),
			resolveToolRule("grep", config.toolRenderer),
			resolveToolRule("ast_scan", config.toolRenderer),
			resolveToolRule("apply_patch", config.toolRenderer),
		], [
			{ previewLines: 6, direction: "head", color: "success" },
			{ previewLines: 6, direction: "head", color: "toolSearch" },
			{ previewLines: 0, direction: "head", color: "toolSearch" },
			{ previewLines: 9999, direction: "head", color: "toolMutation", defaultExpanded: true },
		]);
		assert.equal(config.promptEnhancer.modelRef, "zai/glm-5-turbo");
		assert.equal(config.autocomplete.modelRef, "zai/glm-5-turbo");
		assert.equal(config.autocomplete.debounceMs, 350);
		assert.equal(config.autocomplete.timeoutMs, 3000);
		assert.equal(config.autocomplete.maxTokens, 48);
		assert.equal(config.autocomplete.maxPromptTokens, 1200);
		assert.equal(config.autocomplete.includeRecentMessages, 0);
		assert.equal(resolveDefaultModelRef(config), "openai-codex/gpt-5.6-sol:medium");
		assert.equal(config.modelColors.rules["zai/*"], "success");
		assert.equal(config.iconTheme.name, "nerdFont");
		assert.deepEqual(Object.keys(config.dictation.languages), ["en", "ru"]);
		assert.equal(config.dictation.language, "en");
		assert.equal(config.ignoreContextFiles, false);
		assert.equal(config.maxProjectSessions, 0);
		assert.equal(config.dictation.languages.en?.label, "English");
		assert.equal(config.dictation.languages.ru?.label, "Russian");
	});

	it("loads jsonc config from HOME, partial config, and invalid fallback", () => {
		mkdirSync(testConfigDir, { recursive: true });
		writeFileSync(testConfigPath, `{
			// comment
			"toolRenderer": { "default": { "previewLines": 9, "defaultExpanded": true }, "tools": { "x": { "hidden": true }, "y": { "defaultExpanded": false } } },
			"outputFilters": { "samples": ["drop*"] },
			"defaultModel": { "modelRef": "openai-codex/gpt-5.5", "thinking": "medium" },
			"modelColors": { "zai/*": "#22c55e", "antigravity/*": "#f97316", "antigravity/antigravity-claude-*": "#ef4444" },
			"iconTheme": "fallback",
			"promptEnhancer": { "modelRef": "zai/custom-enhancer" },
			"maxProjectSessions": 50,
			"autocomplete": { "modelRef": "zai/custom-autocomplete", "debounceMs": 125, "timeoutMs": 2600, "maxTokens": 64, "maxPromptTokens": 1800, "includeRecentMessages": 9 },
			"dictation": {
				"language": "ru",
				"languages": {
					"en": { "dirName": "vosk-model-small-en-us-0.15", "url": "https://example.test/en.zip", "label": "English" },
					"ru": { "model": "vosk-model-small-ru-0.22", "url": "https://example.test/ru.zip", "label": "Russian" },
					"bad": { "label": "Bad" }
				}
			}
		}`);

		const loaded = loadPixConfig();
		assert.deepEqual(resolveToolRule("x", loaded.toolRenderer), { previewLines: 9, direction: "head", color: "muted", defaultExpanded: true, hidden: true });
		assert.deepEqual(resolveToolRule("y", loaded.toolRenderer), { previewLines: 9, direction: "head", color: "muted", defaultExpanded: false });
		assert.deepEqual(loaded.outputFilters.patterns, ["drop*"]);
		assert.deepEqual(loaded.defaultModel, { modelRef: "openai-codex/gpt-5.5", thinking: "medium" });
		assert.equal(resolveDefaultModelRef(loaded), "openai-codex/gpt-5.5:medium");
		assert.equal(loaded.promptEnhancer.modelRef, "zai/custom-enhancer");
		assert.equal(loaded.autocomplete.modelRef, "zai/custom-autocomplete");
		assert.equal(loaded.autocomplete.debounceMs, 125);
		assert.equal(loaded.autocomplete.timeoutMs, 2600);
		assert.equal(loaded.autocomplete.maxTokens, 64);
		assert.equal(loaded.autocomplete.maxPromptTokens, 1800);
		assert.equal(loaded.autocomplete.includeRecentMessages, 9);
		assert.equal(resolveModelColor("zai/glm-5-turbo", loaded.modelColors), "#22c55e");
		assert.equal(resolveModelColor("antigravity/antigravity-claude-sonnet-4", loaded.modelColors), "#ef4444");
		assert.equal(resolveModelColor("antigravity/gemini-3-pro", loaded.modelColors), "#f97316");
		assert.equal(resolveModelColor("unknown/model", loaded.modelColors), undefined);
		assert.equal(loaded.iconTheme.name, "fallback");
		assert.equal(loaded.dictation.language, "ru");
		assert.equal(loaded.ignoreContextFiles, false);
		assert.equal(loaded.maxProjectSessions, 50);
		assert.deepEqual(Object.keys(loaded.dictation.languages), ["en", "ru"]);
		assert.equal(loaded.dictation.languages.ru?.dirName, "vosk-model-small-ru-0.22");

		writeFileSync(testConfigPath, `{
			"toolRenderer": { "tools": { "empty": {}, "valid": { "direction": "tail" } } },
			"outputFilters": { "patterns": ["x"] }
		}`);
		const partial = loadPixConfig();
		assert.deepEqual(resolveToolRule("valid", partial.toolRenderer), { previewLines: 0, direction: "tail", color: "toolTitle" });
		assert.deepEqual(resolveToolRule("empty", partial.toolRenderer), { previewLines: 0, direction: "head", color: "toolTitle" });
		assert.deepEqual(partial.outputFilters.patterns, ["x"]);
		assert.equal(resolveDefaultModelRef(partial), undefined);
		assert.equal(partial.promptEnhancer.modelRef, "zai/glm-5-turbo");
		assert.equal(partial.autocomplete.modelRef, "zai/glm-5-turbo");
		assert.equal(partial.autocomplete.maxPromptTokens, 1200);
		assert.equal(partial.autocomplete.includeRecentMessages, 0);
		assert.equal(partial.modelColors.rules["zai/*"], "success");
		assert.equal(partial.iconTheme.name, "nerdFont");
		assert.deepEqual(Object.keys(partial.dictation.languages), ["en", "ru"]);
		assert.equal(partial.ignoreContextFiles, false);
		assert.equal(partial.maxProjectSessions, 0);

		writeFileSync(testConfigPath, "{");
		assert.equal(loadPixConfig().toolRenderer.default.previewLines, 0);
		assert.equal(loadPixConfig().promptEnhancer.modelRef, "zai/glm-5-turbo");
		assert.equal(loadPixConfig().autocomplete.modelRef, "zai/glm-5-turbo");
	});

	it("loads project pix config from cwd .pi/pix.jsonc over the user config", () => {
		mkdirSync(testConfigDir, { recursive: true });
		writeFileSync(testConfigPath, `{
			"defaultModel": { "modelRef": "openai-codex/gpt-5.5", "thinking": "medium" },
			"autocomplete": { "modelRef": "zai/global-complete" },
			"maxProjectSessions": 50,
			"ignoreContextFiles": false
		}`);
		const projectDir = mkdtempSync(join(tmpdir(), "pix-project-"));
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		writeFileSync(getProjectPixConfigPath(projectDir), `{
			"ignoreContextFiles": true,
			"autocomplete": { "modelRef": "zai/project-complete" }
		}`);

		const loaded = loadPixConfig(projectDir);

		assert.equal(getProjectPixConfigPath(projectDir), join(projectDir, ".pi", "pix.jsonc"));
		assert.equal(resolveDefaultModelRef(loaded), "openai-codex/gpt-5.5:medium");
		assert.equal(loaded.autocomplete.modelRef, "zai/project-complete");
		assert.equal(loaded.ignoreContextFiles, true);
		assert.equal(loaded.maxProjectSessions, 50);
	});

	it("persists project ignoreContextFiles in JSONC config", () => {
		const projectDir = mkdtempSync(join(tmpdir(), "pix-project-"));
		const projectConfigPath = getProjectPixConfigPath(projectDir);

		assert.equal(saveProjectPixIgnoreContextFiles(projectDir, true), true);
		assert.equal(loadPixConfig(projectDir).ignoreContextFiles, true);
		assert.match(readFileSync(projectConfigPath, "utf8"), /"\$schema"/u);
		assert.match(readFileSync(projectConfigPath, "utf8"), /"ignoreContextFiles": true/u);

		writeFileSync(projectConfigPath, `{
			// keep comments
			"ignoreContextFiles": true
		}`);
		assert.equal(saveProjectPixIgnoreContextFiles(projectDir, false), false);
		const saved = readFileSync(projectConfigPath, "utf8");
		assert.match(saved, /keep comments/u);
		assert.match(saved, /"ignoreContextFiles": false/u);
		assert.match(upsertPixIgnoreContextFilesInJsonc(`{}`, true), /"ignoreContextFiles": true/u);
	});

	it("persists autocomplete model and allows an empty disabled value", () => {
		mkdirSync(testConfigDir, { recursive: true });
		writeFileSync(testConfigPath, `{
			// keep comments
			"autocomplete": { "modelRef": "zai/glm-5-turbo" }
		}`);

		assert.deepEqual(savePixAutocompleteModel("zai/custom-complete"), {
			modelRef: "zai/custom-complete",
			debounceMs: 350,
			timeoutMs: 3000,
			maxTokens: 48,
			maxPromptTokens: 1200,
			includeRecentMessages: 0,
		});
		assert.match(readFileSync(testConfigPath, "utf8"), /keep comments/u);
		assert.equal(loadPixConfig().autocomplete.modelRef, "zai/custom-complete");

		assert.equal(savePixAutocompleteModel("").modelRef, "");
		assert.equal(loadPixConfig().autocomplete.modelRef, "");
		assert.match(upsertPixAutocompleteModelInJsonc(`{}`, "zai/glm-5-turbo"), /"autocomplete"/u);
	});

	it("normalizes default model references with thinking", () => {
		mkdirSync(testConfigDir, { recursive: true });
		writeFileSync(testConfigPath, `{ "defaultModel": { "modelRef": "openai-codex/gpt-5.5:high", "thinking": "medium" } }`);
		assert.equal(resolveDefaultModelRef(loadPixConfig()), "openai-codex/gpt-5.5:medium");

		writeFileSync(testConfigPath, `{ "defaultModel": "zai/glm-5-turbo:low" }`);
		assert.equal(resolveDefaultModelRef(loadPixConfig()), "zai/glm-5-turbo:low");

		writeFileSync(testConfigPath, `{ "defaultModel": { "modelRef": "zai/glm-5-turbo", "thinking": "invalid" } }`);
		const invalidThinkingConfig = loadPixConfig();
		assert.deepEqual(invalidThinkingConfig.defaultModel, { modelRef: "zai/glm-5-turbo" });
		assert.equal(resolveDefaultModelRef(invalidThinkingConfig), "zai/glm-5-turbo");
	});

	it("persists default model and thinking in JSONC config", () => {
		mkdirSync(testConfigDir, { recursive: true });
		writeFileSync(testConfigPath, `{
			// keep comments
			"defaultModel": { "modelRef": "openai-codex/gpt-5.5", "thinking": "medium" }
		}`);

		assert.deepEqual(savePixDefaultModel("zai/glm-5-turbo"), { modelRef: "zai/glm-5-turbo", thinking: "medium" });
		assert.match(readFileSync(testConfigPath, "utf8"), /keep comments/u);
		assert.equal(resolveDefaultModelRef(loadPixConfig()), "zai/glm-5-turbo:medium");

		assert.deepEqual(savePixDefaultModel("openai-codex/gpt-5.5:high"), { modelRef: "openai-codex/gpt-5.5", thinking: "high" });
		assert.equal(resolveDefaultModelRef(loadPixConfig()), "openai-codex/gpt-5.5:high");

		assert.deepEqual(savePixDefaultThinking("low"), { modelRef: "openai-codex/gpt-5.5", thinking: "low" });
		assert.equal(resolveDefaultModelRef(loadPixConfig()), "openai-codex/gpt-5.5:low");

		assert.equal(savePixDefaultThinking("invalid"), undefined);
		assert.equal(resolveDefaultModelRef(loadPixConfig()), "openai-codex/gpt-5.5:low");
	});

	it("upserts default model settings from empty or string config", () => {
		assert.match(upsertPixDefaultModelInJsonc(`{}`, "zai/glm-5-turbo:low"), /"defaultModel"/u);
		const replaced = upsertPixDefaultThinkingInJsonc(`{ "defaultModel": "zai/glm-5-turbo" }`, "high");
		assert.match(replaced, /"modelRef": "zai\/glm-5-turbo"/u);
		assert.match(replaced, /"thinking": "high"/u);

		const inserted = upsertPixDefaultThinkingInJsonc(`{}`, "medium", "openai-codex/gpt-5.5:low");
		assert.match(inserted, /"modelRef": "openai-codex\/gpt-5.5"/u);
		assert.match(inserted, /"thinking": "medium"/u);

		assert.equal(upsertPixDefaultThinkingInJsonc(`{}`, "invalid", "openai-codex/gpt-5.5:low"), `{}`);
	});

	it("persists selected dictation language in JSONC config", () => {
		mkdirSync(testConfigDir, { recursive: true });
		writeFileSync(testConfigPath, `{
			// keep comments
			"dictation": {
				"languages": {
					"en": { "dirName": "en-model", "url": "https://example.test/en.zip", "label": "English" },
					"ru": { "dirName": "ru-model", "url": "https://example.test/ru.zip", "label": "Russian" }
				}
			}
		}`);

		savePixDictationLanguage("ru");
		const saved = readFileSync(testConfigPath, "utf8");
		assert.match(saved, /"language": "ru"/u);
		assert.match(saved, /keep comments/u);
		assert.equal(loadPixConfig().dictation.language, "ru");

		savePixDictationLanguage("en");
		assert.equal(loadPixConfig().dictation.language, "en");
	});

	it("upserts selected dictation language without disturbing commented languages", () => {
		const source = `{
			"dictation": {
				"languages": {
					"en": { "dirName": "en-model", "url": "https://example.test/en.zip" }
					// ,"ru": { "dirName": "ru-model", "url": "https://example.test/ru.zip" }
				}
			}
		}`;

		const updated = upsertPixDictationLanguageInJsonc(source, "ru");
		assert.match(updated, /"language": "ru"/u);
		assert.match(updated, /\/\/ ,"ru"/u);
	});

	it("lets env force fallback icon theme", () => {
		mkdirSync(testConfigDir, { recursive: true });
		writeFileSync(testConfigPath, `{ "iconTheme": "nerdFont" }`);
		process.env.PIX_USE_FALLBACK_ICONS = "1";
		try {
			assert.equal(loadPixConfig().iconTheme.name, "fallback");
		} finally {
			delete process.env.PIX_USE_FALLBACK_ICONS;
		}
	});

	it("compiles glob and regex output filters and removes empty filtered lines", () => {
		const filters = compileOutputFilterPatterns(["secret-*", "/token=\\w+/", "   "]);
		assert.equal(applyOutputFilters("keep\nsecret-value\na token=abc z\n", filters), "keep\na  z\n");
	});

	it("ignores invalid filter patterns", () => {
		const filters = compileOutputFilterPatterns(["/<dcp-id>m\\d+<\\/dcp-id>/", "/[/"]);
		assert.equal(applyOutputFilters("x", []), "x");
		assert.equal(applyOutputFilters("", filters), "");
	});

	it("resolves exact, wildcard, default, hidden, and color rules", () => {
		const config: ToolRendererConfig = {
			default: { previewLines: 2, direction: "head", color: "muted", defaultExpanded: true, hidden: true },
			tools: {
				read: { previewLines: 0, color: "success", defaultExpanded: false, hidden: false },
				"repo_*": { direction: "tail", compactHidden: true },
				"repo_search_*": { previewLines: 8, color: "warning" },
			},
		};

		assert.deepEqual(resolveToolRule("read", config), { previewLines: 0, direction: "head", color: "success", defaultExpanded: false, hidden: false });
		assert.deepEqual(resolveToolRule("repo_search_impl", config), { previewLines: 8, direction: "head", color: "warning", defaultExpanded: true, hidden: true });
		assert.deepEqual(resolveToolRule("repo_deps", config), { previewLines: 2, direction: "tail", color: "muted", defaultExpanded: true, compactHidden: true, hidden: true });
		assert.deepEqual(resolveToolRule("other", config), { previewLines: 2, direction: "head", color: "muted", defaultExpanded: true, hidden: true });

		assert.equal(resolveColor("accent", { accent: "#fff", muted: "#000" }), "#fff");
		assert.equal(resolveColor("#123456", { muted: "#000" }), "#123456");
		assert.equal(resolveColor("missing", { muted: "#000" }), "#000");
		assert.equal(resolveColor("missing", {}), "missing");
	});
});
