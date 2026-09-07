import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { DEFAULT_CONTEXT_GATEWAY_BUDGETS, loadContextGatewayConfig } from "../../src/context-gateway/config.js";

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

describe("context gateway P01 config", () => {
	test("defaults to off with the experimental budgets", () => {
		const root = tempDir("context-gateway-config-default-");
		const config = loadContextGatewayConfig(root, {}, join(root, "home"));

		expect(config).toEqual({
			mode: "off",
			budgets: DEFAULT_CONTEXT_GATEWAY_BUDGETS,
			issues: [],
		});
	});

	test("layers user, PI_CONFIG_DIR, project, and env without writing config", () => {
		const root = tempDir("context-gateway-config-layer-");
		const home = join(root, "home");
		const piConfig = join(root, "pi-config");
		const project = join(root, "project", "child");
		mkdirSync(join(home, ".config", "pi"), { recursive: true });
		mkdirSync(piConfig, { recursive: true });
		mkdirSync(join(root, "project", ".pi"), { recursive: true });
		mkdirSync(project, { recursive: true });
		writeFileSync(join(home, ".config", "pi", "pi-tools-suite.jsonc"), `{
			"contextGateway": { "mode": "observe", "budgets": { "maxResultBytes": 9000 } }
		}`);
		writeFileSync(join(piConfig, "pi-tools-suite.jsonc"), `{
			"contextGateway": { "budgets": { "maxInlineBytes": 7000 } }
		}`);
		writeFileSync(join(root, "project", ".pi", "pi-tools-suite.jsonc"), `{
			"contextGateway": { "budgets": { "maxSearchMatches": 7 } }
		}`);

		const config = loadContextGatewayConfig(project, {
			HOME: home,
			PI_CONFIG_DIR: piConfig,
			PI_CONTEXT_GATEWAY_MODE: "off",
		}, home);

		expect(config.mode).toBe("off");
		expect(config.budgets).toMatchObject({ maxResultBytes: 9000, maxInlineBytes: 7000, maxSearchMatches: 7 });
		expect(config.issues).toEqual([]);
	});

	test("keeps previous safe values and records issues for invalid settings", () => {
		const root = tempDir("context-gateway-config-invalid-");
		const home = join(root, "home");
		mkdirSync(join(home, ".config", "pi"), { recursive: true });
		writeFileSync(join(home, ".config", "pi", "pi-tools-suite.jsonc"), `{
			"contextGateway": {
				"mode": "magic",
				"budgets": { "maxResultBytes": 0, "maxSearchMatches": 1001 }
			}
		}`);

		const config = loadContextGatewayConfig(root, { HOME: home, PI_CONTEXT_GATEWAY_MODE: "invalid" }, home);

		expect(config.mode).toBe("off");
		expect(config.budgets.maxResultBytes).toBe(DEFAULT_CONTEXT_GATEWAY_BUDGETS.maxResultBytes);
		expect(config.budgets.maxSearchMatches).toBe(DEFAULT_CONTEXT_GATEWAY_BUDGETS.maxSearchMatches);
		expect(config.issues).toHaveLength(4);
		expect(config.issues.join("\n")).toContain("contextGateway.mode");
		expect(config.issues.join("\n")).toContain("PI_CONTEXT_GATEWAY_MODE");
	});
});
