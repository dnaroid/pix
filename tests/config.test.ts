import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const testHome = mkdtempSync(join(tmpdir(), "pix-config-home-"));
const testConfigDir = join(testHome, ".config", "pi");
const testConfigPath = join(testConfigDir, "pix.jsonc");
process.env.HOME = testHome;
delete process.env.PIX_ICON_THEME;
delete process.env.PIX_USE_FALLBACK_ICONS;

const {
	applyOutputFilters,
	compileOutputFilterPatterns,
	stripDcpDisplayMetadata,
	loadPixConfig,
	outputFiltersRemoveDcpIdMetadataLine,
	resolveColor,
	resolveModelColor,
	resolveToolRule,
	savePixDictationLanguage,
	suppressPendingDcpIdMetadataLine,
	upsertPixDictationLanguageInJsonc,
} = await import("../src/config.js");
type ToolRendererConfig = import("../src/config.js").ToolRendererConfig;

describe("config helpers", () => {
	it("loads default config when no file exists", () => {
		rmSync(testConfigDir, { recursive: true, force: true });
		const config = loadPixConfig();
		assert.deepEqual([
			resolveToolRule("ls", config.toolRenderer),
			resolveToolRule("grep", config.toolRenderer),
			resolveToolRule("ast_scan", config.toolRenderer),
			resolveToolRule("apply_patch", config.toolRenderer),
		], [
			{ previewLines: 3, direction: "head", color: "success" },
			{ previewLines: 3, direction: "head", color: "toolSearch" },
			{ previewLines: 3, direction: "head", color: "toolSearch" },
			{ previewLines: 1, direction: "head", color: "toolMutation", defaultExpanded: true, compactHidden: true },
		]);
		assert.equal(config.promptEnhancer.modelRef, "zai/gpt-5-turbo");
		assert.deepEqual(config.modelColors.rules, {});
		assert.equal(config.iconTheme.name, "nerdFont");
		assert.deepEqual(Object.keys(config.dictation.languages), ["en"]);
		assert.equal(config.dictation.language, "en");
		assert.equal(config.dictation.languages.en?.label, "English");
	});

	it("loads jsonc config from HOME, partial config, and invalid fallback", () => {
		mkdirSync(testConfigDir, { recursive: true });
		writeFileSync(testConfigPath, `{
			// comment
			"toolRenderer": { "default": { "previewLines": 9, "defaultExpanded": true }, "tools": { "x": { "hidden": true }, "y": { "defaultExpanded": false } } },
			"outputFilters": { "samples": ["drop*"] },
			"modelColors": { "zai/*": "#22c55e", "antigravity/*": "#f97316", "antigravity/antigravity-claude-*": "#ef4444" },
			"iconTheme": "fallback",
			"promptEnhancer": { "modelRef": "zai/custom-enhancer" },
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
		assert.equal(loaded.promptEnhancer.modelRef, "zai/custom-enhancer");
		assert.equal(resolveModelColor("zai/glm-5-turbo", loaded.modelColors), "#22c55e");
		assert.equal(resolveModelColor("antigravity/antigravity-claude-sonnet-4", loaded.modelColors), "#ef4444");
		assert.equal(resolveModelColor("antigravity/gemini-3-pro", loaded.modelColors), "#f97316");
		assert.equal(resolveModelColor("unknown/model", loaded.modelColors), undefined);
		assert.equal(loaded.iconTheme.name, "fallback");
		assert.equal(loaded.dictation.language, "ru");
		assert.deepEqual(Object.keys(loaded.dictation.languages), ["en", "ru"]);
		assert.equal(loaded.dictation.languages.ru?.dirName, "vosk-model-small-ru-0.22");

		writeFileSync(testConfigPath, `{
			"toolRenderer": { "tools": { "empty": {}, "valid": { "direction": "tail" } } },
			"outputFilters": { "patterns": ["x"] }
		}`);
		const partial = loadPixConfig();
		assert.deepEqual(resolveToolRule("valid", partial.toolRenderer), { previewLines: 3, direction: "tail", color: "muted" });
		assert.deepEqual(resolveToolRule("empty", partial.toolRenderer), { previewLines: 3, direction: "head", color: "muted" });
		assert.deepEqual(partial.outputFilters.patterns, ["x"]);
		assert.equal(partial.promptEnhancer.modelRef, "zai/gpt-5-turbo");
		assert.deepEqual(partial.modelColors.rules, {});
		assert.equal(partial.iconTheme.name, "nerdFont");
		assert.deepEqual(Object.keys(partial.dictation.languages), ["en"]);

		writeFileSync(testConfigPath, "{");
		assert.equal(loadPixConfig().toolRenderer.default.previewLines, 3);
		assert.equal(loadPixConfig().promptEnhancer.modelRef, "zai/gpt-5-turbo");
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

	it("ignores invalid filter patterns and detects dcp id line removal", () => {
		const filters = compileOutputFilterPatterns(["/<dcp-id>m\\d+<\\/dcp-id>/", "/[/"]);
		assert.equal(outputFiltersRemoveDcpIdMetadataLine(filters), true);
		assert.equal(applyOutputFilters("x", []), "x");
		assert.equal(applyOutputFilters("", filters), "");
	});

	it("suppresses only partially streamed dcp metadata lines", () => {
		assert.equal(suppressPendingDcpIdMetadataLine("hello\n<dcp-id>m0"), "hello");
		assert.equal(suppressPendingDcpIdMetadataLine("<dcp-id>m001</dcp-id>"), "<dcp-id>m001</dcp-id>");
		assert.equal(suppressPendingDcpIdMetadataLine("hello\nnot metadata"), "hello\nnot metadata");
		assert.equal(suppressPendingDcpIdMetadataLine(""), "");
	});

	it("strips DCP display metadata without requiring user output filters", () => {
		assert.equal(stripDcpDisplayMetadata("answer\n[dcp-id]: # (m064)"), "answer");
		assert.equal(stripDcpDisplayMetadata("answer\n[dcp-block-id]: # (b4)"), "answer");
		assert.equal(stripDcpDisplayMetadata("answer\n<dcp-id>m064</dcp-id>"), "answer");
		assert.equal(stripDcpDisplayMetadata("answer\n<dcp-id>m064"), "answer");
		assert.equal(stripDcpDisplayMetadata("answer\n[dcp-id]: # (m064"), "answer");
	});

	it("removes whole DCP metadata lines without leaving blank gaps", () => {
		assert.equal(stripDcpDisplayMetadata("before\n[dcp-id]: # (m064)\nafter"), "before\nafter");
		assert.equal(stripDcpDisplayMetadata("[dcp-id]: # (m064)\nafter"), "after");
		assert.equal(stripDcpDisplayMetadata("before\n  [dcp-id]: # (m064)\nafter"), "before\nafter");
		assert.equal(stripDcpDisplayMetadata("before\n<dcp-id>m064</dcp-id>\nafter"), "before\nafter");
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
