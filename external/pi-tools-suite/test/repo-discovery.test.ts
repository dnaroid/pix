import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import repoDiscoveryExtension, { truncateOutput } from "../src/repo-discovery/index.js";
import { REPO_DISCOVERY_TOOLS, REPO_KNOWLEDGE_TOOL_DESCRIPTION } from "../src/tool-descriptions.js";

type RegisteredTool = {
	name: string;
	description: string;
	promptSnippet: string;
	promptGuidelines: string[];
	parameters: { properties: {
		args: { description: string };
		maxLines: { description: string; default: number };
		maxBytes: { description: string; default: number };
		outputMode?: { description: string; default: string; enum: string[] };
	} };
	execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: { cwd: string }) => Promise<{
		content: Array<{ text: string }>;
		isError?: boolean;
		details?: Record<string, unknown>;
	}>;
};

type RegisteredCommand = {
	description: string;
	handler: (args: string, ctx: { cwd: string; hasUI: boolean; ui: { notify: () => void } }) => Promise<void>;
};

describe("repo discovery output truncation", () => {
	test("registered repo tools expose economy guidance without changing execution defaults", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "repo-discovery-guidance-"));
		mkdirSync(path.join(projectRoot, ".indexer-cli"));
		const tools: RegisteredTool[] = [];
		const calls: Array<{ command: string; args: string[] }> = [];
		try {
			repoDiscoveryExtension({
				registerCommand: () => undefined,
				registerTool: (tool: RegisteredTool) => tools.push(tool),
				exec: async (command: string, args: string[]) => {
					calls.push({ command, args });
					return { stdout: "fixture result", stderr: "", code: 0 };
				},
			} as never, { profile: "baseline", cwd: projectRoot });
			expect(tools).toHaveLength(REPO_DISCOVERY_TOOLS.length + 1);
			for (const description of REPO_DISCOVERY_TOOLS) {
				const tool = tools.find((entry) => entry.name === description.name)!;
				expect(tool).toMatchObject({
					description: description.description,
					promptSnippet: description.promptSnippet,
					promptGuidelines: description.promptGuidelines,
				});
				expect(tool.parameters.properties.maxLines.default).toBe(2000);
				expect(tool.parameters.properties.maxBytes.default).toBe(50000);
				expect(tool.parameters.properties.outputMode).toBeUndefined();
				expect(tool.parameters.properties.maxLines.description).toContain("Prefer native limits/cursors");
			}
			const search = tools.find((tool) => tool.name === "repo_search")!;
			expect(tools.some((tool) => tool.name === REPO_KNOWLEDGE_TOOL_DESCRIPTION.name)).toBe(true);
			expect(search.parameters.properties.args.description).toContain("default 3 results without code");
			expect(search.parameters.properties.args.description).toContain("--include-content only for narrow follow-up");
			await search.execute("first-pass", { target: "session persistence" }, undefined, undefined, { cwd: projectRoot });
			await search.execute("follow-up", {
				target: "session persistence", args: ["--include-content", "--max-files", "1"],
			}, undefined, undefined, { cwd: projectRoot });
			expect(calls).toEqual([
				{ command: "idx", args: ["search", "session persistence"] },
				{ command: "idx", args: ["search", "session persistence", "--include-content", "--max-files", "1"] },
			]);
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	test("registers repo_knowledge only when idx is available and project is indexed", () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "repo-knowledge-availability-"));
		mkdirSync(path.join(projectRoot, ".indexer-cli"));
		const previousPath = process.env.PATH;
		try {
			process.env.PATH = "";
			const unavailable: RegisteredTool[] = [];
			repoDiscoveryExtension({
				registerCommand: () => undefined,
				registerTool: (tool: RegisteredTool) => unavailable.push(tool),
				exec: async () => ({ stdout: "", stderr: "", code: 0 }),
			} as never, { profile: "baseline", cwd: projectRoot });
			expect(unavailable).toEqual([]);

			const binDir = path.join(projectRoot, "bin");
			mkdirSync(binDir);
			const idxPath = path.join(binDir, "idx");
			writeFileSync(idxPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
			process.env.PATH = binDir;
			const available: RegisteredTool[] = [];
			repoDiscoveryExtension({
				registerCommand: () => undefined,
				registerTool: (tool: RegisteredTool) => available.push(tool),
				exec: async () => ({ stdout: "", stderr: "", code: 0 }),
			} as never, { profile: "baseline", cwd: projectRoot });
			expect(available.map((tool) => tool.name)).toContain("repo_knowledge");
		} finally {
			process.env.PATH = previousPath;
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	test("repo_knowledge maps compact read actions and guards semantic mutations", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "repo-knowledge-actions-"));
		mkdirSync(path.join(projectRoot, ".indexer-cli"));
		const binDir = path.join(projectRoot, "bin");
		mkdirSync(binDir);
		const idxPath = path.join(binDir, "idx");
		writeFileSync(idxPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const previousPath = process.env.PATH;
		process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
		const tools: RegisteredTool[] = [];
		const calls: string[][] = [];
		try {
			repoDiscoveryExtension({
				registerCommand: () => undefined,
				registerTool: (tool: RegisteredTool) => tools.push(tool),
				exec: async (_command: string, args: string[]) => {
					calls.push(args);
					return { stdout: "ok", stderr: "", code: 0 };
				},
			} as never, { profile: "baseline", cwd: projectRoot });

			const knowledge = tools.find((tool) => tool.name === "repo_knowledge")!;
			const context = await knowledge.execute("ctx", {
				action: "context",
				query: "session refresh retry",
			}, undefined, undefined, { cwd: projectRoot });
			expect(context.isError).toBe(false);
			expect(calls[0]).toEqual([
				"context", "session refresh retry", "--budget", "1400", "--max-specs", "4", "--max-code", "6", "--max-tests", "4",
			]);

			const impact = await knowledge.execute("impact", {
				action: "impact",
				paths: ["src/session.ts", "src/refresh-worker.ts"],
			}, undefined, undefined, { cwd: projectRoot });
			expect(impact.isError).toBe(false);
			expect(calls[1]).toEqual([
				"wiki", "impact", "src/session.ts", "src/refresh-worker.ts", "--semantic-limit", "5",
			]);

			for (const guarded of [
				{ action: "record", path: "docs/session.md", classification: "spec", behaviorType: "as-is", lifecycle: "active" },
				{ action: "verify", path: "docs/session.md" },
				{ action: "relate", path: "docs/session.md", relationAction: "add", relationKind: "implements", targetPaths: ["src/session.ts"] },
				{ action: "remove", path: "docs/session.md" },
			]) {
				const result = await knowledge.execute("guard", guarded, undefined, undefined, { cwd: projectRoot });
				expect(result.isError).toBe(true);
			}
			expect(calls).toHaveLength(2);

			const relate = await knowledge.execute("relate", {
				action: "relate",
				path: "docs/session.md",
				relationAction: "add",
				relationKind: "implements",
				targetPaths: ["src/session.ts"],
				evidenceReviewed: true,
			}, undefined, undefined, { cwd: projectRoot });
			expect(relate.isError).toBe(false);
			expect(relate.details?.mutating).toBe(true);
			expect(calls[2]).toEqual([
				"wiki", "relate", "--path", "docs/session.md", "--add-code", "src/session.ts",
			]);
		} finally {
			process.env.PATH = previousPath;
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	test("adds one repo-aware post-mutation knowledge checkpoint and skips repeated nudges", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "repo-knowledge-nudge-"));
		mkdirSync(path.join(projectRoot, ".indexer-cli"));
		const binDir = path.join(projectRoot, "bin");
		mkdirSync(binDir);
		writeFileSync(path.join(binDir, "idx"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const previousPath = process.env.PATH;
		process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
		let toolResultHandler: ((event: any, ctx: { cwd: string }) => Promise<any>) | undefined;
		try {
			repoDiscoveryExtension({
				registerCommand: () => undefined,
				registerTool: () => undefined,
				exec: async () => ({ stdout: "", stderr: "", code: 0 }),
				on: (event: string, handler: (event: any, ctx: { cwd: string }) => Promise<any>) => {
					if (event === "tool_result") toolResultHandler = handler;
				},
			} as never, { profile: "baseline", cwd: projectRoot });

			expect(toolResultHandler).toBeDefined();
			const first = await toolResultHandler!({
				toolName: "apply_patch",
				content: [{ type: "text", text: "patched" }],
			}, { cwd: projectRoot });
			const text = first.content.map((part: any) => part.text ?? "").join("\n");
			expect(text).toContain("repo_knowledge checkpoint");
			expect(text).toContain("keep or create the authoritative primary spec");
			expect(text).toContain("action=impact");
			expect(text).toContain("mechanical/non-behavioral edits");

			const repeated = await toolResultHandler!({
				toolName: "Edit",
				content: [{ type: "text", text: "edited" }],
			}, { cwd: projectRoot });
			expect(repeated).toBeUndefined();
		} finally {
			process.env.PATH = previousPath;
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});

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
		const projectRoot = mkdtempSync(path.join(tmpdir(), "repo-discovery-test-"));
		mkdirSync(path.join(projectRoot, ".indexer-cli"));

		try {
			const tools: RegisteredTool[] = [];
			repoDiscoveryExtension({
				registerCommand: () => undefined,
				registerTool: (tool: RegisteredTool) => tools.push(tool),
				exec: async () => ({ stdout: "top\nmiddle\nbottom", stderr: "", code: 0 }),
			} as never, { profile: "baseline", cwd: projectRoot });

			const repoStructure = tools.find((tool) => tool.name === "repo_structure");
			expect(repoStructure).toBeDefined();

			const result = await repoStructure!.execute("call-1", { maxLines: 2 }, undefined, undefined, { cwd: projectRoot });
			const text = result.content[0].text;

			expect(text).toContain("top\nmiddle\n\n[Output truncated from the bottom:");
			expect(text).not.toContain("\nbottom");
		} finally {
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
			} as never, { profile: "baseline" });

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

	test("/idx-init repairs missing idx even when .indexer-cli already exists", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "repo-discovery-repair-test-"));
		mkdirSync(path.join(projectRoot, ".indexer-cli"));
		const commands = new Map<string, RegisteredCommand>();
		const calls: Array<{ command: string; args: string[] }> = [];
		try {
			repoDiscoveryExtension({
				registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
				registerTool: () => undefined,
				sendMessage: () => undefined,
				exec: async (command: string, args: string[]) => {
					calls.push({ command, args });
					if (command === "sh") return { stdout: "", stderr: "", code: 1 };
					if (command === "npm") return { stdout: "installed", stderr: "", code: 0 };
					return { stdout: "", stderr: "unexpected", code: 1 };
				},
			} as never, { profile: "baseline", cwd: projectRoot });
			await commands.get("idx-init")!.handler("", { cwd: projectRoot, hasUI: false, ui: { notify: () => undefined } });
			expect(calls.map((call) => call.command)).toEqual(["sh", "npm"]);
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
			} as never, { profile: "baseline" });

			await commands.get("idx-init")!.handler("", { cwd: projectRoot, hasUI: false, ui: { notify: () => undefined } });

			expect(calls.map((call) => call.command)).toEqual(["sh", "idx"]);
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});
});
