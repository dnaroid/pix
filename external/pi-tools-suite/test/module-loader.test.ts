import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { loadSuiteModules, type LoadableModule } from "../src/module-loader.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempDir() { const dir = mkdtempSync(join(tmpdir(), "suite-isolation-")); dirs.push(dir); return dir; }
function module(name: string, factory: (pi: any) => void | Promise<void>): LoadableModule {
	return { name, load: async () => ({ default: factory }) };
}
function fixture() {
	const registrations: string[] = [];
	const handlers = new Map<string, Set<Function>>();
	const subscribe = (name: string, fn: Function) => {
		const list = handlers.get(name) ?? new Set(); handlers.set(name, list); list.add(fn);
		return () => { list.delete(fn); };
	};
	const pi = {
		on: subscribe,
		registerTool: (tool: any) => { registrations.push(tool.name); },
		registerCommand: (name: string) => { registrations.push(name); },
		registerProvider: (name: string) => { registrations.push(name); },
		events: { on: subscribe, emit: (name: string) => { for (const fn of handlers.get(name) ?? []) fn(); } },
	};
	return { pi, registrations, handlers };
}

test("a real syntax error skips only the broken module and continues loading", async () => {
	const broken = join(tempDir(), "broken.ts");
	writeFileSync(broken, 'export const instructions = "Brief with "unescaped quotes"";');
	const { pi, registrations } = fixture();
	const result = await loadSuiteModules(pi as any, [
		module("before", (api) => api.registerCommand("before")),
		{ name: "broken", load: () => import(pathToFileURL(broken).href) },
		module("after", (api) => api.registerTool({ name: "after" })),
	]);
	expect(result.loaded).toEqual(["before", "after"]);
	expect(result.failures.map((failure) => failure.name)).toEqual(["broken"]);
	expect(result.failures[0].error.length).toBeGreaterThan(0);
	expect(registrations).toEqual(["before", "after"]);
});

test("failed async factory leaves no tools, commands, providers, handlers or bus events", async () => {
	const { pi, registrations, handlers } = fixture();
	let stale: any, calls = 0;
	pi.events.on("bus", () => { calls++; });
	const result = await loadSuiteModules(pi as any, [module("broken", async (api) => {
		stale = api;
		api.registerTool({ name: "leaked-tool" });
		api.registerCommand("leaked-command");
		api.registerProvider("leaked-provider");
		api.on("session_start", () => { calls++; });
		api.events.on("other-bus", () => { calls++; });
		api.events.emit("bus");
		await Promise.resolve();
		throw new Error("factory failed");
	}), module("healthy", (api) => api.registerCommand("healthy"))]);
	expect(result.loaded).toEqual(["healthy"]);
	expect(result.failures[0].error).toContain("factory failed");
	expect(registrations).toEqual(["healthy"]);
	expect(handlers.has("session_start")).toBe(false);
	expect(handlers.has("other-bus")).toBe(false);
	expect(calls).toBe(0);
	expect(() => stale.registerCommand("late")).toThrow("did not initialize");
	expect(() => stale.events.emit("bus")).toThrow("did not initialize");
});

test("successful factories support unsubscribe and dynamic registration after startup", async () => {
	const { pi, registrations, handlers } = fixture();
	let remove: (() => void) | undefined, removeBus: (() => void) | undefined, calls = 0;
	await loadSuiteModules(pi as any, [module("healthy", (api) => {
		api.on("cancelled", () => { calls++; })();
		api.events.on("cancelled-bus", () => { calls++; })();
		remove = api.on("session_start", () => api.registerTool({ name: "dynamic" }));
		removeBus = api.events.on("bus", () => { calls++; });
	})]);
	expect(handlers.has("cancelled")).toBe(false);
	expect(handlers.has("cancelled-bus")).toBe(false);
	for (const handler of handlers.get("session_start") ?? []) handler();
	pi.events.emit("bus");
	expect(registrations).toEqual(["dynamic"]);
	expect(calls).toBe(1);
	remove!(); remove!(); removeBus!();
	expect(handlers.get("session_start")?.size).toBe(0);
	expect(handlers.get("bus")?.size).toBe(0);
});

test("invalid entrypoint and non-Error rejection do not block later modules", async () => {
	const { pi } = fixture();
	const result = await loadSuiteModules(pi as any, [
		{ name: "invalid", load: async () => ({ default: undefined } as any) },
		module("throws", () => { throw "plain failure"; }),
		module("healthy", () => {}),
	]);
	expect(result.loaded).toEqual(["healthy"]);
	expect(result.failures[0].error).toContain("factory function");
	expect(result.failures[1].error).toBe("plain failure");
});

test("unused SDK APIs need not be present in a lightweight host fixture", async () => {
	const registrations: string[] = [];
	const result = await loadSuiteModules({ registerCommand: (name: string) => registrations.push(name) } as any,
		[module("healthy", (api) => api.registerCommand("healthy"))]);
	expect(result.loaded).toEqual(["healthy"]);
	expect(result.failures).toEqual([]);
	expect(registrations).toEqual(["healthy"]);
});

test("SDK skips a failed whole extension and keeps a healthy extension", async () => {
	const root = tempDir();
	const broken = join(root, "broken.ts"), healthy = join(root, "healthy.ts");
	writeFileSync(broken, 'export default () => { throw new Error("broken extension"); };');
	writeFileSync(healthy, 'export default pi => { pi.registerCommand("healthy", { handler: async () => {} }); };');
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: join(root, "agent"), settingsManager: SettingsManager.inMemory({ enableInstallTelemetry: false }),
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		additionalExtensionPaths: [broken, healthy],
	});
	try {
		await loader.reload();
		const result = loader.getExtensions();
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].error).toContain("broken extension");
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].commands.has("healthy")).toBe(true);
	} finally { loader.getExtensions().runtime.invalidate(); }
});

test("real SDK retains only successful staged module registrations", async () => {
	const root = tempDir();
	const extensionPath = join(root, "suite.ts");
	const moduleLoaderPath = fileURLToPath(new URL("../src/module-loader.ts", import.meta.url));
	writeFileSync(extensionPath, `
		import { loadSuiteModules } from ${JSON.stringify(moduleLoaderPath)};
		export default async pi => {
			const result = await loadSuiteModules(pi, [
				{ name: "broken", load: async () => ({ default: async api => {
					api.registerCommand("leaked", { handler: async () => {} });
					api.registerTool({ name: "leaked", parameters: {}, execute: async () => ({ content: [] }) });
					api.registerProvider("leaked-provider", { baseUrl: "https://example.invalid", api: "openai-completions", models: [] });
					api.on("session_start", () => {});
					await Promise.resolve();
					throw new Error("factory failed");
				} }) },
				{ name: "healthy", load: async () => ({ default: api => {
					api.registerCommand("healthy", { handler: async () => {} });
				} }) },
			]);
			if (result.failures.length !== 1) throw new Error("Expected isolated failure");
		};
	`);
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: join(root, "agent"), settingsManager: SettingsManager.inMemory({ enableInstallTelemetry: false }),
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
		additionalExtensionPaths: [extensionPath],
	});
	try {
		await loader.reload();
		const result = loader.getExtensions();
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect([...result.extensions[0].commands.keys()]).toEqual(["healthy"]);
		expect(result.extensions[0].tools.size).toBe(0);
		expect(result.extensions[0].handlers.size).toBe(0);
		expect(result.runtime.pendingProviderRegistrations).toEqual([]);
	} finally { loader.getExtensions().runtime.invalidate(); }
});

test("commit errors escape to the SDK instead of pretending a partial module was isolated", async () => {
	const { pi } = fixture();
	let reachedNext = false;
	pi.registerCommand = () => { throw new Error("SDK rejected registration"); };
	await expect(loadSuiteModules(pi as any, [module("invalid", (api) => api.registerCommand("invalid")),
		module("next", () => { reachedNext = true; })])).rejects.toThrow("Failed to commit pi-tools-suite module invalid");
	expect(reachedNext).toBe(false);
});
