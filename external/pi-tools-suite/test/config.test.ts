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

	test("uses HOME for the default user config path even when the runtime homedir is cached", () => {
		const originalHome = process.env.HOME;
		const homeDir = tempDir();
		try {
			process.env.HOME = homeDir;
			expect(getPiToolsSuiteUserConfigPath()).toBe(join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"));
		} finally {
			if (originalHome === undefined) delete process.env.HOME;
			else process.env.HOME = originalHome;
		}
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
		expect(config.todoThinkingOverrides).toEqual({ "zai/glm-5.3": "max" });
	});

	test("loads lookupModel from config layers and allows disabling it", () => {
		const homeDir = tempDir();
		const cwd = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"), `{ "lookupModel": "openai-codex/gpt-5.4-mini", "lookupFallbackModels": ["zai/glm-5.3-flash"] }`);

		const configured = loadPiToolsSuiteConfig(MODULES, { cwd, homeDir, env: {} });
		expect(configured.lookupModel).toBe("openai-codex/gpt-5.4-mini");
		expect(configured.lookupFallbackModels).toEqual(["zai/glm-5.3-flash"]);

		writeFileSync(join(cwd, ".pi", "pi-tools-suite.jsonc"), `{ "lookupModel": null }`);

		expect(loadPiToolsSuiteConfig(MODULES, { cwd, homeDir, env: {} }).lookupModel).toBeUndefined();
	});

	test("loads resource registry remote/branch/projectKey from layered config and environment", () => {
		const homeDir = tempDir();
		const cwd = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"),
			`{ "resourceRegistry": { "remote": "git@example.com:user/resources.git", "branch": "main" } }`,
		);
		writeFileSync(join(cwd, ".pi", "pi-tools-suite.jsonc"), `{ "resourceRegistry": { "branch": "work", "projectKey": "project-one" } }`);

			expect(loadPiToolsSuiteConfig(MODULES, { cwd, homeDir, env: {} }).resourceRegistry).toEqual({
			remote: "git@example.com:user/resources.git",
			branch: "work",
			projectKey: "project-one",
		});
		expect(loadPiToolsSuiteConfig(MODULES, {
			cwd,
			homeDir,
			env: {
				PI_RESOURCE_REGISTRY_REMOTE: "/tmp/registry.git",
				PI_RESOURCE_REGISTRY_BRANCH: "main",
				PI_RESOURCE_REGISTRY_PROJECT_KEY: "env-project",
			},
		}).resourceRegistry).toEqual({ remote: "/tmp/registry.git", branch: "main", projectKey: "env-project" });
	});

	test("loads todoThinking from config and environment", () => {
		const homeDir = tempDir();
		const cwd = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		writeFileSync(join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"), `{ "todoThinking": true }`);

		expect(loadPiToolsSuiteConfig(MODULES, { cwd, homeDir, env: {} }).todoThinking).toBe(true);
		expect(loadPiToolsSuiteConfig(MODULES, { cwd, homeDir, env: { PI_TOOLS_SUITE_TODO_THINKING: "0" } }).todoThinking).toBe(false);
	});

	test("merges todo thinking model overrides and allows later layers to remove inherited entries", () => {
		const homeDir = tempDir();
		const cwd = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"),
			`{ "todoThinkingOverrides": { "cheap/*": "high", "zai/glm-5.3": "low", "bad/*": "turbo" } }`,
		);
		writeFileSync(
			join(cwd, ".pi", "pi-tools-suite.jsonc"),
			`{ "todoThinkingOverrides": { "cheap/small": "max", "zai/glm-5.3": null } }`,
		);

		const config = loadPiToolsSuiteConfig(MODULES, { cwd, homeDir, env: {} });

		expect(config.todoThinkingOverrides).toEqual({ "cheap/*": "high", "cheap/small": "max" });
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
		expect(content).toContain('"todoThinkingOverrides"');
		expect(content).toContain('"zai/glm-5.3": "max"');
		expect(content).toContain('"lookupModel": "zai/glm-5.3-flash"');
		expect(content).toContain('"lookupFallbackModels": []');
		expect(content).toContain('"summarizerModel": ["zai/glm-5-turbo"]');
		expect(content).toContain('"summarizerFallbackModels": ["openai-codex/gpt-5.6-luna"]');
		expect(content).toContain('"credential-firewall": false');
		expect(content).toContain('"truncation-metadata-normalizer": false');
		expect(content).toContain('"secretFirewall"');
		expect(content).toContain('"contextGateway"');
		expect(content).toContain('"repoDiscovery"');
		expect(content).toContain('"profile": "baseline"');
		expect(content).toContain('"resourceRegistry"');
		expect(content).toContain('"branch": "main"');
		expect(content).toContain('// "ast-grep",');
		expect(content).toContain('// "dcp"');
		expect(content).not.toContain('"asyncSubagents"');
		expect(content).toContain('"promptCommands"');
		const parsed = parse(content) as {
			$schema?: string;
			lsp?: { servers?: Array<{ id?: string }> };
			repoDiscovery?: { profile?: string };
			resourceRegistry?: { remote?: string; branch?: string; projectKey?: string };
		};
		expect(parsed.$schema).toBe(PI_TOOLS_SUITE_SCHEMA_URL);
		expect(parsed.lsp?.servers?.map((server) => server.id)).toEqual(["typescript"]);
		expect(parsed.repoDiscovery?.profile).toBe("baseline");
		expect(parsed.resourceRegistry).toEqual({ branch: "main" });
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

	test("credential firewall is disabled by default and requires explicit opt-in", () => {
		const homeDir = tempDir();
		const cwd = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });

		let config = loadPiToolsSuiteConfig(["credential-firewall", "usage"], { cwd, homeDir, env: {} });
		expect(config.disabledModules).toEqual(["credential-firewall"]);

		writeFileSync(
			join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"),
			`{ "modules": { "credential-firewall": true } }`,
		);
		config = loadPiToolsSuiteConfig(["credential-firewall", "usage"], { cwd, homeDir, env: {} });
		expect(config.disabledModules).toEqual([]);
	});

	test("truncation metadata normalizer is disabled by default and requires explicit opt-in", () => {
		const homeDir = tempDir();
		const cwd = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });

		let config = loadPiToolsSuiteConfig(["truncation-metadata-normalizer", "usage"], { cwd, homeDir, env: {} });
		expect(config.disabledModules).toEqual(["truncation-metadata-normalizer"]);

		writeFileSync(
			join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"),
			`{ "modules": { "truncation-metadata-normalizer": true } }`,
		);
		config = loadPiToolsSuiteConfig(["truncation-metadata-normalizer", "usage"], { cwd, homeDir, env: {} });
		expect(config.disabledModules).toEqual([]);
	});

});
