import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import repoDiscoveryExtension, { truncateOutput } from "../src/repo-discovery/index.js";

type RegisteredTool = {
	name: string;
	execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: { cwd: string }) => Promise<{ content: Array<{ text: string }> }>;
};

type RegisteredCommand = {
	description: string;
	handler: (args: string, ctx: { cwd: string; hasUI: boolean; ui: { notify: () => void } }) => Promise<void>;
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

	test("/idx-init installs indexer-cli before init when idx is unavailable", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "repo-discovery-init-test-"));
		const commands = new Map<string, RegisteredCommand>();
		const calls: Array<{ command: string; args: string[] }> = [];
		const messages: Array<{ content: string }> = [];

		try {
			repoDiscoveryExtension({
				registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
				registerTool: () => undefined,
				sendMessage: (message: { content: string }) => messages.push(message),
				exec: async (command: string, args: string[]) => {
					calls.push({ command, args });
					if (command === "sh") return { stdout: "", stderr: "", code: 1 };
					if (command === "npm") return { stdout: "installed indexer-cli", stderr: "", code: 0 };
					if (command === "idx" && args[0] === "init") return { stdout: "initialized project", stderr: "", code: 0 };
					return { stdout: "", stderr: `unexpected ${command}`, code: 1 };
				},
			} as never);

			await commands.get("idx-init")!.handler("", { cwd: projectRoot, hasUI: false, ui: { notify: () => undefined } });

			expect(calls.map((call) => [call.command, ...call.args])).toEqual([
				["sh", "-lc", "command -v idx"],
				["npm", "install", "-g", "indexer-cli@latest"],
				["idx", "init"],
			]);
			expect(messages[0].content).toContain("idx was not available; installed with npm install -g indexer-cli@latest");
			expect(messages[0].content).toContain("idx init completed");
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	test("/idx-init skips npm install when idx is available", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "repo-discovery-init-test-"));
		const commands = new Map<string, RegisteredCommand>();
		const calls: Array<{ command: string; args: string[] }> = [];

		try {
			repoDiscoveryExtension({
				registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
				registerTool: () => undefined,
				sendMessage: () => undefined,
				exec: async (command: string, args: string[]) => {
					calls.push({ command, args });
					if (command === "sh") return { stdout: "/usr/local/bin/idx", stderr: "", code: 0 };
					if (command === "idx" && args[0] === "init") return { stdout: "initialized project", stderr: "", code: 0 };
					return { stdout: "", stderr: `unexpected ${command}`, code: 1 };
				},
			} as never);

			await commands.get("idx-init")!.handler("", { cwd: projectRoot, hasUI: false, ui: { notify: () => undefined } });

			expect(calls.map((call) => call.command)).toEqual(["sh", "idx"]);
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});
});
