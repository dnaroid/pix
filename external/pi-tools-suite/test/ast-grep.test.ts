import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createPiAiMock } from "./support/pi-ai-mock.js";
import { createTypeboxMock } from "./support/typebox-mock.js";

mock.module("typebox", () => createTypeboxMock());

mock.module("@earendil-works/pi-ai", () => createPiAiMock());

function builtinTool(name: string) {
	return (cwd: string) => ({
		name,
		execute: async () => ({ content: [{ type: "text", text: `${name} ok` }], details: undefined }),
		renderResult: (result: any, _options: any, _theme: any, _context: any) => {
			return { render: () => [`expanded ${name}: ${result.content?.[0]?.text ?? ""} cwd=${cwd}`], invalidate() {} };
		},
	});
}

mock.module("@earendil-works/pi-coding-agent", () => ({
	DEFAULT_MAX_BYTES: 1024 * 1024,
	DEFAULT_MAX_LINES: 1000,
	defineTool: (tool: any) => tool,
	formatSize: (bytes: number) => `${bytes}B`,
	truncateHead: (content: string) => ({ content, truncated: false, totalLines: content.split("\n").length, outputLines: content.split("\n").length, totalBytes: Buffer.byteLength(content), outputBytes: Buffer.byteLength(content) }),
	withFileMutationQueue: async (_key: string, fn: () => Promise<unknown>) => fn(),
	createReadToolDefinition: builtinTool("read"),
	createBashToolDefinition: builtinTool("bash"),
	createEditToolDefinition: builtinTool("edit"),
	createWriteToolDefinition: builtinTool("write"),
	createGrepToolDefinition: builtinTool("grep"),
	createFindToolDefinition: builtinTool("find"),
	createLsToolDefinition: builtinTool("ls"),
}));

mock.module("@earendil-works/pi-tui", () => ({
	Container: class Container { children: any[] = []; addChild(child: any) { this.children.push(child); } },
	Text: class Text { constructor(public text: string, public x = 0, public y = 0) {} },
	Box: class Box { children: any[] = []; addChild(child: any) { this.children.push(child); } },
	Spacer: class Spacer { constructor(public width = 0, public height = 0) {} },
	visibleWidth: (text: string) => text.replace(/<[^>]+>/g, "").length,
	truncateToWidth: (text: string, width: number, ellipsis = "…") => {
		const visible = text.replace(/<[^>]+>/g, "");
		if (visible.length <= width) return text;
		if (width <= ellipsis.length) return ellipsis.slice(0, Math.max(0, width));
		return visible.slice(0, width - ellipsis.length) + ellipsis;
	},
}));

class FakePi {
	tools = new Map<string, any>();
	execCalls: Array<{ bin: string; args: string[]; options: any }> = [];
	results: Array<{ stdout: string; stderr?: string; code?: number; killed?: boolean }> = [];
	registerTool(tool: any) { this.tools.set(tool.name, tool); }
	async exec(bin: string, args: string[], options: any) {
		this.execCalls.push({ bin, args, options });
		return this.results.shift() ?? { stdout: "match", stderr: "", code: 0 };
	}
}

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ast-grep-test-"));
	tempDirs.push(dir);
	return dir;
}

async function expectRejectsToThrow(promise: Promise<unknown>, message: string) {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain(message);
		return;
	}
	throw new Error(`Expected promise to reject with ${message}`);
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ast-grep tools", () => {
	test("registers ast_grep and ast_apply with argument normalization", async () => {
		const { registerAstGrepTool } = await import("../src/ast-grep/tool.js");
		const pi = new FakePi();
		registerAstGrepTool(pi as any);

		expect([...pi.tools.keys()].sort()).toEqual(["ast_apply", "ast_grep"]);
		expect(pi.tools.get("ast_grep").prepareArguments({ pattern: "console.log($A)", path: "src/a.ts" })).toMatchObject({ paths: ["src/a.ts"] });
		expect(pi.tools.get("ast_grep").prepareArguments({ pattern: "x", paths: "src" })).toMatchObject({ paths: ["src"] });
	});

	test("ast_grep is read-only, validates conflicts, and builds run args", async () => {
		const { registerAstGrepTool } = await import("../src/ast-grep/tool.js");
		const pi = new FakePi();
		registerAstGrepTool(pi as any);
		const tool = pi.tools.get("ast_grep");
		const cwd = tempDir();

		await expectRejectsToThrow(tool.execute("call", { pattern: "x", updateAll: true }, undefined, undefined, { cwd }), "read-only");
		await expectRejectsToThrow(tool.execute("call", { pattern: "x", filesWithMatches: true, json: true }, undefined, undefined, { cwd }), "conflicts");
		await expectRejectsToThrow(tool.execute("call", { pattern: "x", rewrite: "y", filesWithMatches: true }, undefined, undefined, { cwd }), "rewrite");
		await expectRejectsToThrow(tool.execute("call", { command: "scan", pattern: "x" }, undefined, undefined, { cwd }), "run-only");

		pi.results.push({ stdout: "a.ts:1:1\nconsole.log(1)", code: 0 });
		const result = await tool.execute("call", {
			pattern: "console.log($A)",
			paths: ["src"],
			lang: "ts",
			rewrite: "logger.info($A)",
			context: 2,
			globs: ["*.ts"],
		}, undefined, undefined, { cwd });

		expect(pi.execCalls[pi.execCalls.length - 1]).toMatchObject({
			args: ["run", "--pattern", "console.log($A)", "--color", "never", "--heading", "never", "--lang", "ts", "--rewrite", "logger.info($A)", "--context", "2", "--globs", "*.ts", "src"],
			options: { cwd },
		});
		expect(result.content[0].text).toContain("Rewrite preview only");
		expect(result.details).toMatchObject({ mode: "run", rewritePreview: true, mutated: false, paths: ["src"], exitCode: 0 });
	});

	test("ast_apply forces update-all and reports preflight changed files", async () => {
		const { registerAstGrepTool } = await import("../src/ast-grep/tool.js");
		const pi = new FakePi();
		registerAstGrepTool(pi as any);
		const tool = pi.tools.get("ast_apply");
		const cwd = tempDir();
		pi.results.push(
			{ stdout: JSON.stringify({ file: "src/a.ts", replacement: "x" }) + "\n" + JSON.stringify({ file: "src/b.ts", replacement: "y" }), code: 0 },
			{ stdout: "rewrote 2 files", code: 0 },
		);

		const result = await tool.execute("call", { pattern: "foo($A)", rewrite: "bar($A)", paths: ["src"], lang: "ts" }, undefined, undefined, { cwd });

		expect(pi.execCalls[0].args).toContain("--json=stream");
		expect(pi.execCalls[0].options).toMatchObject({ cwd });
		expect(pi.execCalls[1].args).toContain("--update-all");
		expect(pi.execCalls[1].options).toMatchObject({ cwd });
		expect(result.content[0].text).toContain("Changes were applied");
		expect(result.details).toMatchObject({ mutated: true, changedFiles: ["src/a.ts", "src/b.ts"] });
	});

	test("preserves at-prefixed paths and renders ast_apply label", async () => {
		const { registerAstGrepTool } = await import("../src/ast-grep/tool.js");
		const pi = new FakePi();
		registerAstGrepTool(pi as any);
		const cwd = tempDir();
		const tool = pi.tools.get("ast_grep");

		pi.results.push({ stdout: "@scope/pkg/a.ts:1:match", code: 0 });
		await tool.execute("call", { pattern: "x", paths: [" @scope/pkg "] }, undefined, undefined, { cwd });
		const lastCall = pi.execCalls[pi.execCalls.length - 1];
		expect(lastCall?.args[lastCall.args.length - 1]).toBe("@scope/pkg");

		const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
		const rendered = pi.tools.get("ast_apply").renderCall({ pattern: "x", rewrite: "y" }, theme);
		expect(rendered.text).toStartWith("ast_apply ");
	});

	test("counts json stream and scan diagnostics without counting context lines", async () => {
		const { countLikelyMatches } = await import("../src/ast-grep/utils.js");

		expect(countLikelyMatches('{"file":"a.ts"}\n{"file":"b.ts"}', { json: true } as any)).toBe(2);
		expect(countLikelyMatches([
			"warning[no-console]: no console",
			"  ┌─ a.ts:1:1",
			"  │",
			"1 │ console.log(1)",
			"  │ ^^^^^^^^^^^^^^",
			"",
			"a.ts:2:1: warning[no-console]: no console",
		].join("\n"), { command: "scan" } as any)).toBe(2);
	});
});
