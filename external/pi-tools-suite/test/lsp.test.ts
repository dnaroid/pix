import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

mock.module("typebox", () => ({
	Type: {
		Object: (properties: any, options?: any) => ({ kind: "object", properties, options }),
		Optional: (schema: any) => ({ kind: "optional", schema }),
		String: (options?: any) => ({ kind: "string", options }),
		Number: (options?: any) => ({ kind: "number", options }),
		Boolean: (options?: any) => ({ kind: "boolean", options }),
	},
}));

mock.module("@earendil-works/pi-tui", () => ({
	Text: class Text { constructor(public text: string, public x = 0, public y = 0) {} },
	Box: class Box { children: any[] = []; addChild(child: any) { this.children.push(child); } },
	Spacer: class Spacer { constructor(public width = 0, public height = 0) {} },
}));

class FakePi {
	tools = new Map<string, any>();
	handlers = new Map<string, any>();
	renderers = new Map<string, any>();
	messages: any[] = [];
	registerTool(tool: any) { this.tools.set(tool.name, tool); }
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
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
		'  if (mode !== "diagnostic" && mode !== "pullDiagnostic" && mode !== "dynamicPullDiagnostic") return [];',
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
		'    publishDiagnostics(message.params);',
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
	mode?: "basic" | "crash" | "diagnostic" | "pullDiagnostic" | "dynamicPullDiagnostic" | "stubborn" | "tsserver" | "childStubborn" | "hangInitialize";
	id?: string;
	include?: string[];
	rootMarkers?: string[];
	diagnosticsWaitMs?: number;
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

		expect([...pi.handlers.keys()].sort()).toEqual(["session_shutdown", "tool_result"]);
	});

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
		expect([...pi.handlers.keys()].sort()).toEqual(["session_shutdown", "tool_result"]);

		const ctx = { cwd, signal: undefined };
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
		expect(summary.match(/⚠️ fake:/g)).toHaveLength(1);
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
