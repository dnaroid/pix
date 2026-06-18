import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parse } from "jsonc-parser";

import { getPiToolsSuiteUserConfigPath, loadPiToolsSuiteConfig } from "../src/config.js";
import { DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC } from "../src/default-pi-tools-suite-config.js";

const MODULES = ["ast-grep", "usage", "dcp", "prompt-commands"];
const PI_TOOLS_SUITE_SCHEMA_URL = "https://unpkg.com/pi-ui-extend/schemas/pi-tools-suite.json";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-tools-suite-config-"));
}

describe("pi-tools-suite config", () => {
	test("resolves the user config path from a supplied home directory", () => {
		const homeDir = tempDir();
		expect(getPiToolsSuiteUserConfigPath(homeDir)).toBe(join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"));
	});

	test("disables modules from config lists and maps", () => {
		const homeDir = tempDir();
		const cwd = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		writeFileSync(
			join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"),
			`{
				// array and map syntaxes are both accepted
				"disabledModules": ["ast-grep"],
				"modules": { "usage": false, "prompt-commands": true }
			}`,
		);

		const config = loadPiToolsSuiteConfig(MODULES, { cwd, homeDir, env: {} });

		expect(config.enabled).toBe(true);
		expect(config.disabledModules).toEqual(["ast-grep", "usage"]);
		expect(config.todoThinking).toBe(false);
	});

	test("loads lookupModel from config layers and allows disabling it", () => {
		const homeDir = tempDir();
		const cwd = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"), `{ "lookupModel": "openai-codex/gpt-5.4-mini" }`);

		expect(loadPiToolsSuiteConfig(MODULES, { cwd, homeDir, env: {} }).lookupModel).toBe("openai-codex/gpt-5.4-mini");

		writeFileSync(join(cwd, ".pi", "pi-tools-suite.jsonc"), `{ "lookupModel": null }`);

		expect(loadPiToolsSuiteConfig(MODULES, { cwd, homeDir, env: {} }).lookupModel).toBeUndefined();
	});

	test("loads todoThinking from config and environment", () => {
		const homeDir = tempDir();
		const cwd = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		writeFileSync(join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"), `{ "todoThinking": true }`);

		expect(loadPiToolsSuiteConfig(MODULES, { cwd, homeDir, env: {} }).todoThinking).toBe(true);
		expect(loadPiToolsSuiteConfig(MODULES, { cwd, homeDir, env: { PI_TOOLS_SUITE_TODO_THINKING: "0" } }).todoThinking).toBe(false);
	});

	test("project config can re-enable a globally disabled module", () => {
		const homeDir = tempDir();
		const cwd = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"), `{ "disabledModules": ["dcp"] }`);
		writeFileSync(join(cwd, ".pi", "pi-tools-suite.jsonc"), `{ "enabledModules": ["dcp"] }`);

		const config = loadPiToolsSuiteConfig(MODULES, { cwd, homeDir, env: {} });

		expect(config.disabledModules).toEqual([]);
	});

	test("environment variables disable modules last", () => {
		const config = loadPiToolsSuiteConfig(MODULES, {
			cwd: tempDir(),
			homeDir: tempDir(),
			env: { PI_TOOLS_SUITE_DISABLED_MODULES: "ast-grep, dcp" },
		});

		expect(config.disabledModules).toEqual(["ast-grep", "dcp"]);
	});

	test("environment variable can disable the whole suite", () => {
		const config = loadPiToolsSuiteConfig(MODULES, {
			cwd: tempDir(),
			homeDir: tempDir(),
			env: { PI_TOOLS_SUITE_DISABLED: "1" },
		});

		expect(config.enabled).toBe(false);
	});

	test("creates a default user config when it is missing", () => {
		const homeDir = tempDir();
		const configPath = join(homeDir, ".config", "pi", "pi-tools-suite.jsonc");

		loadPiToolsSuiteConfig(MODULES, { cwd: tempDir(), homeDir, env: {} });

		expect(existsSync(configPath)).toBe(true);
		const content = readFileSync(configPath, "utf8");
		expect(content).toBe(DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC);
		expect(content.startsWith(`{\n  "$schema": "${PI_TOOLS_SUITE_SCHEMA_URL}",`)).toBe(true);
		expect(content).toContain('"disabledModules"');
		expect(content).toContain('"todoThinking": true');
		expect(content).toContain('"lookupModel": "openai-codex/gpt-5.4-mini"');
		expect(content).toContain('// "ast-grep",');
		expect(content).toContain('// "dcp"');
		expect(content).toContain('"asyncSubagents"');
		expect(content).toContain('"promptCommands"');
		const parsed = parse(content) as { $schema?: string; lsp?: { servers?: Array<{ id?: string }> } };
		expect(parsed.$schema).toBe(PI_TOOLS_SUITE_SCHEMA_URL);
		expect(parsed.lsp?.servers?.map((server) => server.id)).toEqual(["typescript"]);
		expect(content).toContain('//   "id": "python"');
		expect(content).toContain('//   "id": "markdown"');
	});

	test("unknown removed modules are ignored", () => {
		const homeDir = tempDir();
		const cwd = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		writeFileSync(join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"), `{ "disabledModules": ["compress"] }`);

		const config = loadPiToolsSuiteConfig(MODULES, { cwd, homeDir, env: {} });

		expect(config.disabledModules).toEqual([]);
	});

	test("legacy glm-coding-discipline disabledModules alias maps to coding-discipline", () => {
		const homeDir = tempDir();
		const cwd = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		writeFileSync(join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"), `{ "disabledModules": ["glm-coding-discipline"] }`);

		const config = loadPiToolsSuiteConfig(["coding-discipline"], { cwd, homeDir, env: {} });

		expect(config.disabledModules).toEqual(["coding-discipline"]);
	});

});
