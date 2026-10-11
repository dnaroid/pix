import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHATGPT_HEADLESS_MODEL, assertHeadlessSubagentSpawn, createHeadlessToolApi, headlessSubagentsDescription, needsHeadlessModelRegistry, createHeadlessModelRegistry } from "../src/headless/api.js";
import { TODO_TOOL_DESCRIPTION } from "../src/tool-descriptions.js";

async function workspace(run: (root: string, outside: string) => Promise<void>): Promise<void> {
	const scratch = await mkdtemp(path.join(tmpdir(), "pix-headless-test-"));
	const root = path.join(scratch, "project");
	const outside = path.join(scratch, "outside.ts");
	try {
		await mkdir(root);
		await writeFile(path.join(root, "test.ts"), "function hello() { return 42; }\n");
		await writeFile(outside, "function secret() { return 1; }\n");
		await symlink(outside, path.join(root, "linked.ts"));
		await run(root, outside);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

describe("headless Pix tool API", () => {
	test("loads model availability for visual spawns only, without a parent Pi agent", async () => {
		expect(needsHeadlessModelRegistry("subagents", { action: "spawn", tasks: [
			{ task: "Visual QA", subagentType: "ui-qa" },
		] })).toBe(true);
		expect(needsHeadlessModelRegistry("subagents", { action: "spawn", tasks: [
			{ task: "Inspect image", subagentType: "research", imagePaths: ["test.png"] },
		] })).toBe(true);
		expect(needsHeadlessModelRegistry("subagents", { action: "spawn", tasks: [
			{ task: "Investigate", subagentType: "research" },
		] })).toBe(false);
		expect(needsHeadlessModelRegistry("subagents", { action: "status", tasks: [
			{ subagentType: "ui-qa" },
		] })).toBe(false);
		expect(needsHeadlessModelRegistry("todo", { action: "create", tasks: [
			{ subagentType: "ui-qa" },
		] })).toBe(false);
		const controller = new AbortController();
		controller.abort();
		await expect(createHeadlessModelRegistry(controller.signal)).rejects.toThrow();
	});

	test("publishes original Pix descriptions, with only headless subagent caveats adapted", async () => workspace(async (root) => {
		const api = await createHeadlessToolApi({ cwd: root, readOnly: false });
		const inventory = api.inventory();
		expect("instructions" in inventory).toBe(false);
		const descriptions = new Map(inventory.tools.map((tool) => [tool.name, tool.description]));
		expect(descriptions.get("todo")).toBe(TODO_TOOL_DESCRIPTION.description);
		expect(descriptions.get("ast_grep")).toContain("MANDATORY ROUTING");
		const subagents = inventory.tools.find((tool) => tool.name === "subagents");
		expect((subagents?.inputSchema.properties as any).tasks.items.required)
			.toContain("subagentType");
		const roleDescription = (subagents?.inputSchema.properties as any).tasks.items.properties.subagentType.description;
		expect(roleDescription).toContain("Required for headless spawn");
		expect(roleDescription).not.toContain("Omit subagentType only");
		const delegated = descriptions.get("subagents") ?? "";
		expect(delegated).toContain("every spawn task must include an explicit subagentType from subagents_catalog");
		expect(delegated).toContain("automatic LLM role routing are unavailable");
		expect(delegated).toContain("ChatGPT MCP receives no automatic sub-agent completion follow-ups");
		expect(delegated).toContain("use a separate wait call");
		expect(delegated).not.toContain("Omit subagentType only when unsure");
		expect(delegated).not.toContain("the LLM router handles omissions only");
		expect(delegated).not.toContain("Parent sessions receive completion/failure follow-ups");
		expect(() => headlessSubagentsDescription("Upstream contract changed")).toThrow(
			"description changed; audit its headless guidance",
		);
		expect(() => assertHeadlessSubagentSpawn({
			action: "spawn", tasks: [{ id: "missing-role", task: "Do not launch anything" }],
		})).toThrow("tasks[0].subagentType");
		await expect(api.execute("subagents", {
			action: "spawn", tasks: [{ id: "missing-role", task: "Do not launch anything" }],
		})).rejects.toThrow("tasks[0].subagentType");
		expect(() => assertHeadlessSubagentSpawn({ action: "status" })).not.toThrow();
	}));

	test("models ChatGPT as GPT/Codex, not as the default Claude profile", async () => workspace(async (root) => {
		const api = await createHeadlessToolApi({ cwd: root });
		const inventory = api.inventory();
		expect(inventory.model).toEqual(CHATGPT_HEADLESS_MODEL);
		expect(inventory.profile).toBe("codex");
		expect(inventory.nativeTools).toEqual(["read", "shell", "apply_patch"]);
		expect(inventory.tools.map((tool) => tool.name)).toEqual([
			"ast_grep", "project_search", "project_tasks", "todo", "subagents_catalog", "read",
		]);
		expect(inventory.tools.every((tool) => tool.readOnly)).toBe(true);
		expect(inventory.tools.find((tool) => tool.name === "project_tasks")?.inputSchema.properties?.op.enum)
			.toEqual(["list", "get"]);
		expect((await api.execute("read", { path: "test.ts" })).content[0]).toMatchObject({
			type: "text", text: expect.stringContaining("hello"),
		});
		// macOS can supply an equivalent absolute /var path while cwd has been
		// canonicalized to /private/var. Both must resolve to the selected root.
		expect((await api.execute("read", { path: path.join(root, "test.ts") })).content[0]).toMatchObject({
			type: "text", text: expect.stringContaining("hello"),
		});
		await expect(api.execute("read", { path: "../outside.ts" }))
			.rejects.toThrow("escapes selected workspace");
		await expect(api.execute("read", { path: "linked.ts" }))
			.rejects.toThrow("escapes selected workspace");
		await expect(api.execute("shell", { command: "echo hi" }))
			.rejects.toThrow("not available");
		const claude = await createHeadlessToolApi({ cwd: root, model: { provider: "anthropic", id: "claude-sonnet" } });
		expect(claude.inventory().profile).toBe("claude");
		expect(claude.inventory().nativeTools).toContain("Read");
		expect(claude.inventory().nativeTools).toContain("Bash");
		expect(claude.inventory().nativeTools).not.toContain("shell");
	}));

	test("uses the real Pix AST engine and enforces read-only restrictions", async () => workspace(async (root, outside) => {
		const api = await createHeadlessToolApi({ cwd: root });
		const result = await api.execute("ast_grep", { pattern: "function $NAME() { return $VALUE; }", lang: "ts", paths: ["test.ts"] });
		expect(result.isError).not.toBe(true);
		expect(result.content[0]?.text).toContain("hello");
		await expect(api.execute("ast_apply", { pattern: "return 42", lang: "ts", paths: ["test.ts"] }))
			.rejects.toThrow("not available");
		await expect(api.execute("project_tasks", { op: "create", type: "todo", title: "no" }))
			.rejects.toThrow("read-only");
		await expect(api.execute("ast_grep", { pattern: "secret", lang: "ts", paths: [outside] }))
			.rejects.toThrow("escapes selected workspace");
		await expect(api.execute("ast_grep", { pattern: "secret", lang: "ts", paths: ["linked.ts"] }))
			.rejects.toThrow("escapes selected workspace");
		await expect(api.execute("ast_grep", { pattern: "hello", lang: "ts", follow: true }))
			.rejects.toThrow("--follow");
		expect(await readFile(path.join(root, "test.ts"), "utf8")).toContain("return 42");
	}));

	test("executes Pix's actual GPT shell/apply_patch tools with the selected cwd", async () => workspace(async (root, outside) => {
		const api = await createHeadlessToolApi({ cwd: root, readOnly: false });
		expect(api.inventory().tools.map((tool) => tool.name)).toEqual([
			"ast_grep", "ast_apply", "project_search", "project_tasks", "todo", "subagents", "subagents_catalog",
			"read", "shell", "apply_patch",
		]);
		const shell = await api.execute("shell", { command: 'node -p "require(\'node:fs\').readFileSync(\'test.ts\', \'utf8\')"' });
		expect(shell.isError).not.toBe(true);
		expect(shell.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("function hello() { return 42; }") });
		const patch = await api.execute("apply_patch", { input: [
			"*** Begin Patch", "*** Update File: test.ts", "@@",
			"-function hello() { return 42; }", "+function hello() { return 43; }",
			"*** End Patch",
		].join("\n") });
		expect(patch.isError).not.toBe(true);
		expect(await readFile(path.join(root, "test.ts"), "utf8")).toContain("return 43");
		await expect(api.execute("apply_patch", { input: [
			"*** Begin Patch", "*** Update File: linked.ts", "@@",
			"-function secret() { return 1; }", "+function secret() { return 2; }",
			"*** End Patch",
		].join("\n") })).rejects.toThrow("escapes selected workspace");
		await expect(api.execute("apply_patch", { input: [
			"--- a/../outside.ts", "+++ b/../outside.ts", "@@ -1 +1 @@",
			"-function secret() { return 1; }", "+function secret() { return 2; }",
		].join("\n") })).rejects.toThrow("escapes selected workspace");
		expect(await readFile(outside, "utf8")).toContain("return 1");
		await expect(api.execute("project_tasks", { op: "update", id: "123", status: "done" }))
			.rejects.toThrow("read-only");
	}));

	test("project_search cannot escape workspace through projectPath", async () => workspace(async (root) => {
		const api = await createHeadlessToolApi({ cwd: root });
		await expect(api.execute("project_search", { query: "hello", projectPath: "..", indexMode: "lexical" }))
			.rejects.toThrow("projectPath is disabled");
		const tasks = await api.execute("project_tasks", { op: "list" });
		expect(tasks.content[0]?.text).toContain('"op":"list"');
	}));
});
