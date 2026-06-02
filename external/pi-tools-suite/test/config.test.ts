import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { getPiToolsSuiteUserConfigPath, loadPiToolsSuiteConfig } from "../src/config.js";
import { DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC } from "../src/default-pi-tools-suite-config.js";

const MODULES = ["terminal-bell", "usage", "dcp", "prompt-commands"];

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
				"disabledModules": ["terminal-bell"],
				"modules": { "usage": false, "prompt-commands": true }
			}`,
		);

		const config = loadPiToolsSuiteConfig(MODULES, { cwd, homeDir, env: {} });

		expect(config.enabled).toBe(true);
		expect(config.disabledModules).toEqual(["terminal-bell", "usage"]);
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
			env: { PI_TOOLS_SUITE_DISABLED_MODULES: "terminal-bell, dcp" },
		});

		expect(config.disabledModules).toEqual(["dcp", "terminal-bell"]);
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
		expect(content).toContain('"disabledModules"');
		expect(content).toContain('// "terminal-bell",');
		expect(content).toContain('// "dcp"');
		expect(content).toContain('"asyncSubagents"');
		expect(content).toContain('"promptCommands"');
	});

	test("unknown removed modules are ignored", () => {
		const homeDir = tempDir();
		const cwd = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		writeFileSync(join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"), `{ "disabledModules": ["compress"] }`);

		const config = loadPiToolsSuiteConfig(MODULES, { cwd, homeDir, env: {} });

		expect(config.disabledModules).toEqual([]);
	});

});
