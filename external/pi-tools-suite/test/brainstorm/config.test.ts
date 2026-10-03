import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { defaultBrainstormConfig, mergeBrainstormConfig } from "../../src/brainstorm/config.js";
import { loadPiToolsSuiteConfig } from "../../src/config.js";
import { DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC } from "../../src/default-pi-tools-suite-config.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("default config text and runtime roster agree, with defensive copies", () => {
	expect(parse(DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC).brainstorm).toEqual(defaultBrainstormConfig());
	const altered = defaultBrainstormConfig();
	altered.models.pop();
	expect(defaultBrainstormConfig().models).toHaveLength(4);
});

test("brainstorm layers replace the roster independently of frontier changes", () => {
	const root = mkdtempSync(join(tmpdir(), "brainstorm-config-")); dirs.push(root);
	const homeDir = join(root, "home"), cwd = join(root, "project");
	mkdirSync(join(homeDir, ".config", "pi"), { recursive: true });
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	writeFileSync(join(homeDir, ".config", "pi", "pi-tools-suite.jsonc"), JSON.stringify({ brainstorm: { models: ["one/a", "two/b"], timeoutSeconds: 90 } }));
	writeFileSync(join(cwd, ".pi", "pi-tools-suite.jsonc"), JSON.stringify({ frontierModels: [{ model: "other/new" }], brainstorm: { thinking: "low", models: ["three/c", "four/d"] } }));
	expect(loadPiToolsSuiteConfig(["brainstorm"], { homeDir, cwd, env: {} }).brainstorm).toEqual({ models: ["three/c", "four/d"], timeoutSeconds: 90, thinking: "low" });
});

test("invalid explicit models fail closed instead of reverting to defaults", () => {
	for (const models of [[], ["one/a"], ["one/a", "one/a"], ["one/*", "two/b"], ["missing-provider", "two/b"], [" one/a", "two/b"], Array.from({ length: 7 }, (_, i) => `p/m${i}`)]) {
		expect(() => mergeBrainstormConfig(defaultBrainstormConfig(), { models })).toThrow("2–6 distinct exact");
	}
	for (const timeoutSeconds of [0, 29, 1801, NaN, 90.5, "90"]) expect(() => mergeBrainstormConfig(defaultBrainstormConfig(), { timeoutSeconds })).toThrow();
	expect(() => mergeBrainstormConfig(defaultBrainstormConfig(), { thinking: "whatever" })).toThrow();
});
