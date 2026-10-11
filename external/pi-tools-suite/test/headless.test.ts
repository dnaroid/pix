import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHATGPT_HEADLESS_MODEL, createHeadlessToolApi } from "../src/headless/api.js";

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
	test("models ChatGPT as GPT/Codex, not as the default Claude profile", async () => workspace(async (root) => {
		const api = await createHeadlessToolApi({ cwd: root });
		const inventory = api.inventory();
		expect(inventory.model).toEqual(CHATGPT_HEADLESS_MODEL);
		expect(inventory.profile).toBe("codex");
		expect(inventory.nativeTools).toEqual(["read", "shell", "apply_patch"]);
		expect(inventory.tools.map((tool) => tool.name)).toEqual(["ast_grep", "project_search", "project_tasks"]);
		expect(inventory.tools.every((tool) => tool.readOnly)).toBe(true);
		expect(inventory.tools.find((tool) => tool.name === "project_tasks")?.inputSchema.properties?.op.enum)
			.toEqual(["list", "get"]);
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
			.rejects.toThrow("escapes selected project");
		await expect(api.execute("ast_grep", { pattern: "secret", lang: "ts", paths: ["linked.ts"] }))
			.rejects.toThrow("escapes selected project");
		await expect(api.execute("ast_grep", { pattern: "hello", lang: "ts", follow: true }))
			.rejects.toThrow("--follow");
		expect(await readFile(path.join(root, "test.ts"), "utf8")).toContain("return 42");
	}));

	test("project_search cannot escape workspace through projectPath", async () => workspace(async (root) => {
		const api = await createHeadlessToolApi({ cwd: root });
		await expect(api.execute("project_search", { query: "hello", projectPath: "..", indexMode: "lexical" }))
			.rejects.toThrow("projectPath is disabled");
		const tasks = await api.execute("project_tasks", { op: "list" });
		expect(tasks.content[0]?.text).toContain('"op":"list"');
	}));
});
