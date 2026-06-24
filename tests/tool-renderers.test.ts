import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { renderToolBlock } from "../src/app/rendering/tool-block-renderer.js";
import { THEMES } from "../src/theme.js";
import { renderToolDisplay, type ToolRenderInput } from "../src/tool-renderers/index.js";
import { normalizeBeginPatchForDisplay } from "../src/tool-renderers/patch-normalize.js";
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
		assert.equal(skill.bodyLineStyles, undefined);

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
		assert.equal(shell.bodyLineStyles, undefined);

		const diff = renderToolDisplay(input({ toolName: "bash", argsText: "{\"command\":\"git diff -- src\"}", output: "diff --git" }));
		assert.equal(diff.bodyStyle, "diff");

		const skill = renderToolDisplay(input({ toolName: "bash", argsText: "{\"command\":\"cat ./skills/demo/SKILL.md\",\"cwd\":\"/repo\"}", output: "text" }));
		assert.equal(skill.toolName, "skill");
		assert.equal(skill.headerArgs, "demo");
		assert.deepEqual(skill.syntaxHighlight, { language: "markdown", startLine: 2, startColumn: 0 });

		const bareSkill = renderToolDisplay(input({ toolName: "shell", argsText: "{\"command\":\"cat SKILL.md\",\"cwd\":\"/repo/current\"}" }));
		assert.equal(bareSkill.headerArgs, "current");

		const pythonEditCommand = [
			"python3 - <<'PY'",
			"from pathlib import Path",
			"Path('/repo/.pi/skills/demo/SKILL.md').write_text('updated')",
			"PY",
		].join("\n");
		const pythonEdit = renderToolDisplay(input({
			toolName: "shell",
			argsText: JSON.stringify({ command: pythonEditCommand }),
			output: "done",
		}));
		assert.equal(pythonEdit.toolName, undefined);
		assert.match(pythonEdit.headerArgs ?? "", /^python3 - <<'PY'/);
		const redirectedWrite = renderToolDisplay(input({
			toolName: "bash",
			argsText: JSON.stringify({ command: "cat > /repo/.pi/skills/demo/SKILL.md" }),
			output: "",
		}));
		assert.equal(redirectedWrite.toolName, undefined);
		assert.equal(redirectedWrite.headerArgs, "cat > /repo/.pi/skills/demo/SKILL.md");
		const sedEdit = renderToolDisplay(input({
			toolName: "bash",
			argsText: JSON.stringify({ command: "sed -i '' 's/a/b/' /repo/.pi/skills/demo/SKILL.md" }),
			output: "",
		}));
		assert.equal(sedEdit.toolName, undefined);
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
		const skillWrite = renderToolDisplay(input({
			toolName: "Write",
			argsText: JSON.stringify({ path: "/repo/.pi/skills/demo/SKILL.md", content: "---\nname: demo\n---\n" }),
			output: "Successfully wrote 22 bytes to /repo/.pi/skills/demo/SKILL.md",
			cwd: "/repo",
		}));
		assert.equal(skillWrite.toolName, undefined);
		assert.equal(skillWrite.headerArgs, ".pi/skills/demo/SKILL.md");
		const skillEdit = renderToolDisplay(input({
			toolName: "Edit",
			argsText: JSON.stringify({ path: "/repo/.pi/skills/demo/SKILL.md", edits: [{ oldText: "old", newText: "new" }] }),
			output: "Successfully replaced 1 block(s) in .pi/skills/demo/SKILL.md.",
			cwd: "/repo",
		}));
		assert.equal(skillEdit.toolName, undefined);
		assert.equal(skillEdit.headerArgs, ".pi/skills/demo/SKILL.md");
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
		assert.equal(question.bodyLineStyles, undefined);
		const answeredQuestion = renderToolDisplay(input({
			toolName: "question",
			argsText: JSON.stringify({ questions: [
				{ id: "scope", label: "Scope", prompt: "What should be tested?", choices: [{ value: "unit", label: "Unit", description: "fast" }] },
				{ id: "priority", prompt: "Priority?", choices: [{ value: "high" }] },
			] }),
			details: { answers: [{ id: "scope", label: "Unit", index: 1 }, { id: "priority", label: "Custom", wasCustom: true }] },
		}));
		assert.equal(answeredQuestion.headerArgs, "2 questions · Scope, priority");
		assert.match(answeredQuestion.expandedText, /What should be tested\?/u);
		assert.match(answeredQuestion.expandedText, /Something else/u);
		assert.match(answeredQuestion.collapsedBody, /✓ Scope: Unit \(choice 1\)/u);
		assert.match(answeredQuestion.collapsedBody, /custom answer/u);
		assert.equal(renderToolDisplay(input({
			toolName: "question",
			argsText: JSON.stringify({ questions: [{ id: "q1", prompt: "Continue?", choices: [] }] }),
			details: { canceled: true, reason: "timeout", fallbackPrompt: "Use defaults" },
		})).collapsedBody, "⚠ canceled: timeout\n\nUse defaults");
		assert.equal(renderToolDisplay(input({ toolName: "question", argsText: JSON.stringify({ questions: [] }), details: { answers: [] } })).collapsedBody, "question returned no answers");
		assert.equal(renderToolDisplay(input({ toolName: "question", argsText: "{}", status: "running" })).expandedText, "running…");
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
		assert.ok(ok.headerArgSegments?.every((segment) => segment.background === THEMES.dark.colors.statusDotBase), "progress segments should carry the track background");
		assert.ok(ok.headerArgSegments?.every((segment) => segment.foreground === THEMES.dark.colors.statusForeground), "compress progress bar should keep the neutral header foreground");
		assert.equal(ok.collapsedBody, "");
		const lines = renderToolBlock({
			id: "compress-call",
			toolName: "compress",
			headerArgs: ok.headerArgs,
			headerArgSegments: ok.headerArgSegments,
			expanded: false,
			status: "done",
			isError: false,
			output: "",
			collapsedBody: "",
			expandedText: "",
		}, { previewLines: 0, direction: "head", color: "muted" }, 120, THEMES.dark.colors);
		const barStart = lines[0]?.text.indexOf("████") ?? -1;
		assert.ok(lines[0]?.segments?.some((segment) => segment.start === barStart && segment.background === THEMES.dark.colors.statusDotBase), "rendered progress bar should keep its background");
		assert.equal(lines[0]?.segments?.some((segment) => segment.background !== THEMES.dark.colors.statusDotBase && segment.start <= barStart && segment.end > barStart), false, "generic header args color should not cover the progress bar before its background segment is applied");

		assert.match(renderToolDisplay(input({ toolName: "compress", output: "boom", isError: true })).headerArgs ?? "", /error: boom/);
		assert.equal(renderToolDisplay(input({ toolName: "compress", status: "running" })).expandedText, "running…");
		assert.equal(renderToolDisplay(input({ toolName: "compress", output: "not json" })).headerArgs, "not json");
	});
});

describe("normalizeBeginPatchForDisplay", () => {
	it("collapses loose before/after blocks into a single addition", () => {
		// A patch that effectively only adds one rule, but the model emitted the
		// whole block as a `-`/`+` before/after pair (loose matching).
		const loose = [
			"*** Begin Patch",
			"*** Update File: CLAUDE.md",
			"@@",
			"- rule one",
			"- rule two",
			"- rule three",
			"+ rule one",
			"+ rule two",
			"+ rule three",
			"+ new rule",
			"*** End Patch",
		].join("\n");

		const normalized = normalizeBeginPatchForDisplay(loose);
		assert.deepEqual(normalized.split("\n"), [
			"*** Begin Patch",
			"*** Update File: CLAUDE.md",
			"@@",
			"  rule one",
			"  rule two",
			"  rule three",
			"+ new rule",
			"*** End Patch",
		]);
	});

	it("keeps a marker column for indented unchanged loose context", () => {
		const loose = [
			"*** Begin Patch",
			"*** Update File: tests/example.py",
			"@@",
			"-    assert before == 1",
			"+    assert before == 1",
			"+    assert after == 2",
			"*** End Patch",
		].join("\n");

		assert.deepEqual(normalizeBeginPatchForDisplay(loose).split("\n"), [
			"*** Begin Patch",
			"*** Update File: tests/example.py",
			"@@",
			"     assert before == 1",
			"+    assert after == 2",
			"*** End Patch",
		]);
	});

	it("keeps a real deletion as a deletion", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: a.ts",
			"@@",
			"- removed line",
			"*** End Patch",
		].join("\n");

		assert.equal(normalizeBeginPatchForDisplay(patch), patch);
	});

	it("keeps a real modification as deletion + addition", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: a.ts",
			"@@",
			"- old value",
			"+ new value",
			"*** End Patch",
		].join("\n");

		assert.equal(normalizeBeginPatchForDisplay(patch), patch);
	});

	it("preserves explicit context lines and interleaved edits", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: a.ts",
			"@@",
			" context before",
			"- old",
			"+ new",
			" context after",
			"*** End Patch",
		].join("\n");

		assert.equal(normalizeBeginPatchForDisplay(patch), patch);
	});

	it("leaves plain unified diffs and Add/Delete files untouched", () => {
		const unified = [
			"diff --git a/a.ts b/a.ts",
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n");
		assert.equal(normalizeBeginPatchForDisplay(unified), unified);

		const addFile = [
			"*** Begin Patch",
			"*** Add File: new.ts",
			"+line one",
			"+line two",
			"*** End Patch",
		].join("\n");
		assert.equal(normalizeBeginPatchForDisplay(addFile), addFile);

		const noMarker = "*** Update File: a.ts\n+hi";
		assert.equal(normalizeBeginPatchForDisplay(noMarker), noMarker);
	});

	it("renders an add-only loose Begin Patch without spurious deletions", () => {
		const colors = THEMES.dark.colors;
		const loose = [
			"*** Begin Patch",
			"*** Update File: CLAUDE.md",
			"@@",
			"- rule one",
			"- rule two",
			"+ rule one",
			"+ rule two",
			"+ new rule",
			"*** End Patch",
		].join("\n");

		const display = renderToolDisplay(input({ toolName: "apply_patch", argsText: JSON.stringify({ input: loose }), output: "done" }));
		assert.equal(display.bodyStyle, "diff");

		const lines = renderToolBlock({
			id: "patch-1",
			toolName: "apply_patch",
			expanded: true,
			status: "done",
			isError: false,
			output: "",
			collapsedBody: display.collapsedBody,
			expandedText: display.expandedText,
			bodyStyle: "diff",
		}, { previewLines: 9999, direction: "head", color: "muted" }, 100, colors);

		// The added line is green.
		const addedLine = lines.find((line) => line.text.includes("new rule"));
		assert.ok(addedLine, "added line should be rendered");
		assert.ok(addedLine?.segments?.some((segment) => segment.foreground === colors.success), "added line should be colored as success");

		// The unchanged neighbor lines must NOT be colored as deletions.
		const neighborLine = lines.find((line) => line.text.includes("rule one") && !line.text.includes("rule two"));
		assert.ok(neighborLine, "neighbor line should be rendered");
		const neighborRed = neighborLine?.segments?.find((segment) => segment.foreground === colors.error);
		assert.equal(neighborRed, undefined, "unchanged neighbor line should not be rendered as a deletion");

		// No line in the body should be red (no deletions remain).
		const anyDeletion = lines.some((line) => line.segments?.some((segment) => segment.foreground === colors.error));
		assert.equal(anyDeletion, false, "add-only patch should render no deletions");
	});

	it("still renders real deletions red in a Begin Patch", () => {
		const colors = THEMES.dark.colors;
		const patch = [
			"*** Begin Patch",
			"*** Update File: a.ts",
			"@@",
			"- real removal",
			"+ real addition",
			"*** End Patch",
		].join("\n");

		const display = renderToolDisplay(input({ toolName: "apply_patch", argsText: JSON.stringify({ input: patch }), output: "done" }));
		const lines = renderToolBlock({
			id: "patch-2",
			toolName: "apply_patch",
			expanded: true,
			status: "done",
			isError: false,
			output: "",
			collapsedBody: display.collapsedBody,
			expandedText: display.expandedText,
			bodyStyle: "diff",
		}, { previewLines: 9999, direction: "head", color: "muted" }, 100, colors);

		const removal = lines.find((line) => line.text.includes("real removal"));
		assert.ok(removal?.segments?.some((segment) => segment.foreground === colors.error), "real removal should be red");
		const addition = lines.find((line) => line.text.includes("real addition"));
		assert.ok(addition?.segments?.some((segment) => segment.foreground === colors.success), "real addition should be green");
	});
});
