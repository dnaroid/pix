import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { renderToolBlock } from "../src/app/tool-block-renderer.js";
import { THEMES } from "../src/theme.js";
import { renderToolDisplay, type ToolRenderInput } from "../src/tool-renderers/index.js";
import { renderExecTool, renderShellTool } from "../src/tool-renderers/shell.js";
import {
	compactCommand,
	defaultToolRender,
	formatArgsBlock,
	formatArgsInline,
	indent,
	joinSections,
	normalizeToolName,
	numberArg,
	parseArgsText,
	renderWithArgsAndResult,
	resultSection,
	stringArg,
	summarizePatch,
} from "../src/tool-renderers/utils.js";

const input = (overrides: Partial<ToolRenderInput>): ToolRenderInput => ({
	toolName: "tool",
	argsText: "{}",
	output: "",
	isError: false,
	status: "done",
	...overrides,
});

describe("tool renderer utils", () => {
	it("normalizes names and parses arguments", () => {
		assert.equal(normalizeToolName("functions.read"), "read");
		assert.equal(normalizeToolName("/nested/tool"), "tool");
		assert.equal(parseArgsText(""), undefined);
		assert.deepEqual(parseArgsText("{\"a\":1}"), { a: 1 });
		assert.equal(parseArgsText("not json"), "not json");
		assert.equal(stringArg(input({ argsText: "{\"a\":true,\"b\":2,\"c\":\" hi \"}" }), ["missing", "a"]), "true");
		assert.equal(numberArg(input({ argsText: "{\"n\":3,\"bad\":null}" }), ["n"]), 3);
		assert.equal(numberArg(input({ argsText: "[]" }), ["n"]), undefined);
	});

	it("formats inline and block arguments", () => {
		const value = { b: [1, "two", true, null], a: { nested: { deep: { value: 1 } } }, c: undefined };
		assert.equal(formatArgsInline(value, ["a"]), "a: {nested} · b: [1, two, true, +1]");
		assert.match(formatArgsBlock(value), /b:\n  - 1\n  - two/);
		assert.match(formatArgsBlock(value), /nested:\n    \{deep\}/);
		assert.equal(formatArgsBlock([]), "[]");
		assert.equal(formatArgsBlock({}), "(empty)");
		assert.equal(formatArgsInline(null), "");
		assert.equal(formatArgsInline([1, 2, 3, 4]), "[1, 2, 3, +1]");
	});

	it("formats results, patches, and commands", () => {
		assert.equal(indent("a\nb", 3), "   a\n   b");
		assert.equal(joinSections("", "a", " b "), "a\n\n b ");
		assert.equal(joinSections(""), "(empty)");
		assert.equal(resultSection(input({ output: "ok" })), "ok");
		assert.equal(resultSection(input({ output: "bad", isError: true })), "error\nbad");
		assert.equal(resultSection(input({ status: "running" })), "running…");
		assert.equal(compactCommand(" git   diff\n -- src "), "git diff -- src");
		assert.equal(compactCommand(undefined), undefined);
		assert.equal(summarizePatch("*** Update File: a.ts\n--- a/b.ts\n+++ b/b.ts\ndiff --git a/c.ts b/c.ts\nIndex: d.ts\n--- e.ts\n+++ e.ts"), "a.ts, b.ts, c.ts, +2");
		assert.equal(summarizePatch("no files"), undefined);
	});

	it("renders defaults", () => {
		assert.deepEqual(defaultToolRender(input({ argsText: "{\"x\":1}", output: "out" })), {
			headerArgs: "x: 1",
			collapsedBody: "out",
			expandedText: "x: 1\n\nout",
			bodyLineStyles: [{ startLine: 0, endLine: 1, color: "muted" }],
		});
		assert.equal(defaultToolRender(input({ argsText: "{\"x\":1}" })).expandedText, "x: 1");
		assert.equal(defaultToolRender(input({ argsText: "plain" })).collapsedBody, "plain");
		assert.deepEqual(renderWithArgsAndResult(input({ argsText: "{}", status: "running" }), { collapsedBody: "" }), {
			headerArgs: "",
			collapsedBody: "(empty)",
			expandedText: "running…",
		});
	});
});

describe("renderToolDisplay", () => {
	it("renders file reads and maps SKILL.md reads to skill display", () => {
		const read = renderToolDisplay(input({ toolName: "functions.read", argsText: "{\"path\":\"src/a.ts\",\"offset\":2,\"limit\":5}", output: "body" }));
		assert.equal(read.headerArgs, "src/a.ts:2+5");
		assert.equal(read.collapsedBody, "body");
		assert.equal(read.expandedText, "body");
		assert.deepEqual(read.syntaxHighlight, { language: "typescript", startLine: 0, startColumn: 0 });

		const plain = renderToolDisplay(input({ toolName: "read", argsText: "{\"path\":\"notes.txt\"}", output: "body" }));
		assert.equal(plain.syntaxHighlight, undefined);

		const skill = renderToolDisplay(input({ toolName: "read", argsText: "{\"path\":\"/skills/pi-sdk/SKILL.md\"}", output: "skill text" }));
		assert.equal(skill.toolName, "skill");
		assert.equal(skill.headerArgs, "pi-sdk");
		assert.deepEqual(skill.syntaxHighlight, { language: "markdown", startLine: 2, startColumn: 0 });
		assert.match(skill.expandedText, /^\/skills\/pi-sdk\/SKILL\.md\n\nskill text$/);
		assert.deepEqual(skill.bodyLineStyles, [{ startLine: 0, endLine: 1, color: "muted" }]);

		const frontmatterSkill = renderToolDisplay(input({
			toolName: "read",
			argsText: "{\"path\":\"/skills/pi-sdk/SKILL.md\"}",
			output: [
				"---",
				"name: pi-sdk",
				"allowed-tools: Read Bash(node:*) Bash(npm:*) Bash(rg:*) Bash(grep:*)",
				"---",
				"# Pi SDK development",
			].join("\n"),
		}));
		assert.deepEqual(frontmatterSkill.syntaxHighlight, [
			{ language: "yaml", startLine: 2, endLine: 6, startColumn: 0 },
			{ language: "markdown", startLine: 6, startColumn: 0 },
		]);
		const lines = renderToolBlock({
			id: "skill-call",
			toolName: "skill",
			expanded: true,
			status: "done",
			isError: false,
			output: "",
			collapsedBody: "",
			expandedText: frontmatterSkill.expandedText,
			syntaxHighlight: frontmatterSkill.syntaxHighlight,
		}, { previewLines: 3, direction: "head", color: "muted" }, 120, THEMES.dark.colors);
		assert.deepEqual(lines.find((line) => line.text.includes("allowed-tools"))?.syntaxHighlight, { language: "yaml", start: 2 });
		assert.deepEqual(lines.find((line) => line.text.includes("# Pi SDK"))?.syntaxHighlight, { language: "markdown", start: 2 });
	});

	it("shows cwd-contained absolute read paths as relative", () => {
		const cwd = resolve("/tmp/workspace");
		const display = renderToolDisplay(input({
			toolName: "read",
			argsText: JSON.stringify({ path: join(cwd, "src/tool-renderers/read.ts"), offset: 3 }),
			output: "file contents",
			cwd,
		}));

		assert.equal(display.headerArgs, "src/tool-renderers/read.ts:3");
		assert.equal(display.expandedText, "file contents");
	});

	it("keeps absolute read paths outside cwd", () => {
		const display = renderToolDisplay(input({
			toolName: "read",
			argsText: JSON.stringify({ path: "/tmp/other/file.ts" }),
			output: "file contents",
			cwd: "/tmp/workspace",
		}));

		assert.equal(display.headerArgs, "/tmp/other/file.ts");
		assert.equal(display.expandedText, "file contents");
	});

	it("renders shell commands, git diffs, and shell skill reads", () => {
		assert.equal(renderShellTool(input({ toolName: "shell", argsText: "{}" })), undefined);
		assert.equal(renderExecTool(input({ argsText: "{\"a\":1}" }))?.headerArgs, "a: 1");
		const shell = renderToolDisplay(input({ toolName: "shell", argsText: "{\"command\":\"npm   test\"}", output: "ok" }));
		assert.equal(shell.headerArgs, "npm test");
		assert.equal(shell.expandedText, "$ npm test\n\nok");
		assert.deepEqual(shell.bodyLineStyles, [{ startLine: 0, endLine: 1, color: "muted" }]);

		const diff = renderToolDisplay(input({ toolName: "bash", argsText: "{\"command\":\"git diff -- src\"}", output: "diff --git" }));
		assert.equal(diff.bodyStyle, "diff");

		const skill = renderToolDisplay(input({ toolName: "bash", argsText: "{\"command\":\"cat ./skills/demo/SKILL.md\",\"cwd\":\"/repo\"}", output: "text" }));
		assert.equal(skill.toolName, "skill");
		assert.equal(skill.headerArgs, "demo");
		assert.deepEqual(skill.syntaxHighlight, { language: "markdown", startLine: 2, startColumn: 0 });

		const bareSkill = renderToolDisplay(input({ toolName: "shell", argsText: "{\"command\":\"cat SKILL.md\",\"cwd\":\"/repo/current\"}" }));
		assert.equal(bareSkill.headerArgs, "current");
	});

	it("renders apply-patch, ast, repo, web, todo, question, subagents, and fallback tools", () => {
		const patch = renderToolDisplay(input({ toolName: "apply_patch", argsText: JSON.stringify({ input: "*** Add File: a.ts\n+hi" }), output: "done" }));
		assert.equal(patch.headerArgs, "a.ts");
		assert.equal(patch.bodyStyle, "diff");
		assert.equal(patch.expandedText, "*** Add File: a.ts\n+hi\n\ndone");
		assert.equal(renderToolDisplay(input({ toolName: "apply_patch", argsText: JSON.stringify({ input: "*** Add File: a.ts\n+hi" }) })).expandedText, "*** Add File: a.ts\n+hi");
		const write = renderToolDisplay(input({
			toolName: "Write",
			argsText: JSON.stringify({ path: "/repo/test-lsp-error.ts", content: "const value = 1;\n" }),
			output: "Successfully wrote 17 bytes to /repo/test-lsp-error.ts",
			cwd: "/repo",
		}));
		assert.equal(write.headerArgs, "test-lsp-error.ts");
		assert.equal(write.bodyStyle, undefined);
		assert.match(write.expandedText, /^const value = 1;\n\nSuccessfully wrote 17 bytes/);
		assert.match(write.expandedText, /Successfully wrote 17 bytes/);
		assert.deepEqual(write.syntaxHighlight, { language: "typescript", startLine: 0, endLine: 2, startColumn: 0 });
		const edit = renderToolDisplay(input({
			toolName: "Edit",
			argsText: JSON.stringify({ path: "/repo/src/a.ts", edits: [{ oldText: "old", newText: "new" }] }),
			output: "Successfully replaced 1 block(s) in src/a.ts.",
			details: { patch: "Index: src/a.ts\n--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-old\n+new", diff: "-1 old\n+1 new" },
			cwd: "/repo",
		}));
		assert.equal(edit.headerArgs, "src/a.ts");
		assert.match(edit.expandedText, /-1 old\n\+1 new/);
		assert.doesNotMatch(edit.expandedText, /diff\n  -1 old/);
		assert.doesNotMatch(edit.expandedText, /--- src\/a\.ts/);
		assert.doesNotMatch(edit.expandedText, /patch\n  \(empty\)/);
		assert.equal(renderToolDisplay(input({ toolName: "apply_patch", argsText: "{}", output: "done" })).headerArgs, "patch");
		assert.equal(renderToolDisplay(input({ toolName: "read", argsText: "{}" })).expandedText, "(empty)");
		assert.equal(renderToolDisplay(input({ toolName: "read", argsText: "{\"paths\":[{\"nested\":\"SKILL.md\"}]}", output: "skill" })).headerArgs, "skill");
		assert.equal(renderToolDisplay(input({ toolName: "read", argsText: "{\"path\":\"/not-a-skill.txt\"}" })).toolName, undefined);

		assert.equal(renderToolDisplay(input({ toolName: "ast_grep", argsText: "{\"pattern\":\"console.log($A)\"}", output: "match" })).headerArgs, "console.log($A)");
		assert.match(renderToolDisplay(input({ toolName: "repo_search", argsText: "{\"target\":\"auth\",\"maxLines\":10}", status: "running" })).expandedText, /running…/);
		assert.equal(renderToolDisplay(input({ toolName: "web_search", argsText: "{\"query\":\"pi docs\"}", output: "result" })).headerArgs, "pi docs");
		assert.equal(renderToolDisplay(input({ toolName: "web_fetch", argsText: "{\"url\":\"https://example.com\"}" })).headerArgs, "https://example.com");
		assert.equal(renderToolDisplay(input({ toolName: "todo", argsText: "{\"action\":\"create\",\"subject\":\"Test\"}" })).headerArgs, "create · Test");
		const question = renderToolDisplay(input({ toolName: "question", argsText: "{\"questions\":[{},{}]}", output: "asked" }));
		assert.equal(question.headerArgs, "2 questions");
		assert.doesNotMatch(question.expandedText, /questions\n|result\n/);
		assert.deepEqual(question.bodyLineStyles, [{ startLine: 0, endLine: 7, color: "muted" }]);
		assert.equal(renderToolDisplay(input({ toolName: "subagents", argsText: "{\"action\":\"spawn\",\"tasks\":[{}]}", status: "running" })).collapsedBody, "starting 1 subagent");
		// non-spawn actions produce a single-line collapsed body
		assert.doesNotMatch(renderToolDisplay(input({ toolName: "subagents", argsText: "{\"action\":\"status\"}", output: "agent-1: running\nagent-2: completed" })).collapsedBody, /\n/);
		assert.equal(renderToolDisplay(input({ toolName: "subagents", argsText: "{\"action\":\"result\"}", output: "line1\nline2\nline3" })).collapsedBody, "line1");
		assert.equal(renderToolDisplay(input({ toolName: "subagents", argsText: "{\"action\":\"status\"}", output: "" })).collapsedBody, "done");
		assert.equal(renderToolDisplay(input({ toolName: "unknown", argsText: "{\"x\":1}" })).headerArgs, "x: 1");
	});

	it("collapses default-expanded tools to their header line", () => {
		const lines = renderToolBlock({
			id: "edit-call",
			toolName: "apply_patch",
			expanded: false,
			status: "done",
			isError: false,
			output: "changed",
			collapsedBody: "*** Update File: a.ts\n+changed",
			expandedText: "*** Update File: a.ts\n+changed\n\nchanged",
		}, { previewLines: 3, direction: "head", color: "muted", defaultExpanded: true }, 80, THEMES.dark.colors);

		assert.equal(lines.length, 1);
		assert.match(lines[0]?.text ?? "", /apply_patch/);
	});

	it("renders compress summaries", () => {
		const ok = renderToolDisplay(input({ toolName: "compress", argsText: "{\"topic\":\"Cleanup\"}", colors: THEMES.dark.colors, output: JSON.stringify({ tokensSaved: 1200, contextTokens: 8800, contextPercent: 50, contextWindow: 100000, ranges: 1, messages: 2, totalSummaryTokens: 45, activeBlocks: 3, totalBlocks: 5, prunedTools: 2 }) }));
		assert.match(ok.headerArgs ?? "", /Cleanup · saved 1.2K · ████▍ 88% of 10K · context 50% · 3 items/);
		assert.equal(ok.headerArgsSegments?.length, 5);
		assert.equal(ok.headerArgsSegments?.[0]?.foreground, THEMES.dark.colors.muted);
		assert.equal(ok.collapsedBody, "");

		const withToolColor = renderToolDisplay(input({ toolName: "compress", colors: THEMES.dark.colors, toolColor: THEMES.dark.colors.info, output: JSON.stringify({ tokensSaved: 1200, contextTokens: 8800 }) }));
		assert.equal(withToolColor.headerArgsSegments?.[0]?.foreground, THEMES.dark.colors.info);

		assert.match(renderToolDisplay(input({ toolName: "compress", output: "boom", isError: true })).headerArgs ?? "", /error: boom/);
		assert.equal(renderToolDisplay(input({ toolName: "compress", status: "running" })).expandedText, "running…");
		assert.equal(renderToolDisplay(input({ toolName: "compress", output: "not json" })).headerArgs, "not json");
	});
});
