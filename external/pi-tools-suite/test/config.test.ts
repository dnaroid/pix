import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { loadPiToolsSuiteConfig } from "../src/config.js";

const MODULES = ["terminal-bell", "usage", "compress"];

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-tools-suite-config-"));
}

describe("pi-tools-suite config", () => {
	test("disables modules from config lists and maps", () => {
		const homeDir = tempDir();
		const cwd = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		writeFileSync(
			join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"),
			`{
				// array and map syntaxes are both accepted
				"disabledModules": ["terminal-bell"],
				"modules": { "usage": false, "compress": true }
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
		writeFileSync(join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"), `{ "disabledModules": ["compress"] }`);
		writeFileSync(join(cwd, ".pi", "pi-tools-suite.jsonc"), `{ "enabledModules": ["compress"] }`);

		const config = loadPiToolsSuiteConfig(MODULES, { cwd, homeDir, env: {} });

		expect(config.disabledModules).toEqual([]);
	});

	test("environment variables disable modules last", () => {
		const config = loadPiToolsSuiteConfig(MODULES, {
			cwd: tempDir(),
			homeDir: tempDir(),
			env: { PI_TOOLS_SUITE_DISABLED_MODULES: "terminal-bell, compress" },
		});

		expect(config.disabledModules).toEqual(["compress", "terminal-bell"]);
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
		expect(content).toContain('"disabledModules"');
		expect(content).toContain('// "terminal-bell",');
		expect(content).not.toContain('"modules"');
		expect(content).not.toContain('"extensions"');
	});

});
