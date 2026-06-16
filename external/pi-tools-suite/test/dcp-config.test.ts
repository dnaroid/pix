import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { loadConfig, modelKeysFromContext, resolveModelConfig } from "../src/dcp/config.js";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-tools-suite-dcp-config-"));
}

describe("DCP config", () => {
	test("uses context-pressure DCP cleanup defaults", () => {
		const homeDir = tempDir();
		const config = loadConfig({ homeDir });

		expect(config.compress.minContextPercent).toBe(0.40);
		expect(config.compress.maxContextPercent).toBe(0.65);
		expect(config.compress.nudgeFrequency).toBe(2);
		expect(config.compress.iterationNudgeThreshold).toBe(8);
		expect(config.compress.autoCandidates.minContextPercent).toBe(0.40);
		expect(config.compress.autoCandidates.keepRecentTurns).toBe(1);
		expect(config.compress.messageMode.minContextPercent).toBe(0.40);
		expect(config.compress.messageMode.keepRecentTurns).toBe(1);
		expect(config.strategies.autoToolPruning.maxOutputTokens).toBe(1200);
		expect(config.strategies.autoToolPruning.keepRecentTurns).toBe(1);
		expect(config.strategies.autoToolPruning.readLikeTools).toEqual(
			expect.arrayContaining(["read", "shell", "bash", "repo_search", "web_search", "web_fetch"]),
		);
	});

	test("reads DCP settings from the user pi-tools-suite config", () => {
		const homeDir = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		writeFileSync(
			join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"),
			`{
				"dcp": {
					"enabled": false,
					"manualMode": { "enabled": true },
					"compress": { "minContextPercent": 0.25, "nudgeFrequency": 1 }
				}
			}`,
		);

		const config = loadConfig({ homeDir });

		expect(config.enabled).toBe(false);
		expect(config.manualMode.enabled).toBe(true);
		expect(config.manualMode.automaticStrategies).toBe(true);
		expect(config.compress.minContextPercent).toBe(0.25);
		expect(config.compress.nudgeFrequency).toBe(1);
		expect(config.compress.maxContextPercent).toBe(0.65);
	});

	test("applies model-specific overrides on top of the shared DCP config", () => {
		const homeDir = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		writeFileSync(
			join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"),
			`{
				"dcp": {
					"compress": { "nudgeFrequency": 1, "protectedTools": ["compress"] },
					"modelOverrides": {
						"openai/gpt-5": {
							"compress": { "nudgeFrequency": 3, "protectedTools": ["read"] },
							"strategies": { "autoToolPruning": { "enabled": false } }
						}
					}
				}
			}`,
		);

		const config = loadConfig({ homeDir });
		const resolved = resolveModelConfig(config, ["openai/gpt-5", "gpt-5"]);

		expect(resolved.compress.nudgeFrequency).toBe(3);
		expect(resolved.compress.protectedTools).toEqual(["compress", "write", "edit", "read"]);
		expect(resolved.strategies.autoToolPruning.enabled).toBe(false);
		expect(config.compress.nudgeFrequency).toBe(1);
	});

	test("supports wildcard model override keys with exact matches taking precedence", () => {
		const homeDir = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		writeFileSync(
			join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"),
			`{
				"dcp": {
					"compress": { "nudgeFrequency": 1, "protectedTools": ["compress"] },
					"modelOverrides": {
						"gpt-*": {
							"compress": { "nudgeFrequency": 2, "protectedTools": ["read"] }
						},
						"openai/*": {
							"compress": { "nudgeFrequency": 3, "protectedTools": ["grep"] }
						},
						"openai/gpt-5": {
							"compress": { "nudgeFrequency": 4, "protectedTools": ["find"] }
						}
					}
				}
			}`,
		);

		const config = loadConfig({ homeDir });
		const resolved = resolveModelConfig(config, ["openai/gpt-5", "gpt-5"]);

		expect(resolved.compress.nudgeFrequency).toBe(4);
		expect(resolved.compress.protectedTools).toEqual([
			"compress",
			"write",
			"edit",
			"read",
			"grep",
			"find",
		]);
	});

	test("extracts provider/model and model-only keys from context", () => {
		expect(modelKeysFromContext({ model: { provider: "openai", id: "gpt-5" } })).toEqual([
			"openai/gpt-5",
			"gpt-5",
		]);
	});

	test("ignores legacy, project, and PI_CONFIG_DIR DCP config files", () => {
		const homeDir = tempDir();
		const piConfigDir = tempDir();
		const projectDir = tempDir();
		mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
		mkdirSync(join(piConfigDir), { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });

		writeFileSync(join(homeDir, ".config", "pi", "dcp.jsonc"), `{ "enabled": false }`);
		writeFileSync(join(piConfigDir, "pi-tools-suite.jsonc"), `{ "dcp": { "enabled": false } }`);
		writeFileSync(join(piConfigDir, "dcp.jsonc"), `{ "enabled": false }`);
		writeFileSync(join(projectDir, ".pi", "pi-tools-suite.jsonc"), `{ "dcp": { "enabled": false } }`);
		writeFileSync(join(projectDir, ".pi", "dcp.jsonc"), `{ "enabled": false }`);

		const previousPiConfigDir = process.env.PI_CONFIG_DIR;
		process.env.PI_CONFIG_DIR = piConfigDir;
		try {
			const config = loadConfig({ homeDir });
			expect(config.enabled).toBe(true);
		} finally {
			if (previousPiConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previousPiConfigDir;
		}
	});
});
