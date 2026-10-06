import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTypeboxMock } from "./support/typebox-mock.js";

const LSP_DIAGNOSTIC_ICON = "\u{f0026}";

mock.module("typebox", () => createTypeboxMock());

class FakePi {
	tools = new Map<string, any>();
	commands = new Map<string, any>();
	handlers = new Map<string, any>();
	renderers = new Map<string, any>();
	messages: any[] = [];
	registerTool(tool: any) { this.tools.set(tool.name, tool); }
	registerCommand(name: string, command: any) { this.commands.set(name, command); }
	on(name: string, handler: any) { this.handlers.set(name, handler); }
	registerMessageRenderer(name: string, renderer: any) { this.renderers.set(name, renderer); }
	sendMessage(message: any, options: any) { this.messages.push({ message, options }); }
}

const tempDirs: string[] = [];
const originalPiAgentDir = process.env.PI_AGENT_DIR;
const originalHome = process.env.HOME;
const originalPiToolsSuiteDisabledModules = process.env.PI_TOOLS_SUITE_DISABLED_MODULES;
const originalPiToolsSuiteDisabled = process.env.PI_TOOLS_SUITE_DISABLED;

function tempDir(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-")));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await (await import("../src/lsp/shared-manager")).releaseSharedLsp();
	await (globalThis as any).__piToolsSuiteLspManager?.shutdownAll?.();
	if (originalPiAgentDir === undefined) delete process.env.PI_AGENT_DIR;
	else process.env.PI_AGENT_DIR = originalPiAgentDir;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalPiToolsSuiteDisabledModules === undefined) delete process.env.PI_TOOLS_SUITE_DISABLED_MODULES;
	else process.env.PI_TOOLS_SUITE_DISABLED_MODULES = originalPiToolsSuiteDisabledModules;
	if (originalPiToolsSuiteDisabled === undefined) delete process.env.PI_TOOLS_SUITE_DISABLED;
	else process.env.PI_TOOLS_SUITE_DISABLED = originalPiToolsSuiteDisabled;
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeFakeLspServer(dir: string): string {
	const script = path.join(dir, "fake-lsp.cjs");
	fs.writeFileSync(script, [
		'const fs = require("node:fs");',
		'const { spawn } = require("node:child_process");',
		'',
		'const pidLog = process.argv[2];',
		'const mode = process.argv[3] || "basic";',
		'fs.appendFileSync(pidLog, process.pid + "\\n");',
		'if (mode === "crash") process.exit(42);',
		'if (mode === "childStubborn") {',
		'  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
		'  fs.appendFileSync(pidLog, child.pid + "\\n");',
		'}',
		'',
		'let buffer = Buffer.alloc(0);',
		'const keepAlive = setInterval(() => {}, 1000);',
		'if (mode === "stubborn") setTimeout(() => process.exit(0), 5000);',
		'process.on("SIGTERM", () => { if (mode !== "stubborn") process.exit(0); });',
		'',
		'function send(message) {',
		'  const json = JSON.stringify(message);',
		'  process.stdout.write("Content-Length: " + Buffer.byteLength(json, "utf8") + "\\r\\n\\r\\n" + json);',
		'}',
		'',
		'function response(id, result) {',
		'  send({ jsonrpc: "2.0", id, result });',
		'}',
		'',
		'function diagnosticsForMode() {',
		'  if (mode !== "diagnostic" && mode !== "delayedDiagnostic" && mode !== "pullDiagnostic" && mode !== "dynamicPullDiagnostic") return [];',
		'  return [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, source: "fake", message: "Fake issue", code: "F1" }];',
		'}',
		'',
		'function publishDiagnostics(params) {',
		'  if (mode === "tsserver") return;',
		'  const textDocument = params && params.textDocument;',
		'  if (!textDocument || !textDocument.uri) return;',
		'  send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: textDocument.uri, version: textDocument.version, diagnostics: diagnosticsForMode() } });',
		'}',
		'',
		'function handle(message) {',
		'  if (message.result !== undefined || message.error !== undefined) return;',
		'  if (message.method === "initialize") {',
		'    if (mode === "hangInitialize") return;',
		'    const capabilities = {',
		'      textDocumentSync: { openClose: true, change: 1, save: {} },',
		'      documentSymbolProvider: true,',
		'      hoverProvider: true,',
		'      definitionProvider: true,',
		'      referencesProvider: true,',
		'    };',
		'    if (mode === "tsserver") capabilities.executeCommandProvider = { commands: ["typescript.tsserverRequest"] };',
		'    if (mode === "pullDiagnostic") capabilities.diagnosticProvider = { identifier: "fake", interFileDependencies: false, workspaceDiagnostics: false };',
		'    response(message.id, {',
		'      capabilities,',
		'    });',
		'    if (mode === "dynamicPullDiagnostic") send({ jsonrpc: "2.0", id: "register-diagnostics", method: "client/registerCapability", params: { registrations: [{ id: "fake-dynamic", method: "textDocument/diagnostic", registerOptions: { identifier: "dynamicFake", interFileDependencies: false, workspaceDiagnostics: false } }] } });',
		'    return;',
		'  }',
		'',
		'  if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {',
		'    if (mode === "delayedDiagnostic") setTimeout(() => publishDiagnostics(message.params), 150);',
		'    else publishDiagnostics(message.params);',
		'    return;',
		'  }',
		'',
		'  if (message.method === "workspace/executeCommand" && mode === "tsserver") {',
		'    response(message.id, { success: true, body: [{ start: { line: 1, offset: 1 }, end: { line: 1, offset: 2 }, text: "TS issue", code: 999, category: "error", source: "typescript" }] });',
		'    return;',
		'  }',
		'',
		'  if (message.method === "textDocument/diagnostic" && (mode === "pullDiagnostic" || mode === "dynamicPullDiagnostic")) {',
		'    response(message.id, { kind: "full", items: diagnosticsForMode() });',
		'    return;',
		'  }',
		'',
		'  if (message.method === "shutdown") {',
		'    response(message.id, null);',
		'    return;',
		'  }',
		'',
		'  if (message.method === "exit") {',
		'    if (mode === "stubborn" || mode === "childStubborn") return;',
		'    clearInterval(keepAlive);',
		'    process.exit(0);',
		'  }',
		'',
		'  if (message.id !== undefined) response(message.id, message.method === "textDocument/documentSymbol" ? [] : null);',
		'}',
		'',
		'process.stdin.on("data", (chunk) => {',
		'  buffer = Buffer.concat([buffer, chunk]);',
		'  while (true) {',
		'    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");',
		'    if (headerEnd === -1) return;',
		'    const header = buffer.subarray(0, headerEnd).toString("utf8");',
		'    const match = /Content-Length: (\\d+)/i.exec(header);',
		'    if (!match) process.exit(2);',
		'    const length = Number(match[1]);',
		'    const bodyStart = headerEnd + 4;',
		'    if (buffer.length < bodyStart + length) return;',
		'    const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");',
		'    buffer = buffer.subarray(bodyStart + length);',
		'    handle(JSON.parse(body));',
		'  }',
		'});',
	].join("\n"));
	return script;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return predicate();
}

function readPids(pidLog: string): number[] {
	if (!fs.existsSync(pidLog)) return [];
	return fs.readFileSync(pidLog, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
}

function writeGlobalLspConfig(options: {
	agentDir: string;
	cwd: string;
	serverScript: string;
	pidLog: string;
	mode?: "basic" | "crash" | "diagnostic" | "delayedDiagnostic" | "pullDiagnostic" | "dynamicPullDiagnostic" | "stubborn" | "tsserver" | "childStubborn" | "hangInitialize";
	id?: string;
	include?: string[];
	rootMarkers?: string[];
	diagnosticsWaitMs?: number;
	pullDiagnostics?: boolean;
	waitForPublishDiagnostics?: boolean;
}) {
	process.env.HOME = options.agentDir;
	const configDir = path.join(options.agentDir, ".config", "pi");
	fs.mkdirSync(configDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "pi-tools-suite.jsonc"), JSON.stringify({
		lsp: {
			servers: [{
				id: options.id ?? "fake",
				bin: process.execPath,
				args: [options.serverScript, options.pidLog, options.mode ?? "basic"],
				cwd: options.cwd,
				include: options.include ?? ["*.ts", "**/*.ts"],
				rootMarkers: options.rootMarkers ?? [],
				languageIdByExtension: { ".ts": "typescript", ".md": "markdown" },
				startupTimeoutMs: 5_000,
				diagnosticsWaitMs: options.diagnosticsWaitMs ?? 500,
				pullDiagnostics: options.pullDiagnostics,
				waitForPublishDiagnostics: options.waitForPublishDiagnostics,
			}],
		},
	}), "utf8");
}

async function appendMutationDiagnostics(toolName: string, input: unknown, result: any, ctx: any, isError = false) {
	const { appendLspDiagnosticsToMutationResult } = await import("../src/lsp/index.js");
	return appendLspDiagnosticsToMutationResult({ toolName, input, result, ctx, isError });
}

async function runMutationDiagnostics(ctx: any, changedFiles: string[]) {
	return appendMutationDiagnostics("apply_patch", {}, { details: { changedFiles }, content: [{ type: "text", text: "ok" }] }, ctx);
}

// Tests that deliberately pause local manager internals remain local unit tests.
// Production post-edit/control coverage above and below uses the shared broker.
async function runLocalMutationDiagnostics(ctx: any, changedFiles: string[]) {
	const { getGlobalLspManager } = await import("../src/lsp/manager");
	const summaries = await Promise.all(changedFiles.map((file) => getGlobalLspManager().updateDiagnosticsForFile(ctx, path.resolve(ctx.cwd, file))));
	return { content: [{ type: "text", text: "ok" }, ...summaries.filter((text) => text.trim()).map((text) => ({ type: "text", text }))] };
}

describe.serial("Markdown workspace reuse", () => {
	test("bundled Markdown roots reuse one process across nested READMEs and packages", async () => {
		const { DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC } = await import("../src/default-pi-tools-suite-config.js");
		const example = DEFAULT_PI_TOOLS_SUITE_CONFIG_JSONC.split('//   "id": "markdown",')[1]!;
		const markersText = example.match(/"rootMarkers": (\[[\s\S]*?\])/)![1]!.replace(/\/\//g, "");
		const rootMarkers = JSON.parse(markersText) as string[];
		expect(rootMarkers).toEqual([".git"]);
		const cwd = tempDir();
		const home = tempDir();
		fs.mkdirSync(path.join(cwd, ".git"));
		fs.mkdirSync(path.join(cwd, "desktop"), { recursive: true });
		fs.mkdirSync(path.join(cwd, "docs", "decisions"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "desktop", "package.json"), "{}");
		const files = ["README.md", "desktop/README.md", "docs/decisions/README.md"];
		for (const file of files) fs.writeFileSync(path.join(cwd, file), "# Hello\n");
		const pidLog = path.join(cwd, "pids.log");
		writeGlobalLspConfig({ agentDir: home, cwd, serverScript: writeFakeLspServer(cwd), pidLog,
			id: "markdown", include: ["*.md", "**/*.md"], rootMarkers });
		const ctx = { cwd, hasUI: false } as any;
		const { monitorLsp } = await import("../src/lsp/runtime-control.js");
		for (const file of files) {
			await runMutationDiagnostics(ctx, [file]);
			const snapshot = await monitorLsp(ctx);
			expect(snapshot.servers).toHaveLength(1);
			expect(snapshot.servers[0]).toMatchObject({ id: "markdown", root: cwd, state: "running" });
		}
		expect(fs.readFileSync(pidLog, "utf8").trim().split("\n")).toHaveLength(1);
	});
});

describe.serial("LSP runtime control", () => {
	async function setup(mode: "basic" | "hangInitialize" | "crash" = "basic", local = false) {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "control-pids.txt");
		process.env.PI_AGENT_DIR = agentDir;
		writeGlobalLspConfig({ agentDir, cwd, serverScript: writeFakeLspServer(cwd), pidLog, mode });
		fs.writeFileSync(path.join(cwd, "a.ts"), "const a = 1;\n");
		const controlLsp = local ? (await import("../src/lsp/local-runtime-control")).controlLocalLsp : (await import("../src/lsp/runtime-control")).controlLsp;
		const ctx = { cwd, hasUI: false } as any;
		return { cwd, pidLog, ctx, controlLsp };
	}

	test.serial("public monitoring lists only edit-started processes and never controls them", async () => {
		const { cwd, pidLog, ctx } = await setup();
		const { monitorLsp } = await import("../src/lsp/runtime-control");
		const { default: register, shutdownGlobalLspManager } = await import("../src/lsp/index");
		const commands = new Map<string, any>();
		register({ registerCommand: (name: string, command: any) => commands.set(name, command), on() {} } as any);
		for (const action of ["start", "stop", "restart", "trust"]) {
			await expect(commands.get("lsp-control").handler(JSON.stringify({ action, id: "fake", root: cwd }), ctx)).rejects.toThrow("only supports status");
		}
		expect((await monitorLsp(ctx)).servers).toEqual([]);
		expect(readPids(pidLog)).toEqual([]);
		await runMutationDiagnostics(ctx, ["a.ts"]);
		const [pid] = readPids(pidLog);
		expect((await monitorLsp(ctx)).servers).toContainEqual({ id: "fake", root: cwd, state: "running", pid });
		await runMutationDiagnostics(ctx, ["a.ts"]);
		expect(readPids(pidLog)).toEqual([pid]);
		await shutdownGlobalLspManager(ctx);
		expect(await waitFor(() => !processExists(pid))).toBe(true);
		expect((await monitorLsp(ctx)).servers).toEqual([]);
	});

	test.serial("failed startup is a monitoring warning, not an available process", async () => {
		const { ctx, controlLsp } = await setup("crash");
		await runMutationDiagnostics(ctx, ["a.ts"]);
		const { monitorLsp } = await import("../src/lsp/runtime-control");
		const status = await monitorLsp(ctx);
		expect(status.servers).toEqual([]);
		const failure = (await controlLsp(ctx, "status")).servers.find((server) => server.id === "fake")!;
		expect(failure.state).toBe("failed");
		expect(failure.error).toBeTruthy();
		expect(status.warnings).toContain(`${failure.id} (${failure.root}): ${failure.error}`);
	});

	test.serial("local diagnostics keep idle processes for reuse without scheduling idle teardown", async () => {
		const { pidLog, ctx } = await setup("basic", true);
		const { getGlobalLspManager } = await import("../src/lsp/manager");
		const setTimeoutOriginal = globalThis.setTimeout;
		const idleCallbacks: Array<() => void> = [];
		globalThis.setTimeout = ((callback: () => void, delay?: number, ...args: any[]) => {
			if (delay === 30_000) idleCallbacks.push(callback);
			return setTimeoutOriginal(callback, delay, ...args);
		}) as typeof setTimeout;
		try {
			await runLocalMutationDiagnostics(ctx, ["a.ts"]);
			for (const callback of idleCallbacks) callback();
			expect(idleCallbacks).toHaveLength(0);
			const [pid] = readPids(pidLog);
			expect(processExists(pid)).toBe(true);
			await runLocalMutationDiagnostics(ctx, ["a.ts"]);
			expect(readPids(pidLog)).toEqual([pid]);
			await getGlobalLspManager().shutdownAll();
			expect(await waitFor(() => !processExists(pid))).toBe(true);
		} finally {
			globalThis.setTimeout = setTimeoutOriginal;
		}
	});

	test.serial("status does not launch; start reuses diagnostics client, stop stays stopped, restart gets new PID", async () => {
		const { cwd, pidLog, ctx, controlLsp } = await setup();
    expect((await controlLsp(ctx, "status")).servers).toEqual([]);
		expect(readPids(pidLog)).toHaveLength(0);
		const started = await controlLsp(ctx, "start", "fake", cwd);
		const pid = started.servers.find((server) => server.id === "fake")!.pid!;
		expect(started.servers.find((server) => server.id === "fake")!.state).toBe("running");
		await runMutationDiagnostics(ctx, ["a.ts"]);
		expect(readPids(pidLog)).toEqual([pid]);
		await controlLsp(ctx, "stop", "fake", cwd);
		expect(await waitFor(() => !processExists(pid))).toBe(true);
		await runMutationDiagnostics(ctx, ["a.ts"]);
		expect(readPids(pidLog)).toEqual([pid]);
		const restarted = await controlLsp(ctx, "restart", "fake", cwd);
		expect(restarted.servers.find((server) => server.id === "fake")!.pid).not.toBe(pid);
	});

	for (const local of [false, true]) {
		test.serial(`missing language roots are silent and do not block available servers (${local ? "local" : "shared"})`, async () => {
			const { cwd, pidLog, ctx, controlLsp } = await setup("basic", local);
			const configPath = path.join(process.env.HOME!, ".config/pi/pi-tools-suite.jsonc");
			const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
			config.lsp.servers.push(
				{ id: "typescript", bin: "must-not-spawn", rootMarkers: ["absent-typescript-root.json"] },
				{ id: "svelte", bin: "must-not-spawn", rootMarkers: ["absent-svelte-root.js"] },
			);
			fs.writeFileSync(configPath, JSON.stringify(config));
			const status = await controlLsp(ctx, "status");
			expect(status.warnings).toEqual([]);
			expect(status.trustRequired).toBe(false);
      expect(status.servers).toEqual([]);
			expect(readPids(pidLog)).toHaveLength(0);
			const started = await controlLsp(ctx, "start", "fake", cwd);
			expect(started.servers.find((server) => server.id === "fake")?.state).toBe("running");
			expect(readPids(pidLog)).toHaveLength(1);
		});
	}

	test.serial("a later Stop wins while Restart awaits shutdown", async () => {
		const { cwd, pidLog, ctx, controlLsp } = await setup("basic", true);
		const { getGlobalLspManager } = await import("../src/lsp/manager");
		await controlLsp(ctx, "start", "fake", cwd);
		const manager = getGlobalLspManager();
		const originalStop = manager.stopServer.bind(manager);
		let release!: () => void;
		const paused = new Promise<void>((resolve) => { release = resolve; });
		let waiting = false;
		let calls = 0;
		manager.stopServer = async (id, root) => {
			const first = ++calls === 1;
			await originalStop(id, root);
			if (first) { waiting = true; await paused; }
		};
		const restarting = controlLsp(ctx, "restart", "fake", cwd).then(() => "started", () => "cancelled");
		try {
			expect(await waitFor(() => waiting)).toBe(true);
			await controlLsp(ctx, "stop", "fake", cwd);
			release();
			expect(await restarting).toBe("cancelled");
			expect((await controlLsp(ctx, "status")).servers.find((server) => server.id === "fake")!.state).toBe("stopped");
			await runLocalMutationDiagnostics(ctx, ["a.ts"]);
			expect(readPids(pidLog)).toHaveLength(1);
			expect(await waitFor(() => readPids(pidLog).every((pid) => !processExists(pid)))).toBe(true);
		} finally {
			manager.stopServer = originalStop;
			release();
			await restarting;
		}
	});

	test.serial("stop during initialize prevents late startup and leaves no process", async () => {
		const { cwd, pidLog, ctx, controlLsp } = await setup("hangInitialize");
		const start = controlLsp(ctx, "start", "fake", cwd).then(() => "started", () => "cancelled");
		expect(await waitFor(() => readPids(pidLog).length === 1)).toBe(true);
		await controlLsp(ctx, "stop", "fake", cwd);
		expect(await start).toBe("cancelled");
		expect((await controlLsp(ctx, "status")).servers.find((server) => server.id === "fake")!.state).toBe("stopped");
		expect(await waitFor(() => readPids(pidLog).every((pid) => !processExists(pid)))).toBe(true);
	});

	test.serial("owner shutdown invalidates startup and later file discovery completions", async () => {
		const { cwd, pidLog, ctx, controlLsp } = await setup("hangInitialize", true);
		const { getGlobalLspManager } = await import("../src/lsp/manager");
		const start = controlLsp(ctx, "start", "fake", cwd).then(() => "started", () => "cancelled");
		expect(await waitFor(() => readPids(pidLog).length === 1)).toBe(true);
		await getGlobalLspManager().shutdownAll();
		expect(await start).toBe("cancelled");
		expect(getGlobalLspManager().runtimeSnapshot()).toEqual([]);
		expect(await waitFor(() => readPids(pidLog).every((pid) => !processExists(pid)))).toBe(true);
		const discovery = getGlobalLspManager().ensureDocumentForTool(ctx, "a.ts");
		await getGlobalLspManager().shutdownAll();
		await expect(discovery).rejects.toThrow("owner stopped");
		expect(readPids(pidLog)).toHaveLength(1);
	});

	test.serial("untrusted status never prompts; internal trust does not create process rows", async () => {
		const { cwd, pidLog, ctx, controlLsp } = await setup();
		fs.mkdirSync(path.join(cwd, ".pi"));
		fs.writeFileSync(path.join(cwd, ".pi/pi-tools-suite.jsonc"), JSON.stringify({ lsp: { servers: [{ id: "project", bin: process.execPath, args: [writeFakeLspServer(cwd), pidLog] }] } }));
		let prompts = 0;
		ctx.hasUI = true;
		ctx.ui = { select: async () => { prompts++; return "Trust once"; } };
		const status = await controlLsp(ctx, "status");
		expect(status.servers.some((server) => server.id === "project")).toBe(false);
		expect(status.trustRequired).toBe(true);
		expect(prompts).toBe(0);
		const trusted = await controlLsp(ctx, "trust");
		expect(trusted.servers.some((server) => server.id === "project")).toBe(false);
		expect(trusted.trustRequired).toBe(false);
		expect(prompts).toBe(1);
		expect(readPids(pidLog)).toHaveLength(0);
		await expect(controlLsp(ctx, "start", "project", path.dirname(cwd))).rejects.toThrow("trusted workspace");
	});

	test.serial("Stop wins over a delayed trust decision", async () => {
		const { cwd, pidLog, ctx, controlLsp } = await setup();
		fs.mkdirSync(path.join(cwd, ".pi"));
		fs.writeFileSync(path.join(cwd, ".pi/pi-tools-suite.jsonc"), JSON.stringify({ lsp: { servers: [{ id: `delayed-${cwd}`, bin: process.execPath }] } }));
		let release!: (value: string) => void;
		let asking = false;
		ctx.hasUI = true;
		ctx.ui = { select: () => { asking = true; return new Promise((resolve) => { release = resolve; }); } };
		const start = controlLsp(ctx, "start", `delayed-${cwd}`, cwd).then(() => "started", () => "cancelled");
		expect(await waitFor(() => asking)).toBe(true);
		await controlLsp(ctx, "stop", `delayed-${cwd}`, cwd);
		release("Trust once");
		expect(await start).toBe("cancelled");
		expect(readPids(pidLog)).toHaveLength(0);
	});

	test.serial("same-project SDK session switch fences pending trust without releasing another session", async () => {
		if (process.platform === "win32") return;
		const { cwd, pidLog, ctx, controlLsp } = await setup();
		const { default: registerLspExtension } = await import("../src/lsp/index");
		const a = new FakePi(); const b = new FakePi();
		registerLspExtension(a as any); registerLspExtension(b as any);
		ctx.sessionManager = {};
		const other = { cwd, hasUI: false, sessionManager: {} } as any;
		await a.handlers.get("session_start")({}, ctx); await b.handlers.get("session_start")({}, other);
		await controlLsp(other, "start", "fake", cwd);
		const pid = readPids(pidLog)[0];
		fs.mkdirSync(path.join(cwd, ".pi"));
		fs.writeFileSync(path.join(cwd, ".pi/pi-tools-suite.jsonc"), JSON.stringify({ lsp: { servers: [{ id: "delayed-switch", bin: process.execPath }] } }));
		let release!: (value: string) => void; let asking = false;
		ctx.hasUI = true;
		ctx.ui = { select: () => { asking = true; return new Promise((resolve) => { release = resolve; }); }, notify: () => {} };
		const pending = controlLsp(ctx, "start", "delayed-switch", cwd).then(() => "started", (error) => String(error.message));
		expect(await waitFor(() => asking)).toBe(true);
		ctx.sessionManager = {};
		await a.handlers.get("session_start")({}, ctx);
		release("Trust once"); expect(await pending).toContain("owner stopped");
		expect((await controlLsp(other, "status")).servers.find((server) => server.id === "fake")!.pid).toBe(pid);
		await a.handlers.get("session_shutdown")({}, ctx);
		expect(processExists(pid)).toBe(true);
		await b.handlers.get("session_shutdown")({}, other);
		expect(await waitFor(() => !processExists(pid))).toBe(true);
		expect(readPids(pidLog)).toEqual([pid]);
	});

	test.serial("rebinding the same sole SDK session preserves its running project process", async () => {
		const { ctx, pidLog } = await setup();
		const { default: register } = await import("../src/lsp/index");
		const pi = new FakePi();
		register(pi as any);
		ctx.sessionManager = {};
		await pi.handlers.get("session_start")({}, ctx);
		await runMutationDiagnostics(ctx, ["a.ts"]);
		const [pid] = readPids(pidLog);
		await pi.handlers.get("session_start")({}, ctx);
		await runMutationDiagnostics(ctx, ["a.ts"]);
		expect(readPids(pidLog)).toEqual([pid]);
		expect(processExists(pid)).toBe(true);
		await pi.handlers.get("session_shutdown")({}, ctx);
		expect(await waitFor(() => !processExists(pid))).toBe(true);
	});

	test.serial("failed startup remains visible and Stop clears its error", async () => {
		const { cwd, ctx, controlLsp } = await setup("crash");
		await expect(controlLsp(ctx, "start", "fake", cwd)).rejects.toThrow();
		const failed = (await controlLsp(ctx, "status")).servers.find((server) => server.id === "fake")!;
		expect(failed.state).toBe("failed");
		expect(failed.error).toBeTruthy();
		expect((await controlLsp(ctx, "stop", "fake", cwd)).servers.find((server) => server.id === "fake")!.state).toBe("stopped");
	});

	test.serial("nested roots remain controllable after Stop and revalidate current root markers", async () => {
		const { cwd, pidLog, ctx, controlLsp } = await setup();
		const root = path.join(cwd, "packages", "app");
		fs.mkdirSync(root, { recursive: true });
		fs.writeFileSync(path.join(root, "package.json"), "{}");
		fs.writeFileSync(path.join(root, "a.ts"), "const a = 1;\n");
		writeGlobalLspConfig({ agentDir: process.env.HOME!, cwd, serverScript: writeFakeLspServer(cwd), pidLog, rootMarkers: ["package.json"] });
		const unknownRoot = tempDir();
		fs.writeFileSync(path.join(unknownRoot, "package.json"), "{}");
		await controlLsp(ctx, "stop", "fake", unknownRoot);
		await expect(controlLsp(ctx, "start", "fake", unknownRoot)).rejects.toThrow("trusted workspace");
		expect((await controlLsp(ctx, "status")).servers.some((server) => server.root === unknownRoot)).toBe(false);
		await runMutationDiagnostics(ctx, ["packages/app/a.ts"]);
		const [firstPid] = readPids(pidLog);
		expect((await controlLsp(ctx, "status")).warnings).toEqual([]);
		await controlLsp(ctx, "stop", "fake", root);
		expect((await controlLsp(ctx, "status")).servers).toContainEqual({ id: "fake", root, state: "stopped" });
		await runMutationDiagnostics(ctx, ["packages/app/a.ts"]);
		expect(readPids(pidLog)).toEqual([firstPid]);
		expect((await controlLsp(ctx, "restart", "fake", root)).servers.find((server) => server.root === root)!.state).toBe("running");
		expect(readPids(pidLog)).toHaveLength(2);
		await controlLsp(ctx, "stop", "fake", root);
		fs.unlinkSync(path.join(root, "package.json"));
		await expect(controlLsp(ctx, "start", "fake", root)).rejects.toThrow("trusted workspace");
		expect(readPids(pidLog)).toHaveLength(2);
	});

	test.serial("local owner shutdown clears Stop suppression while local idle cleanup preserves it", async () => {
		const { cwd, pidLog, ctx, controlLsp } = await setup("basic", true);
		const { getGlobalLspManager } = await import("../src/lsp/manager");
		await controlLsp(ctx, "start", "fake", cwd);
		await controlLsp(ctx, "stop", "fake", cwd);
		await getGlobalLspManager().shutdownAll({ preserveControlState: true });
		await runLocalMutationDiagnostics(ctx, ["a.ts"]);
		expect(readPids(pidLog)).toHaveLength(1);
		await getGlobalLspManager().shutdownAll();
		expect(getGlobalLspManager().runtimeSnapshot()).toEqual([]);
		await runLocalMutationDiagnostics(ctx, ["a.ts"]);
		expect(readPids(pidLog)).toHaveLength(2);
	});

	test.serial("idle cleanup preserves a failed status without PID until explicit Stop", async () => {
		const { cwd, ctx, controlLsp } = await setup("crash", true);
		const { getGlobalLspManager } = await import("../src/lsp/manager");
		await expect(controlLsp(ctx, "start", "fake", cwd)).rejects.toThrow();
		const failed = (await controlLsp(ctx, "status")).servers.find((server) => server.id === "fake")!;
		await getGlobalLspManager().shutdownAll({ preserveControlState: true });
		const retained = (await controlLsp(ctx, "status")).servers.find((server) => server.id === "fake")!;
		expect(retained.state).toBe("failed");
		expect(retained.error).toBe(failed.error);
		expect(retained.pid).toBeUndefined();
		expect((await controlLsp(ctx, "stop", "fake", cwd)).servers).toContainEqual({ id: "fake", root: cwd, state: "stopped" });
	});

	test.serial("Stop of a failed client wins over overlapping idle cleanup", async () => {
		const { cwd, ctx, controlLsp } = await setup("crash", true);
		const { getGlobalLspManager } = await import("../src/lsp/manager");
		await expect(controlLsp(ctx, "start", "fake", cwd)).rejects.toThrow();
		const manager = getGlobalLspManager();
		const client = (manager as any).clients.values().next().value;
		const originalShutdown = client.shutdown.bind(client);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		client.shutdown = async () => { await gate; await originalShutdown(); };
		const stopping = manager.stopServer("fake", cwd);
		const idle = manager.shutdownAll({ preserveControlState: true });
		try {
			release();
			await Promise.all([stopping, idle]);
			expect((await controlLsp(ctx, "status")).servers).toContainEqual({ id: "fake", root: cwd, state: "stopped" });
		} finally {
			release();
			await Promise.allSettled([stopping, idle]);
			client.shutdown = originalShutdown;
		}
	});

	test.serial("diagnostic registration waiters release on cancellation, timeout and shutdown", async () => {
		const { cwd, ctx, controlLsp } = await setup("basic", true);
		const { getGlobalLspManager } = await import("../src/lsp/manager");
		await controlLsp(ctx, "start", "fake", cwd);
		const client = (getGlobalLspManager() as any).clients.values().next().value;
		const abort = new AbortController();
		const pending = client.waitForPullDiagnosticsSupport(5_000, abort.signal);
		expect(client.diagnosticProviderWaiters).toHaveLength(1);
		abort.abort(); await pending;
		expect(client.diagnosticProviderWaiters).toHaveLength(0);
		await client.waitForPullDiagnosticsSupport(5);
		expect(client.diagnosticProviderWaiters).toHaveLength(0);
		const closing = client.waitForPullDiagnosticsSupport(5_000);
		await client.shutdown(); await closing;
		expect(client.diagnosticProviderWaiters).toHaveLength(0);
	});

	test.serial("terminates detached descendants after their leader has already exited", async () => {
		if (process.platform === "win32") return;
		const { spawn } = await import("node:child_process");
		const { terminateChild } = await import("../src/lsp/child-process");
		const cwd = tempDir();
		const log = path.join(cwd, "orphan-pid.txt");
		const worker = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(log)},String(process.pid));setInterval(()=>{},1000);`;
		const leader = spawn(process.execPath, ["-e", `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'ignore'});c.unref();`], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
		await new Promise<void>((resolve) => leader.once("exit", () => resolve()));
		expect(await waitFor(() => fs.existsSync(log))).toBe(true);
		const pid = Number(fs.readFileSync(log, "utf8"));
		try {
			expect(processExists(pid)).toBe(true);
			await terminateChild(leader);
			expect(await waitFor(() => !processExists(pid))).toBe(true);
		} finally { try { process.kill(pid, "SIGKILL"); } catch {} }
	});
});

describe.serial("LSP shared helpers", () => {
	test.serial("formats diagnostics and resolves paths/commands", async () => {
		const paths = await import("../src/lsp/_shared/paths.js");
		const output = await import("../src/lsp/_shared/output.js");
		const cwd = tempDir();
		process.env.HOME = cwd;
		const file = path.join(cwd, "src", "a.ts");
		expect(paths.expandHome("~/cfg.json")).toBe(path.join(cwd, "cfg.json"));
		expect(paths.toAbsolutePath("src/a.ts", cwd)).toBe(file);
		expect(paths.normalizeRelativePath(`src${path.sep}a.ts`)).toBe("src/a.ts");
		expect(paths.filePathToUri(file)).toStartWith("file://");
		expect(paths.uriToFilePath(paths.filePathToUri(file))).toBe(file);
		fs.mkdirSync(path.join(cwd, "nested"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "demo.csproj"), "<Project />");
		expect(paths.findProjectRoot(path.join(cwd, "nested", "Program.cs"), ["*.csproj"], cwd)).toBe(cwd);

		const command = paths.resolveCommand("ts", { id: "ts", bin: "node_modules/.bin/tsserver", args: ["--stdio", "{relFile}"], cwd: "{root}", env: { FILE: "{file}" }, config: ".pi/lsp.json" } as any, { workspace: cwd, root: cwd, file });
		expect(command.bin).toBe(path.join(cwd, "node_modules/.bin/tsserver"));
		expect(command.args).toEqual(["--stdio", "src/a.ts"]);
		expect(command.env?.FILE).toBe(file);

		const rendered = output.formatLspDiagnostics("ts", file, [{
			severity: 1,
			source: "ts",
			code: 123,
			message: "Broken",
			range: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } },
		} as any], cwd);
		expect(rendered).toStartWith(`${output.LSP_DIAGNOSTIC_ICON} ts:\n`);
		expect(rendered).not.toContain("⚠");
		expect(rendered).toContain("src/a.ts:2:3 - error: ts: Broken [123]");
		expect(output.hasIssueOutput(rendered)).toBe(true);
		expect(output.joinSections("LSP diagnostics", [rendered])).toStartWith("LSP diagnostics:");
	});

	test.serial("caches Trust once decisions for the current session", async () => {
		const { askProjectConfigTrust } = await import("../src/lsp/_shared/trust.js");
		process.env.PI_AGENT_DIR = tempDir();
		let prompts = 0;
		const ctx = {
			hasUI: true,
			ui: {
				select: async () => {
					prompts += 1;
					return "Trust once";
				},
			},
		};

		const options = { ctx: ctx as any, kind: "lsp" as const, configPath: "/tmp/project/.pi/lsp.json", hash: `hash-${Date.now()}-${Math.random()}`, binaries: ["node"] };
		expect(await askProjectConfigTrust(options)).toEqual({ trusted: true, persist: false });
		expect(await askProjectConfigTrust(options)).toEqual({ trusted: true, persist: false });
		expect(prompts).toBe(1);
	});

	test.serial("persists Trust always decisions and does not cache rejects", async () => {
		const { askProjectConfigTrust, isHashTrusted } = await import("../src/lsp/_shared/trust.js");
		process.env.PI_AGENT_DIR = tempDir();
		let choice = "Trust always";
		let prompts = 0;
		const ctx = {
			hasUI: true,
			ui: {
				select: async () => {
					prompts += 1;
					return choice;
				},
			},
		};

		const trustedHash = `always-${Date.now()}-${Math.random()}`;
		const trustedOptions = { ctx: ctx as any, kind: "lsp" as const, configPath: "/tmp/project/.pi/lsp.json", hash: trustedHash, binaries: ["node"] };
		expect(await askProjectConfigTrust(trustedOptions)).toEqual({ trusted: true, persist: true });
		expect(await isHashTrusted("lsp", trustedHash)).toBe(true);
		expect(await askProjectConfigTrust(trustedOptions)).toEqual({ trusted: true, persist: true });
		expect(prompts).toBe(1);

		choice = "Reject";
		const rejectedOptions = { ...trustedOptions, hash: `reject-${Date.now()}-${Math.random()}` };
		expect(await askProjectConfigTrust(rejectedOptions)).toEqual({ trusted: false, persist: false, reason: "project-local config rejected by user" });
		expect(await askProjectConfigTrust(rejectedOptions)).toEqual({ trusted: false, persist: false, reason: "project-local config rejected by user" });
		expect(prompts).toBe(3);
	});

	test.serial("loads LSP servers from shared pi-tools-suite config instead of agent lsp.json", async () => {
		const home = tempDir();
		const agentDir = tempDir();
		process.env.HOME = home;
		process.env.PI_AGENT_DIR = agentDir;
		fs.mkdirSync(path.join(agentDir), { recursive: true });
		fs.writeFileSync(path.join(agentDir, "lsp.json"), JSON.stringify({ servers: [{ id: "old-pix-lsp", bin: "old" }] }), "utf8");
		fs.mkdirSync(path.join(home, ".config", "pi"), { recursive: true });
		fs.writeFileSync(path.join(home, ".config", "pi", "pi-tools-suite.jsonc"), `{
			// LSP config lives in the shared pi-tools-suite config.
			"lsp": {
				"servers": [{
					"id": "shared-lsp",
					"bin": "node",
					"include": ["**/*.ts"],
					"rootMarkers": ["package.json"]
				}]
			}
		}\n`, "utf8");

		const { loadLspConfig } = await import("../src/lsp/_shared/config.js");
		const loaded = await loadLspConfig({ cwd: home } as any);

		expect(loaded.items.map((item) => item.id)).toEqual(["shared-lsp"]);
		expect(loaded.layers.map((layer) => layer.path)).toEqual([path.join(home, ".config", "pi", "pi-tools-suite.jsonc")]);
		expect(loaded.warnings).toEqual([]);
	});

	test.serial("rejects malformed global LSP JSONC with a warning", async () => {
		const home = tempDir();
		const configPath = path.join(home, ".config", "pi", "pi-tools-suite.jsonc");
		const previousConfigDir = process.env.PI_CONFIG_DIR;
		try {
			delete process.env.PI_CONFIG_DIR;
			process.env.HOME = home;
			fs.mkdirSync(path.dirname(configPath), { recursive: true });
			fs.writeFileSync(configPath, '{"lsp":', "utf8");

			const { loadLspConfig } = await import("../src/lsp/_shared/config.js");
			const loaded = await loadLspConfig({ cwd: home } as any);

			expect(loaded.items).toEqual([]);
			expect(loaded.layers).toEqual([]);
			expect(loaded.warnings).toEqual([
				`Failed to load global lsp config ${configPath}: Invalid JSONC (ValueExpected, CloseBraceExpected)`,
			]);
			expect(loaded.trustRequired).toBe(false);
		} finally {
			if (previousConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previousConfigDir;
		}
	});

	test.serial("rejects malformed project LSP JSONC before the trust prompt", async () => {
		const home = tempDir();
		const project = tempDir();
		const configPath = path.join(project, ".pi", "pi-tools-suite.jsonc");
		const previousConfigDir = process.env.PI_CONFIG_DIR;
		try {
			delete process.env.PI_CONFIG_DIR;
			process.env.HOME = home;
			fs.mkdirSync(path.dirname(configPath), { recursive: true });
			fs.writeFileSync(configPath, '{"lsp":', "utf8");
			let prompts = 0;

			const { loadLspConfig } = await import("../src/lsp/_shared/config.js");
			const loaded = await loadLspConfig({
				cwd: project,
				hasUI: true,
				ui: { select: async () => { prompts += 1; return "Trust once"; } },
			} as any);

			expect(loaded.items).toEqual([]);
			expect(loaded.layers).toEqual([]);
			expect(loaded.warnings).toEqual([
				"Failed to load project lsp config: Invalid JSONC (ValueExpected, CloseBraceExpected)",
			]);
			expect(loaded.trustRequired).toBe(false);
			expect(prompts).toBe(0);
		} finally {
			if (previousConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previousConfigDir;
		}
	});
});

describe.serial("LSP library post-edit diagnostics", () => {
	test.serial("top-level suite loads the LSP post-edit hook", async () => {
		process.env.HOME = tempDir();
		process.env.PI_TOOLS_SUITE_DISABLED_MODULES = [
			"ast-grep",
			"async-subagents",
			"repo-discovery",
			"antigravity-auth",
			"opencode-import",
			"todo",
			"model-tools",
			"usage",
			"web-search",
			"dcp",
			"prompt-commands",
		].join(",");
		const pi = new FakePi();

		const { default: registerSuite } = await import("../src/index.js");
		await registerSuite(pi as any);

		expect([...pi.handlers.keys()].sort()).toEqual(expect.arrayContaining(["before_agent_start", "before_provider_request", "model_select", "session_shutdown", "session_start", "tool_result"]));
		// Importing and registering the whole top-level suite touches every
		// module file; on a cold Windows CI runner real-time AV scanning of the
		// fresh checkout can push the one-off import well past the 5s default
		// (observed ~150ms warm vs >5s cold). Keep the budget generous but
		// bounded so genuine registration hangs still fail.
	}, 30_000);

	test.serial("registers post-edit diagnostics hook without TUI renderers", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "hook-diagnostic-pids.txt");
		const serverScript = writeFakeLspServer(cwd);
		process.env.PI_AGENT_DIR = agentDir;
		fs.writeFileSync(path.join(cwd, "a.ts"), "const x: string = 1;\n");
		writeGlobalLspConfig({ agentDir, cwd, serverScript, pidLog, mode: "diagnostic" });
		const pi = new FakePi();

		const { default: registerLspExtension } = await import("../src/lsp/index.js");
		registerLspExtension(pi as any);
		expect([...pi.tools.keys()]).toEqual([]);
		expect([...pi.renderers.keys()]).toEqual([]);
		expect([...pi.handlers.keys()].sort()).toEqual(["session_shutdown", "session_start", "tool_result"]);

		const ctx = { cwd, signal: undefined };
		await pi.handlers.get("session_start")({ type: "session_start" }, ctx);
		expect(readPids(pidLog)).toEqual([]);
		const resultPatch = await pi.handlers.get("tool_result")({
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "apply_patch",
			input: "*** Begin Patch\n*** Update File: a.ts\n@@\n-const x = 1;\n+const x = 2;\n*** End Patch",
			details: undefined,
			content: [{ type: "text", text: "ok" }],
			isError: false,
		}, ctx);

		expect(resultPatch.content.at(-1).text).toContain("a.ts:1:1 - error: fake: Fake issue [F1]");
		expect(readPids(pidLog)).toHaveLength(1);
		await pi.handlers.get("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
	});

	test.serial("reuses one LSP process for repeated diagnostics calls and shuts it down", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "lsp-pids.txt");
		const serverScript = writeFakeLspServer(cwd);
		process.env.PI_AGENT_DIR = agentDir;
		fs.writeFileSync(path.join(cwd, "a.ts"), "const x = 1;\n");
		writeGlobalLspConfig({ agentDir, cwd, serverScript, pidLog });

		const ctx = { cwd, signal: undefined };

		const [first, second] = await Promise.all([
			runMutationDiagnostics(ctx, ["a.ts"]),
			runMutationDiagnostics(ctx, ["a.ts"]),
		]);

		expect(first.content).toEqual([{ type: "text", text: "ok" }]);
		expect(second.content).toEqual([{ type: "text", text: "ok" }]);
		const pids = readPids(pidLog);
		expect(pids).toHaveLength(1);
		expect(processExists(pids[0])).toBe(true);

		const { shutdownGlobalLspManager } = await import("../src/lsp/index.js");
		await shutdownGlobalLspManager();
		expect(await waitFor(() => !processExists(pids[0]))).toBe(true);
	});

	test.serial("backs off after a crashing LSP startup", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "crash-pids.txt");
		const serverScript = writeFakeLspServer(cwd);
		process.env.PI_AGENT_DIR = agentDir;
		fs.writeFileSync(path.join(cwd, "a.ts"), "const x = 1;\n");
		writeGlobalLspConfig({ agentDir, cwd, serverScript, pidLog, mode: "crash" });

		const ctx = { cwd, signal: undefined };

		let firstError: unknown;
		const first = await runMutationDiagnostics(ctx, ["a.ts"]);
		firstError = first.content.at(-1).text;
		expect(firstError).toMatch(/LSP exited|initialize|connection got disposed/);

		let secondError: unknown;
		const second = await runMutationDiagnostics(ctx, ["a.ts"]);
		secondError = second.content.at(-1).text;
		expect(secondError).toMatch(/unavailable .*retry after/);
		expect(readPids(pidLog)).toHaveLength(1);
	});

	test.serial("starts separate clients for different roots with the same server id", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "multi-root-pids.txt");
		const serverScript = writeFakeLspServer(cwd);
		const rootA = path.join(cwd, "pkg-a");
		const rootB = path.join(cwd, "pkg-b");
		fs.mkdirSync(rootA, { recursive: true });
		fs.mkdirSync(rootB, { recursive: true });
		fs.writeFileSync(path.join(rootA, "package.json"), "{}\n");
		fs.writeFileSync(path.join(rootB, "package.json"), "{}\n");
		fs.writeFileSync(path.join(rootA, "a.ts"), "const a = 1;\n");
		fs.writeFileSync(path.join(rootB, "b.ts"), "const b = 1;\n");
		process.env.PI_AGENT_DIR = agentDir;
		writeGlobalLspConfig({ agentDir, cwd, serverScript, pidLog, rootMarkers: ["package.json"] });

		const ctx = { cwd, signal: undefined };
		expect((await runMutationDiagnostics(ctx, ["pkg-a/a.ts"])).content).toEqual([{ type: "text", text: "ok" }]);
		expect((await runMutationDiagnostics(ctx, ["pkg-b/b.ts"])).content).toEqual([{ type: "text", text: "ok" }]);
		expect(readPids(pidLog)).toHaveLength(2);
	});

	test.serial("deduplicates changedFiles diagnostics without adding separate chat messages", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "diagnostic-pids.txt");
		const serverScript = writeFakeLspServer(cwd);
		process.env.PI_AGENT_DIR = agentDir;
		fs.writeFileSync(path.join(cwd, "a.ts"), "const x: string = 1;\n");
		writeGlobalLspConfig({ agentDir, cwd, serverScript, pidLog, mode: "diagnostic" });

		const ctx = { cwd, signal: undefined };
		const result = await appendMutationDiagnostics("ast_apply", {}, { details: { changedFiles: ["a.ts", " a.ts ", ""] }, content: [{ type: "text", text: "ok" }] }, ctx);

		const summary = result.content.at(-1).text;
		expect(summary.match(new RegExp(`${LSP_DIAGNOSTIC_ICON} fake:`, "g"))).toHaveLength(1);
		expect(summary).toContain("a.ts:1:1 - error: fake: Fake issue [F1]");
		expect(readPids(pidLog)).toHaveLength(1);
	});

	test.serial("skips deleted files without appending an ENOENT warning", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "deleted-file-pids.txt");
		const serverScript = writeFakeLspServer(cwd);
		process.env.PI_AGENT_DIR = agentDir;
		writeGlobalLspConfig({ agentDir, cwd, serverScript, pidLog, mode: "diagnostic" });

		const ctx = { cwd, signal: undefined };
		const result = await appendMutationDiagnostics("apply_patch", "*** Begin Patch\n*** Delete File: deleted.ts\n*** End Patch", { content: [{ type: "text", text: "ok" }] }, ctx);

		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(readPids(pidLog)).toHaveLength(0);
	});

	test.serial("detects diagnostics for Claude-style Write and Edit aliases", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "alias-diagnostic-pids.txt");
		const serverScript = writeFakeLspServer(cwd);
		process.env.PI_AGENT_DIR = agentDir;
		fs.writeFileSync(path.join(cwd, "a.ts"), "const x: string = 1;\n");
		writeGlobalLspConfig({ agentDir, cwd, serverScript, pidLog, mode: "diagnostic" });

		const ctx = { cwd, signal: undefined };
		const writeResult = await appendMutationDiagnostics("Write", { file_path: "a.ts", content: "const x: string = 1;\n" }, { content: [{ type: "text", text: "ok" }] }, ctx);
		expect(writeResult.content.at(-1).text).toContain("a.ts:1:1 - error: fake: Fake issue [F1]");

		const editResult = await appendMutationDiagnostics("Edit", { file_path: "a.ts", old_string: "1", new_string: "2" }, { content: [{ type: "text", text: "ok" }] }, ctx);
		expect(editResult.content.at(-1).text).toContain("a.ts:1:1 - error: fake: Fake issue [F1]");
		expect(readPids(pidLog)).toHaveLength(1);
	});

	test.serial("uses tsserver diagnostics fallback when advertised", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "tsserver-pids.txt");
		const serverScript = writeFakeLspServer(cwd);
		process.env.PI_AGENT_DIR = agentDir;
		fs.writeFileSync(path.join(cwd, "a.ts"), "const x: string = 1;\n");
		writeGlobalLspConfig({ agentDir, cwd, serverScript, pidLog, mode: "tsserver" });

		const ctx = { cwd, signal: undefined };
		const result = await appendMutationDiagnostics("apply_patch", "*** Begin Patch\n*** Update File: a.ts\n@@\n-const x = 1;\n+const x = 2;\n*** End Patch", { content: [{ type: "text", text: "ok" }] }, ctx);

		const summary = result.content.at(-1).text;
		expect(summary).toContain("a.ts:1:1 - error: typescript: TS issue [999]");
		expect(summary).not.toContain("timed out");
	});

	test.serial("uses pull diagnostics when advertised", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "pull-diagnostic-pids.txt");
		const serverScript = writeFakeLspServer(cwd);
		process.env.PI_AGENT_DIR = agentDir;
		fs.writeFileSync(path.join(cwd, "a.ts"), "const x: string = 1;\n");
		writeGlobalLspConfig({ agentDir, cwd, serverScript, pidLog, mode: "pullDiagnostic" });

		const ctx = { cwd, signal: undefined };
		const result = await appendMutationDiagnostics("apply_patch", "*** Begin Patch\n*** Update File: a.ts\n@@\n-const x = 1;\n+const x = 2;\n*** End Patch", { content: [{ type: "text", text: "ok" }] }, ctx);

		const summary = result.content.at(-1).text;
		expect(summary).toContain("a.ts:1:1 - error: fake: Fake issue [F1]");
		expect(summary).not.toContain("timed out");
	});

	test.serial("can keep slow pull-diagnostic servers non-blocking", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "non-blocking-pull-diagnostic-pids.txt");
		const serverScript = writeFakeLspServer(cwd);
		process.env.PI_AGENT_DIR = agentDir;
		fs.writeFileSync(path.join(cwd, "a.ts"), "const x: string = 1;\n");
		writeGlobalLspConfig({
			agentDir,
			cwd,
			serverScript,
			pidLog,
			mode: "pullDiagnostic",
			diagnosticsWaitMs: 0,
			pullDiagnostics: false,
			waitForPublishDiagnostics: false,
		});

		const ctx = { cwd, signal: undefined };
		const result = await appendMutationDiagnostics("apply_patch", "*** Begin Patch\n*** Update File: a.ts\n@@\n-const x = 1;\n+const x = 2;\n*** End Patch", { content: [{ type: "text", text: "ok" }] }, ctx);

		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(readPids(pidLog)).toHaveLength(1);
	});

	test.serial("waits for published diagnostics when pull diagnostics is disabled", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "publish-diagnostic-pids.txt");
		const serverScript = writeFakeLspServer(cwd);
		process.env.PI_AGENT_DIR = agentDir;
		fs.writeFileSync(path.join(cwd, "a.ts"), "const x: string = 1;\n");
		writeGlobalLspConfig({
			agentDir,
			cwd,
			serverScript,
			pidLog,
			mode: "delayedDiagnostic",
			diagnosticsWaitMs: 1000,
			pullDiagnostics: false,
			waitForPublishDiagnostics: true,
		});

		const ctx = { cwd, signal: undefined };
		const startedAt = Date.now();
		const result = await appendMutationDiagnostics("apply_patch", "*** Begin Patch\n*** Update File: a.ts\n@@\n-const x = 1;\n+const x = 2;\n*** End Patch", { content: [{ type: "text", text: "ok" }] }, ctx);

		const summary = result.content.at(-1).text;
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
		expect(summary).toContain("a.ts:1:1 - error: fake: Fake issue [F1]");
		expect(summary).not.toContain("timed out");
		expect(readPids(pidLog)).toHaveLength(1);
	});

	test.serial("uses dynamically registered pull diagnostics", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "dynamic-pull-diagnostic-pids.txt");
		const serverScript = writeFakeLspServer(cwd);
		process.env.PI_AGENT_DIR = agentDir;
		fs.writeFileSync(path.join(cwd, "a.ts"), "const x: string = 1;\n");
		writeGlobalLspConfig({ agentDir, cwd, serverScript, pidLog, mode: "dynamicPullDiagnostic" });

		const ctx = { cwd, signal: undefined };
		const result = await appendMutationDiagnostics("apply_patch", "*** Begin Patch\n*** Update File: a.ts\n@@\n-const x = 1;\n+const x = 2;\n*** End Patch", { content: [{ type: "text", text: "ok" }] }, ctx);

		const summary = result.content.at(-1).text;
		expect(summary).toContain("a.ts:1:1 - error: fake: Fake issue [F1]");
		expect(summary).not.toContain("timed out");
	});

	test.serial("adds local Markdown and Mermaid diagnostics", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "markdown-diagnostic-pids.txt");
		const serverScript = writeFakeLspServer(cwd);
		process.env.PI_AGENT_DIR = agentDir;
		fs.writeFileSync(path.join(cwd, "README.md"), [
			"# Demo",
			"",
			"[missing](./missing.md)",
			"[bad ref][nope]",
			"[dup]: ./a.md",
			"[dup]: ./b.md",
			"",
			"```mermaid",
			"flowchart TD",
			"  A -> B",
			"```",
			"",
		].join("\n"));
		writeGlobalLspConfig({ agentDir, cwd, serverScript, pidLog, id: "markdown", mode: "pullDiagnostic", include: ["*.md", "**/*.md"], diagnosticsWaitMs: 500 });

		const ctx = { cwd, signal: undefined };
		const result = await runMutationDiagnostics(ctx, ["README.md"]);
		const summary = result.content.at(-1).text;
		expect(summary).toContain("link.no-such-file");
		expect(summary).toContain("link.no-such-reference");
		expect(summary).toContain("link.duplicate-definition");
		expect(summary).toContain("mermaid.invalid-arrow");
	});

	test.serial("kills stubborn LSP processes that ignore shutdown and SIGTERM", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "stubborn-pids.txt");
		const serverScript = writeFakeLspServer(cwd);
		process.env.PI_AGENT_DIR = agentDir;
		fs.writeFileSync(path.join(cwd, "a.ts"), "const x = 1;\n");
		writeGlobalLspConfig({ agentDir, cwd, serverScript, pidLog, mode: "stubborn" });

		const ctx = { cwd, signal: undefined };
		expect((await runMutationDiagnostics(ctx, ["a.ts"])).content).toEqual([{ type: "text", text: "ok" }]);
		const [pid] = readPids(pidLog);
		expect(processExists(pid)).toBe(true);

		const { shutdownGlobalLspManager } = await import("../src/lsp/index.js");
		await shutdownGlobalLspManager();
		expect(await waitFor(() => !processExists(pid), 3_000)).toBe(true);
	});

	test.serial("kills child process groups created by LSP wrapper scripts", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "child-stubborn-pids.txt");
		const serverScript = writeFakeLspServer(cwd);
		process.env.PI_AGENT_DIR = agentDir;
		fs.writeFileSync(path.join(cwd, "a.ts"), "const x = 1;\n");
		writeGlobalLspConfig({ agentDir, cwd, serverScript, pidLog, mode: "childStubborn" });

		const ctx = { cwd, signal: undefined };
		expect((await runMutationDiagnostics(ctx, ["a.ts"])).content).toEqual([{ type: "text", text: "ok" }]);
		const pids = readPids(pidLog);
		expect(pids).toHaveLength(2);
		expect(pids.every(processExists)).toBe(true);

		const { shutdownGlobalLspManager } = await import("../src/lsp/index.js");
		await shutdownGlobalLspManager();
		expect(await waitFor(() => pids.every((pid) => !processExists(pid)), 3_000)).toBe(true);
	});

	test.serial("aborts startup waits and kills the LSP process", async () => {
		const cwd = tempDir();
		const agentDir = tempDir();
		const pidLog = path.join(cwd, "abort-pids.txt");
		const serverScript = writeFakeLspServer(cwd);
		process.env.PI_AGENT_DIR = agentDir;
		fs.writeFileSync(path.join(cwd, "a.ts"), "const x = 1;\n");
		writeGlobalLspConfig({ agentDir, cwd, serverScript, pidLog, mode: "hangInitialize", diagnosticsWaitMs: 5_000 });

		const controller = new AbortController();
		const ctx = { cwd, signal: controller.signal };
		const resultPromise = runMutationDiagnostics(ctx, ["a.ts"]);
		await waitFor(() => readPids(pidLog).length === 1, 1_000);
		controller.abort();

		const result = await resultPromise;
		const [pid] = readPids(pidLog);
		expect(result.content.at(-1).text).toContain("aborted");
		expect(await waitFor(() => !processExists(pid), 3_000)).toBe(true);
	});
});
