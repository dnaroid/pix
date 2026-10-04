import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import codemode from "../src/codemode/index.js";
import { loadPiToolsSuiteConfig } from "../src/config.js";
import { MODULES } from "../src/index.js";
import { loadSuiteModules } from "../src/module-loader.js";

const selectionKeys = ["PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION", "MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION"];
const originalEnv = selectionKeys.map((key) => process.env[key]);
afterEach(() => selectionKeys.forEach((key, i) => {
	if (originalEnv[i] === undefined) delete process.env[key];
	else process.env[key] = originalEnv[i];
}));

function harness(existing = false) {
	selectionKeys.forEach((key) => delete process.env[key]);
	const tools: any[] = existing ? [{ name: "codemode" }] : [];
	const handlers = new Map<string, (() => Promise<void>)[]>();
	let active = ["read", "shell", "question"];
	let registrations = 0;
	const pi = {
		on: (name: string, fn: () => Promise<void>) => {
			handlers.set(name, [...(handlers.get(name) ?? []), fn]);
			return () => {};
		},
		registerTool: (tool: any) => { registrations++; tools.push(tool); },
		getAllTools: () => tools,
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => { active = names; },
	};
	return { pi, tools, registrations: () => registrations, active: () => active,
		start: async () => { for (const fn of handlers.get("session_start") ?? []) await fn(); } };
}

describe("codemode module", () => {
	test("adds the SDK tool once, preserving direct tools across repeated starts", async () => {
		const h = harness();
		codemode(h.pi as any);
		await h.start();
		await h.start();
		expect(h.registrations()).toBe(1);
		expect(h.tools[0].defaultActive).toBe(false);
		expect(h.active()).toEqual(["read", "shell", "question", "codemode"]);
	});

	test("reuses the CLI builtin instead of registering a conflicting definition", async () => {
		const h = harness(true);
		codemode(h.pi as any);
		await h.start();
		expect(h.registrations()).toBe(0);
		expect(h.active()).toContain("codemode");
	});

	for (const key of selectionKeys) test(`does not widen a restricted selection (${key})`, async () => {
		const h = harness();
		process.env[key] = " true ";
		codemode(h.pi as any);
		await h.start();
		expect(h.registrations()).toBe(0);
		expect(h.active()).toEqual(["read", "shell", "question"]);
	});

	test("catalog defaults on; project map and environment overrides control actual module loading", async () => {
		const root = mkdtempSync(join(tmpdir(), "suite-codemode-"));
		try {
			const names = MODULES.map((module) => module.name);
			const options = { cwd: root, homeDir: root, env: {}, includeUserConfig: false, ensureUserConfig: false };
			expect(loadPiToolsSuiteConfig(names, options).disabledModules).not.toContain("codemode");
			mkdirSync(join(root, ".pi"));
			for (const enabled of [false, true]) {
				writeFileSync(join(root, ".pi", "pi-tools-suite.jsonc"), JSON.stringify({ modules: { codemode: enabled } }));
				const config = loadPiToolsSuiteConfig(names, options);
				const h = harness();
				const selected = MODULES.filter((module) => module.name === "codemode" && !config.disabledModules.includes(module.name));
				const result = await loadSuiteModules(h.pi as any, selected);
				expect(result.failures).toEqual([]);
				await h.start();
				expect(h.active().includes("codemode")).toBe(enabled);
			}
			expect(loadPiToolsSuiteConfig(names, { ...options, env: { PI_TOOLS_SUITE_DISABLED_MODULES: "codemode" } }).disabledModules).toContain("codemode");
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
});
