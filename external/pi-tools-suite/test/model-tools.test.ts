import { afterEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createTypeboxMock } from "./support/typebox-mock.js";

mock.module("typebox", () => createTypeboxMock());

const builtinExecutions: Array<{ name: string; args: any; cwd: string }> = [];

function builtin(name: string) {
	return (cwd: string) => ({
		execute: async (_id: string, args: any) => {
			builtinExecutions.push({ name, args, cwd });
			return { content: [{ type: "text", text: `${name} ok` }], details: { args } };
		},
		renderCall: (args: any) => ({ text: `${name} ${JSON.stringify(args)}`, children: [] }),
		renderResult: (result: any) => ({ text: `${name} ${JSON.stringify(result)}`, children: [] }),
	});
}

mock.module("@earendil-works/pi-coding-agent", () => ({
	defineTool: (tool: any) => tool,
	withFileMutationQueue: async (_key: string, fn: () => Promise<unknown>) => fn(),
	createReadToolDefinition: builtin("read"),
	createEditToolDefinition: builtin("edit"),
	createWriteToolDefinition: builtin("write"),
	createBashToolDefinition: builtin("bash"),
	createGrepToolDefinition: builtin("grep"),
	createFindToolDefinition: builtin("find"),
	createLsToolDefinition: builtin("ls"),
}));

class FakePi {
	tools = new Map<string, any>();
	handlers = new Map<string, any>();
	activeTools: string[] = ["read", "bash", "custom"];
	setCalls: string[][] = [];
	registerTool(tool: any) { this.tools.set(tool.name, tool); }
	on(name: string, handler: any) { this.handlers.set(name, handler); }
	getActiveTools() { return this.activeTools; }
	setActiveTools(tools: string[]) { this.setCalls.push(tools); this.activeTools = tools; }
}

const tempDirs: string[] = [];
const originalPreserveSelection = process.env.PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION;
function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-tools-test-"));
	tempDirs.push(dir);
	return dir;
}

async function expectRejectsWithMessage(promise: Promise<unknown>, message: string): Promise<void> {
	try {
		await promise;
	} catch (error) {
		expect(error instanceof Error ? error.message : String(error)).toContain(message);
		return;
	}
	throw new Error(`Expected rejection containing ${message}`);
}

afterEach(() => {
	builtinExecutions.length = 0;
	if (originalPreserveSelection === undefined) delete process.env.PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION;
	else process.env.PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION = originalPreserveSelection;
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.serial("model tools", () => {
	test.serial("exports argument adapters and model profile detection", async () => {
		const { detectModelProfile, prepareApplyPatchArgs, selectSuitableToolsForModel, toGrepArgs, toShellCommand } = await import("../src/model-tools/index.js");
		expect(detectModelProfile({ provider: "anthropic", id: "claude-4" })).toBe("claude");
		expect(detectModelProfile({ provider: "openai", id: "o4-mini" })).toBe("codex");
		expect(detectModelProfile("openai-codex/gpt-5.5")).toBe("codex");
		expect(detectModelProfile({ provider: "zai", id: "glm-5-turbo" })).toBe("claude");
		expect(detectModelProfile({ id: "other" })).toBe("claude");
		expect(detectModelProfile(undefined)).toBe("claude");
		expect(selectSuitableToolsForModel("zai/glm-5-turbo", ["read", "grep", "bash", "apply_patch"])).toEqual(["Read", "Grep", "Bash"]);
		expect(selectSuitableToolsForModel("openai-codex/gpt-5.5", ["Read", "Grep", "Edit", "Bash"])).toEqual(["read", "shell", "apply_patch"]);
		expect(toGrepArgs({ pattern: "x", case_sensitive: false, regex: true, before_context: 2, max_count: 5 })).toMatchObject({ pattern: "x", ignoreCase: true, literal: false, context: 2, limit: 5 });
		expect(toShellCommand({ command: "  echo hi  " })).toBe("echo hi");
		expect(prepareApplyPatchArgs("*** Begin Patch\n*** End Patch")).toEqual({ input: "*** Begin Patch\n*** End Patch" });
		expect(prepareApplyPatchArgs({ patch: "p" })).toEqual({ input: "p" });
	});

	test.serial("registers aliases, adapts executions, and switches active tools by model", async () => {
		const { default: register } = await import("../src/model-tools/index.js");
		const pi = new FakePi();
		register(pi as any);
		expect([...pi.tools.keys()].sort()).toEqual(["Bash", "Edit", "Glob", "Grep", "Read", "Write", "apply_patch", "shell"]);

		const cwd = tempDir();
		await pi.tools.get("Read").execute("call", { file_path: "a.ts", offset: 2 }, undefined, undefined, { cwd });
		expect(builtinExecutions[builtinExecutions.length - 1]).toMatchObject({ name: "read", args: { path: "a.ts", offset: 2 } });
		await pi.tools.get("Grep").execute("call", { pattern: "foo", path: "src", glob: "*.ts", regex: false }, undefined, undefined, { cwd });
		expect(builtinExecutions[builtinExecutions.length - 1]).toMatchObject({ name: "grep", args: { pattern: "foo", path: "src", glob: "*.ts", literal: true } });
		await expectRejectsWithMessage(pi.tools.get("Edit").execute("call", { file_path: "a", old_string: "x", new_string: "y", replace_all: true }, undefined, undefined, { cwd }), "replace_all");
		await expectRejectsWithMessage(pi.tools.get("Bash").execute("call", { command: "echo hi", run_in_background: true }, undefined, undefined, { cwd }), "run_in_background");
		await pi.tools.get("shell").execute("call", { command: "  echo hi  ", timeout_ms: 2500 }, undefined, undefined, { cwd });
		expect(builtinExecutions[builtinExecutions.length - 1]).toMatchObject({ name: "bash", args: { command: "echo hi", timeout: 3 } });

		pi.handlers.get("session_start")({}, { model: { id: "claude-sonnet" } });
		expect(pi.activeTools).toEqual(["custom", "Read", "Edit", "Write", "Bash", "Grep", "Glob"]);
		pi.handlers.get("model_select")({ model: { provider: "openai", id: "gpt-5" } });
		expect(pi.activeTools).toEqual(["custom", "read", "shell", "apply_patch"]);
		pi.handlers.get("model_select")({ model: { provider: "zai", id: "glm-5-turbo" } });
		expect(pi.activeTools).toEqual(["custom", "Read", "Edit", "Write", "Bash", "Grep", "Glob"]);
		pi.handlers.get("model_select")({ model: { id: "unknown" } });
		expect(pi.activeTools).toEqual(["custom", "Read", "Edit", "Write", "Bash", "Grep", "Glob"]);
	});

	test.serial("keeps active repo discovery tools ahead of lower-level profile tools", async () => {
		const { default: register } = await import("../src/model-tools/index.js");
		const { REPO_DISCOVERY_TOOL_NAMES } = await import("../src/tool-descriptions.js");
		const pi = new FakePi();
		pi.activeTools = ["read", "custom", ...REPO_DISCOVERY_TOOL_NAMES, "bash"];

		register(pi as any);
		pi.handlers.get("session_start")({}, { model: { id: "claude-sonnet" } });
		expect(pi.activeTools).toEqual([...REPO_DISCOVERY_TOOL_NAMES, "custom", "Read", "Edit", "Write", "Bash", "Grep", "Glob"]);

		pi.handlers.get("model_select")({ model: { provider: "openai", id: "gpt-5" } });
		expect(pi.activeTools).toEqual([...REPO_DISCOVERY_TOOL_NAMES, "custom", "read", "shell", "apply_patch"]);

		pi.handlers.get("model_select")({ model: { provider: "zai", id: "glm-5-turbo" } });
		expect(pi.activeTools).toEqual([...REPO_DISCOVERY_TOOL_NAMES, "custom", "Read", "Edit", "Write", "Bash", "Grep", "Glob"]);

		pi.handlers.get("model_select")({ model: { id: "unknown" } });
		expect(pi.activeTools).toEqual([...REPO_DISCOVERY_TOOL_NAMES, "custom", "Read", "Edit", "Write", "Bash", "Grep", "Glob"]);
	});

	test.serial("can preserve a narrowed managed tool selection while switching names for the model", async () => {
		process.env.PI_MODEL_SUITABLE_TOOLS_PRESERVE_SELECTION = "1";
		const { default: register } = await import("../src/model-tools/index.js");
		const pi = new FakePi();
		pi.activeTools = ["read", "grep", "custom"];
		register(pi as any);

		pi.handlers.get("session_start")({}, { model: { provider: "zai", id: "glm-5-turbo" } });
		expect(pi.activeTools).toEqual(["custom", "Read", "Grep"]);

		pi.activeTools = ["Read", "Grep", "Edit", "custom"];
		pi.handlers.get("model_select")({ model: { provider: "openai", id: "gpt-5" } });
		expect(pi.activeTools).toEqual(["custom", "read", "shell", "apply_patch"]);
	});

	test.serial("apply_patch creates, updates, moves, and deletes files", async () => {
		const { applyPatch, parseApplyPatch } = await import("../src/model-tools/index.js");
		const cwd = tempDir();
		const patch = `*** Begin Patch
*** Add File: a.txt
+hello
*** Update File: a.txt
@@
-hello
+hello world
*** Update File: a.txt
*** Move to: b.txt
@@
-hello world
+moved
*** Delete File: obsolete.txt
*** End Patch`;
		fs.writeFileSync(path.join(cwd, "obsolete.txt"), "old\n");
		expect(parseApplyPatch(patch)).toHaveLength(4);
		const result = await applyPatch(cwd, patch);
		expect(result.changedFiles.sort()).toEqual(["a.txt", "b.txt", "obsolete.txt"]);
		expect(fs.existsSync(path.join(cwd, "a.txt"))).toBe(false);
		expect(fs.readFileSync(path.join(cwd, "b.txt"), "utf8")).toBe("moved\n");
		expect(fs.existsSync(path.join(cwd, "obsolete.txt"))).toBe(false);
	});

	test.serial("apply_patch applies unified diffs", async () => {
		const { applyPatch } = await import("../src/model-tools/index.js");
		const cwd = tempDir();
		fs.writeFileSync(path.join(cwd, "unified.txt"), "before\nold\nafter\n");

		const result = await applyPatch(cwd, `diff --git a/unified.txt b/unified.txt
--- a/unified.txt
+++ b/unified.txt
@@ -1,3 +1,3 @@
 before
-old
+new
 after
`);

		expect(result.changedFiles).toEqual(["unified.txt"]);
		expect(result.summary).toContain("M unified.txt");
		expect(fs.readFileSync(path.join(cwd, "unified.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("before\nnew\nafter\n");
	});
});
