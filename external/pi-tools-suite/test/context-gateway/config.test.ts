import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
	DEFAULT_CONTEXT_GATEWAY_ACCOUNTING_LOG,
	contextGatewayBudgetForClass,
	DEFAULT_CONTEXT_GATEWAY_BUDGETS,
	loadContextGatewayConfig,
} from "../../src/context-gateway/config.js";

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
			accountingLog: DEFAULT_CONTEXT_GATEWAY_ACCOUNTING_LOG,
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
			"contextGateway": { "mode": "observe", "budgets": { "maxResultBytes": 9000 }, "accountingLog": { "maxBytes": 12345 } }
		}`);
		writeFileSync(join(piConfig, "pi-tools-suite.jsonc"), `{
			"contextGateway": { "budgets": { "maxInlineBytes": 7000 }, "accountingLog": { "maxBackups": 5 } }
		}`);
		writeFileSync(join(root, "project", ".pi", "pi-tools-suite.jsonc"), `{
			"contextGateway": { "budgets": { "maxSearchMatches": 7 }, "accountingLog": { "enabled": false } }
		}`);

		const config = loadContextGatewayConfig(project, {
			HOME: home,
			PI_CONFIG_DIR: piConfig,
			PI_CONTEXT_GATEWAY_MODE: "off",
			PI_CONTEXT_GATEWAY_ACCOUNTING_LOG_ENABLED: "true",
			PI_CONTEXT_GATEWAY_ACCOUNTING_MAX_BYTES: "23456",
			PI_CONTEXT_GATEWAY_ACCOUNTING_MAX_BACKUPS: "7",
		}, home);

		expect(config.mode).toBe("off");
		expect(config.budgets).toMatchObject({ maxResultBytes: 9000, maxInlineBytes: 7000, maxSearchMatches: 7 });
		expect(config.accountingLog).toEqual({ enabled: true, maxBytes: 23456, maxBackups: 7 });
		expect(config.issues).toEqual([]);
	});

	test("keeps previous safe values and records issues for invalid settings", () => {
		const root = tempDir("context-gateway-config-invalid-");
		const home = join(root, "home");
		mkdirSync(join(home, ".config", "pi"), { recursive: true });
		writeFileSync(join(home, ".config", "pi", "pi-tools-suite.jsonc"), `{
			"contextGateway": {
				"mode": "magic",
				"budgets": { "maxResultBytes": 0, "maxSearchMatches": 1001 },
				"accountingLog": { "enabled": "yes", "maxBytes": 0, "maxBackups": 0 }
			}
		}`);

		const config = loadContextGatewayConfig(root, {
			HOME: home,
			PI_CONTEXT_GATEWAY_MODE: "invalid",
			PI_CONTEXT_GATEWAY_ACCOUNTING_LOG_ENABLED: "maybe",
			PI_CONTEXT_GATEWAY_ACCOUNTING_MAX_BYTES: "12oops",
			PI_CONTEXT_GATEWAY_ACCOUNTING_MAX_BACKUPS: "0",
		}, home);

		expect(config.mode).toBe("off");
		expect(config.budgets.maxResultBytes).toBe(DEFAULT_CONTEXT_GATEWAY_BUDGETS.maxResultBytes);
		expect(config.budgets.maxSearchMatches).toBe(DEFAULT_CONTEXT_GATEWAY_BUDGETS.maxSearchMatches);
		expect(config.issues).toHaveLength(10);
		expect(config.issues.join("\n")).toContain("contextGateway.mode");
		expect(config.issues.join("\n")).toContain("PI_CONTEXT_GATEWAY_MODE");
		expect(config.issues.join("\n")).toContain("PI_CONTEXT_GATEWAY_ACCOUNTING_LOG_ENABLED");
	});

	test("maps result classes to their dedicated budgets instead of one generic max", () => {
		const budgets = {
			...DEFAULT_CONTEXT_GATEWAY_BUDGETS,
			maxResultBytes: 111,
			maxExactReadBytes: 222,
			maxSearchBytes: 333,
		};
		expect(contextGatewayBudgetForClass("code-read", budgets)).toBe(222);
		for (const toolClass of ["repo-search", "repo-ast", "repo-structure", "ast-grep"] as const) {
			expect(contextGatewayBudgetForClass(toolClass, budgets)).toBe(333);
		}
		expect(contextGatewayBudgetForClass("shell", budgets)).toBe(111);
		expect(contextGatewayBudgetForClass("mutation", budgets)).toBe(111);
		expect(contextGatewayBudgetForClass("other", budgets)).toBe(111);
	});
});
