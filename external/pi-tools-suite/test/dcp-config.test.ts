import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/dcp/config.js";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-tools-suite-dcp-config-"));
}

describe("DCP config", () => {
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
		expect(config.compress.maxContextPercent).toBe(0.8);
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
