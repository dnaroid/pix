import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import repoDiscoveryExtension, { truncateOutput } from "../src/repo-discovery/index.js";

type RegisteredTool = {
	name: string;
	execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: { cwd: string }) => Promise<{ content: Array<{ text: string }> }>;
};

describe("repo discovery output truncation", () => {
	test("keeps top lines when the line limit is exceeded", () => {
		const result = truncateOutput("one\ntwo\nthree", 2, 1_000);

		expect(result.text).toContain("one\ntwo\n\n[Output truncated from the bottom:");
		expect(result.text).not.toContain("three");
		expect(result.truncation).toMatchObject({
			truncated: true,
			totalLines: 3,
			outputLines: 2,
		});
	});

	test("keeps complete top lines when the byte limit is exceeded", () => {
		const result = truncateOutput("alpha\nbeta\ngamma", 10, 10);

		expect(result.text).toContain("alpha\nbeta\n\n[Output truncated from the bottom:");
		expect(result.text).not.toContain("gamma");
		expect(result.truncation.outputBytes).toBe(Buffer.byteLength("alpha\nbeta", "utf8"));
	});

	test("does not split multi-byte characters when the first line exceeds the byte limit", () => {
		const result = truncateOutput("🙂🙂🙂", 10, 8);

		expect(result.text).toContain("🙂🙂\n\n[Output truncated from the bottom:");
		expect(result.text).not.toContain("�");
		expect(result.truncation.outputBytes).toBe(8);
	});

	test("repo_* tool results keep top lines when truncated", async () => {
		const previousCwd = process.cwd();
		const projectRoot = mkdtempSync(path.join(tmpdir(), "repo-discovery-test-"));
		mkdirSync(path.join(projectRoot, ".indexer-cli"));

		try {
			process.chdir(projectRoot);

			const tools: RegisteredTool[] = [];
			repoDiscoveryExtension({
				registerCommand: () => undefined,
				registerTool: (tool: RegisteredTool) => tools.push(tool),
				exec: async () => ({ stdout: "top\nmiddle\nbottom", stderr: "", code: 0 }),
			} as never);

			const repoStructure = tools.find((tool) => tool.name === "repo_structure");
			expect(repoStructure).toBeDefined();

			const result = await repoStructure!.execute("call-1", { maxLines: 2 }, undefined, undefined, { cwd: projectRoot });
			const text = result.content[0].text;

			expect(text).toContain("top\nmiddle\n\n[Output truncated from the bottom:");
			expect(text).not.toContain("\nbottom");
		} finally {
			process.chdir(previousCwd);
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});
});
