import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createTypeboxMock } from "./support/typebox-mock.js";

mock.module("typebox", () => createTypeboxMock());

// Real pi-coding-agent is available in the suite node_modules; no pi-ai mock
// needed because comment-checker only uses the tool_result event.

const originalHome = process.env.HOME;
const originalConfigDir = process.env.PI_CONFIG_DIR;
const originalCcEnabled = process.env.PI_COMMENT_CHECKER_ENABLED;
const originalCcStrictness = process.env.PI_COMMENT_CHECKER_STRICTNESS;
const originalDisabledModules = process.env.PI_TOOLS_SUITE_DISABLED_MODULES;
const originalDisabled = process.env.PI_TOOLS_SUITE_DISABLED;

const tempDirs: string[] = [];
let tmpHome = "";

function freshHome(): string {
	const fs = require("node:fs");
	const os = require("node:os");
	const path = require("node:path");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-test-"));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	tmpHome = freshHome();
	process.env.HOME = tmpHome;
	delete process.env.PI_CONFIG_DIR;
	delete process.env.PI_COMMENT_CHECKER_ENABLED;
	delete process.env.PI_COMMENT_CHECKER_STRICTNESS;
	delete process.env.PI_TOOLS_SUITE_DISABLED_MODULES;
	delete process.env.PI_TOOLS_SUITE_DISABLED;
});

afterEach(async () => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = originalConfigDir;
	if (originalCcEnabled === undefined) delete process.env.PI_COMMENT_CHECKER_ENABLED;
	else process.env.PI_COMMENT_CHECKER_ENABLED = originalCcEnabled;
	if (originalCcStrictness === undefined) delete process.env.PI_COMMENT_CHECKER_STRICTNESS;
	else process.env.PI_COMMENT_CHECKER_STRICTNESS = originalCcStrictness;
	if (originalDisabledModules === undefined) delete process.env.PI_TOOLS_SUITE_DISABLED_MODULES;
	else process.env.PI_TOOLS_SUITE_DISABLED_MODULES = originalDisabledModules;
	if (originalDisabled === undefined) delete process.env.PI_TOOLS_SUITE_DISABLED;
	else process.env.PI_TOOLS_SUITE_DISABLED = originalDisabled;

	const indexMod = await import("../src/comment-checker/index.js");
	const configMod = await import("../src/comment-checker/config.js");
	indexMod.__resetCommentCheckerState();
	configMod.__resetCommentCheckerConfigCache();

	const fs = require("node:fs");
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type ContentPart = { type: string; text: string };

class FakePi {
	toolResultHandler: ((event: any, ctx: any) => any) | undefined;
	on(name: string, handler: any) {
		if (name === "tool_result") this.toolResultHandler = handler;
	}
}

function ctx(cwd = tmpHome) {
	return { cwd };
}

async function fireToolResult(toolName: string, input: Record<string, unknown>, opts: { content?: ContentPart[]; details?: unknown; isError?: boolean; cwd?: string } = {}) {
	const mod = await import("../src/comment-checker/index.js");
	const pi = new FakePi();
	mod.default(pi as any);
	if (!pi.toolResultHandler) throw new Error("tool_result handler not registered");
	return pi.toolResultHandler(
		{ type: "tool_result", toolName, toolCallId: "c1", input, content: opts.content ?? [{ type: "text", text: "ok" }], details: opts.details, isError: opts.isError ?? false },
		ctx(opts.cwd),
	);
}

describe("comment-checker detect", () => {
	test("flags a restate-code line comment in a write", async () => {
		const result = await fireToolResult("write", {
			file_path: "src/app.ts",
			content: "let x = 1;\n// increment the counter\nx++;\n",
		});
		expect(result).toBeDefined();
		const text = result.content.map((p: ContentPart) => p.text).join("");
		expect(text).toContain("comment-checker");
		expect(text).toContain("increment the counter");
	});

	test("flags Python-style # comment", async () => {
		const py = await fireToolResult("write", { file_path: "a.py", content: "x = 1\n# simply parse the input\nx + 1\n" });
		expect(py.content.at(-1).text).toContain("comment-checker");
	});

	test("flags SQL -- comment", async () => {
		const sql = await fireToolResult("write", { file_path: "a.sql", content: "SELECT 1;\n-- just fetch the rows\n" });
		expect(sql.content.at(-1).text).toContain("comment-checker");
	});

	test("does not flag TODO/FIXME, license, docstring, pragma, shebang", async () => {
		const result = await fireToolResult("write", {
			file_path: "src/app.ts",
			content: [
				"#!/usr/bin/env node",
				"// SPDX-License-Identifier: MIT",
				"/** Adds two numbers. */",
				"// TODO: handle negative input",
				"// FIXME: race condition",
				"// eslint-disable-next-line no-console",
				"// #pragma once",
				"function add(a, b) { return a + b; }",
			].join("\n"),
		});
		expect(result).toBeUndefined();
	});

	test("does not flag net-unchanged comments in an edit (old_string == new_string comment)", async () => {
		const result = await fireToolResult("edit", {
			file_path: "src/app.ts",
			old_string: "let x = 1;\n// increment the counter\nx++;",
			new_string: "let x = 1;\n// increment the counter\nx += 2;",
		});
		// The comment line is unchanged (present in removed signatures) -> not net-new.
		expect(result).toBeUndefined();
	});

	test("flags a net-new comment added inside an edit", async () => {
		const result = await fireToolResult("edit", {
			file_path: "src/app.ts",
			old_string: "let x = 1;",
			new_string: "let x = 1;\n// here we set the default value\nx = x;",
		});
		expect(result).toBeDefined();
		expect(result.content.at(-1).text).toContain("here we set the default value");
	});

	test("flags apply_patch Add File with slop comments", async () => {
		const patch = ["*** Begin Patch", "*** Add File: src/new.ts", "+let y = 2;", "+// obviously we return here", "+y;", "*** End Patch"].join("\n");
		const result = await fireToolResult("apply_patch", { input: patch });
		expect(result).toBeDefined();
		expect(result.content.at(-1).text).toContain("obviously we return here");
	});

	test("ignore non-mutation tools", async () => {
		const result = await fireToolResult("read", { file_path: "src/app.ts" });
		expect(result).toBeUndefined();
	});

	test("ignore error results", async () => {
		const result = await fireToolResult("write", { file_path: "src/app.ts", content: "x\n// just a note\n" }, { isError: true });
		expect(result).toBeUndefined();
	});

	test("dedup: second nudge within window is suppressed", async () => {
		const first = await fireToolResult("write", { file_path: "a.ts", content: "// simply do it\nx\n" });
		expect(first).toBeDefined();
		const second = await fireToolResult("write", { file_path: "b.ts", content: "// obviously\ny\n" });
		expect(second).toBeUndefined();
	});

	test("disabled via config commentChecker.enabled=false", async () => {
		const fs = require("node:fs");
		const path = require("node:path");
		const dir = path.join(tmpHome, ".config", "pi");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "pi-tools-suite.jsonc"), JSON.stringify({ commentChecker: { enabled: false } }), "utf8");
		const { __resetCommentCheckerConfigCache } = await import("../src/comment-checker/config.js");
		__resetCommentCheckerConfigCache();
		const result = await fireToolResult("write", { file_path: "a.ts", content: "// simply x\ny\n" });
		expect(result).toBeUndefined();
	});

	test("aggressive strictness flags non-essential comments", async () => {
		const fs = require("node:fs");
		const path = require("node:path");
		const dir = path.join(tmpHome, ".config", "pi");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "pi-tools-suite.jsonc"), JSON.stringify({ commentChecker: { strictness: "aggressive" } }), "utf8");
		const { __resetCommentCheckerConfigCache } = await import("../src/comment-checker/config.js");
		__resetCommentCheckerConfigCache();
		const result = await fireToolResult("write", { file_path: "a.ts", content: "x = 1\n# a random remark about x\n" });
		expect(result).toBeDefined();
	});

	test("conservative strictness leaves generic explanations alone", async () => {
		const fs = require("node:fs");
		const path = require("node:path");
		const dir = path.join(tmpHome, ".config", "pi");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "pi-tools-suite.jsonc"), JSON.stringify({ commentChecker: { strictness: "conservative" } }), "utf8");
		const { __resetCommentCheckerConfigCache } = await import("../src/comment-checker/config.js");
		__resetCommentCheckerConfigCache();
		const result = await fireToolResult("write", { file_path: "a.ts", content: "x = 1\n// this function does something\n" });
		expect(result).toBeUndefined();
	});
});

describe("comment-checker detect unit", () => {
	test("detectSlopComments direct", async () => {
		const { detectSlopComments } = await import("../src/comment-checker/detect.js");
		const findings = detectSlopComments(
			[{ filePath: "a.ts", removedLines: [], addedLines: ["x = 1", "// clearly the best", "y = 2"] }],
			"balanced",
		);
		expect(findings.length).toBe(1);
		expect(findings[0].reason).toBe("filler");
	});

	test("multi-language comment body extraction", async () => {
		const { commentBody } = await import("../src/comment-checker/detect.js");
		expect(commentBody("// hello")).toBe("hello");
		expect(commentBody("# python comment")).toBe("python comment");
		expect(commentBody("-- sql comment")).toBe("sql comment");
		expect(commentBody("/* block */")).toBe("block");
		expect(commentBody("code = 1")).toBe(null);
	});
});
