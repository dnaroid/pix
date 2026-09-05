import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { MODULES } from "../../src/index.js";
import {
	CODEX_ALIAS_TOOL_DESCRIPTIONS,
	COMPRESS_TOOL_DESCRIPTION,
	REPO_DISCOVERY_TOOLS,
	SESSION_NAME_TOOL_DESCRIPTION,
	SESSION_RECOVERY_TOOL_DESCRIPTIONS,
	TODO_TOOL_DESCRIPTION,
	WEB_SEARCH_TOOL_DESCRIPTIONS,
	astGrepToolDescriptions,
	asyncSubagentToolDescriptions,
	claudeAliasToolDescriptions,
} from "../../src/tool-descriptions.js";
import { EVAL_CASES } from "./cases.js";
import { EXTENSION_EVAL_COVERAGE, TOOL_EVAL_COVERAGE } from "./coverage-manifest.js";

const originalHome = process.env.HOME;
const tempDirs: string[] = [];

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("eval coverage registry", () => {
	test("every extension has deterministic eval coverage", () => {
		const registeredModules = MODULES.map((module) => module.name).sort();
		const coveredModules = Object.keys(EXTENSION_EVAL_COVERAGE).sort();
		expect(coveredModules).toEqual(registeredModules);
		for (const moduleName of registeredModules) {
			expect(EXTENSION_EVAL_COVERAGE[moduleName]!.deterministic.length).toBeGreaterThan(0);
		}
	});

	test("every model-facing tool has deterministic eval coverage", () => {
		const expected = allModelFacingToolNames().sort();
		const covered = Object.keys(TOOL_EVAL_COVERAGE).sort();
		expect(covered).toEqual(expected);
		for (const toolName of expected) expect(TOOL_EVAL_COVERAGE[toolName]!.deterministic.length).toBeGreaterThan(0);
	});

	test("all live coverage references resolve to declared eval cases", () => {
		const ids = new Set(EVAL_CASES.map((evalCase) => evalCase.id));
		for (const [owner, entry] of [
			...Object.entries(EXTENSION_EVAL_COVERAGE).map(([name, value]) => [`extension:${name}`, value] as const),
			...Object.entries(TOOL_EVAL_COVERAGE).map(([name, value]) => [`tool:${name}`, value] as const),
		]) {
			for (const id of entry.live ?? []) expect(ids.has(id), `${owner} references missing live eval ${id}`).toBe(true);
		}
	});

	test("deterministic coverage references existing test files", () => {
		const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
		for (const [owner, entry] of [
			...Object.entries(EXTENSION_EVAL_COVERAGE).map(([name, value]) => [`extension:${name}`, value] as const),
			...Object.entries(TOOL_EVAL_COVERAGE).map(([name, value]) => [`tool:${name}`, value] as const),
		]) {
			for (const testPath of entry.deterministic) {
				expect(fs.existsSync(path.join(packageRoot, testPath)), `${owner} references missing ${testPath}`).toBe(true);
			}
		}
	});
});

describe("previously uncovered extension contracts", () => {
	test("usage registers a lazy /usage command without querying providers during registration", async () => {
		const commands = new Map<string, any>();
		const { default: register } = await import("../../src/usage/index.js");
		register({ registerCommand: (name: string, command: any) => commands.set(name, command) } as any);
		expect(commands.has("usage")).toBe(true);
		expect(commands.get("usage")?.description).toContain("quota usage");
	});

	test("skill-installer registers install and export commands without touching the project", async () => {
		const commands = new Map<string, any>();
		const { default: register } = await import("../../src/skill-installer/index.js");
		register({ registerCommand: (name: string, command: any) => commands.set(name, command) } as any);
		expect([...commands.keys()].sort()).toEqual(["export-skill", "install-skill"]);
	});

	test("prompt-commands registers its management command with an isolated home", async () => {
		const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-prompt-commands-eval-"));
		tempDirs.push(home);
		process.env.HOME = home;
		const commands = new Map<string, any>();
		const { default: register } = await import("../../src/prompt-commands/index.js");
		register({
			registerCommand: (name: string, command: any) => commands.set(name, command),
			getCommands: () => [...commands.keys()].map((name) => ({ name })),
		} as any);
		expect(commands.has("prompt-commands")).toBe(true);
	});
});

function allModelFacingToolNames(): string[] {
	const names = new Set<string>();
	const add = (items: Array<{ name: string }>) => items.forEach((item) => names.add(item.name));
	add(Object.values(astGrepToolDescriptions(1_000, "1MB")));
	add(Object.values(asyncSubagentToolDescriptions(false)));
	add(REPO_DISCOVERY_TOOLS);
	add([TODO_TOOL_DESCRIPTION, SESSION_NAME_TOOL_DESCRIPTION, COMPRESS_TOOL_DESCRIPTION]);
	add(Object.values(SESSION_RECOVERY_TOOL_DESCRIPTIONS));
	add(Object.values(WEB_SEARCH_TOOL_DESCRIPTIONS));
	add(Object.values(claudeAliasToolDescriptions(false)));
	add(Object.values(CODEX_ALIAS_TOOL_DESCRIPTIONS));
	// lookup is registered dynamically by coding-discipline and intentionally
	// lives outside tool-descriptions because its availability is model/config gated.
	names.add("lookup");
	return [...names];
}
