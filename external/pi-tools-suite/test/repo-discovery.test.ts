import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import repoDiscoveryExtension, { truncateOutput } from "../src/repo-discovery/index.js";
import { REPO_DISCOVERY_TOOLS } from "../src/tool-descriptions.js";
import { installFakeIdxOnPath } from "./support/fake-idx.js";

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
		const restorePath = installFakeIdxOnPath(projectRoot);
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
			expect(tools).toHaveLength(REPO_DISCOVERY_TOOLS.length);
			for (const description of REPO_DISCOVERY_TOOLS) {
				const tool = tools.find((entry) => entry.name === description.name)!;
				expect(tool).toMatchObject({
					description: description.description,
					promptSnippet: description.promptSnippet,
					promptGuidelines: description.promptGuidelines,
				});
				expect(tool.parameters.properties.maxLines.default).toBe(["repo_context", "repo_audit"].includes(tool.name) ? 600 : 2000);
				expect(tool.parameters.properties.maxBytes.default).toBe(["repo_context", "repo_audit"].includes(tool.name) ? 20000 : 50000);
				expect(tool.parameters.properties.outputMode).toBeUndefined();
				if (!["repo_context", "repo_audit"].includes(tool.name)) expect(tool.parameters.properties.maxLines.description).toContain("Prefer native limits/cursors");
			}
			const search = tools.find((tool) => tool.name === "repo_search")!;
			expect(tools.map((tool) => tool.name)).not.toContain("repo_ask");
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
			restorePath();
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	test("context/audit use supported idx commands and refuse unsafe or obsolete inputs", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "repo-idx-commands-"));
		mkdirSync(path.join(projectRoot, ".indexer-cli"));
		const restorePath = installFakeIdxOnPath(projectRoot);
		const tools: RegisteredTool[] = [];
		const calls: string[][] = [];
		try {
			repoDiscoveryExtension({
				registerCommand: () => undefined,
				registerTool: (tool: RegisteredTool) => tools.push(tool),
				exec: async (_command: string, args: string[]) => { calls.push(args); return { stdout: "ok", stderr: "", code: 0 }; },
			} as never, { profile: "baseline", cwd: projectRoot });
			const run = (name: string, params: Record<string, unknown>) => tools.find((tool) => tool.name === name)!.execute("call", params, undefined, undefined, { cwd: projectRoot });
			expect(tools.some((tool) => tool.name === "repo_knowledge")).toBe(false);
			expect((await run("repo_context", { query: "session refresh retry", maxCode: 2, pathPrefix: "src/session" })).isError).toBe(false);
			expect((await run("repo_audit", { paths: ["src/session.ts", "specs/session.md"], noSemantic: true })).isError).toBe(false);
			expect(calls).toEqual([
				["context", "session refresh retry", "--budget", "1400", "--max-specs", "4", "--max-code", "2", "--max-tests", "4", "--path-prefix", "src/session"],
				["audit", "src/session.ts", "specs/session.md", "--no-semantic"],
			]);
			for (const [name, params] of [
				["repo_context", { query: "--help" }],
				["repo_context", { query: "valid", maxSpecs: 100 }],
				["repo_context", { query: "valid", pathPrefix: "../outside" }],
				["repo_audit", { paths: [] }],
				["repo_audit", { paths: ["../outside"] }],
				["repo_audit", { paths: ["--json"] }],
				["repo_audit", { paths: ["C:\\outside"] }],
			] as const) expect((await run(name, params)).isError).toBe(true);
			expect(calls).toHaveLength(2);
			for (const name of ["repo_context", "repo_audit"]) {
				const properties = tools.find((tool) => tool.name === name)!.parameters.properties as Record<string, unknown>;
				expect(properties).not.toHaveProperty("includeSecondary");
				expect(properties).not.toHaveProperty("action");
			}
		} finally { restorePath(); rmSync(projectRoot, { recursive: true, force: true }); }
	});

	test("new idx tools require available idx and indexed project, including native-compact delivery", async () => {
		const projectRoot = mkdtempSync(path.join(tmpdir(), "repo-idx-gate-"));
		const previousPath = process.env.PATH;
		process.env.PATH = "";
		try {
			mkdirSync(path.join(projectRoot, ".indexer-cli"));
			const unavailable: RegisteredTool[] = [];
			repoDiscoveryExtension({ registerCommand: () => undefined, registerTool: (tool: RegisteredTool) => unavailable.push(tool), exec: async () => ({ stdout: "ok", stderr: "", code: 0 }) } as never,
				{ profile: "baseline", cwd: projectRoot });
			expect(unavailable).toHaveLength(0);
		} finally { process.env.PATH = previousPath; rmSync(path.join(projectRoot, ".indexer-cli"), { recursive: true }); }
		const restorePath = installFakeIdxOnPath(projectRoot);
		const tools: RegisteredTool[] = [];
		try {
			repoDiscoveryExtension({ registerCommand: () => undefined, registerTool: (tool: RegisteredTool) => tools.push(tool), exec: async () => ({ stdout: "ok", stderr: "", code: 0 }) } as never,
				{ profile: "native-compact", cwd: projectRoot });
			expect(tools).toHaveLength(0);
			mkdirSync(path.join(projectRoot, ".indexer-cli"));
			repoDiscoveryExtension({ registerCommand: () => undefined, registerTool: (tool: RegisteredTool) => tools.push(tool), exec: async () => ({ stdout: "ok", stderr: "", code: 0 }) } as never,
				{ profile: "native-compact", cwd: projectRoot });
			const context = tools.find((tool) => tool.name === "repo_context")!;
			expect(context.parameters.properties.outputMode?.default).toBe("compact");
			expect((await context.execute("call", { query: "task", maxLines: 401 }, undefined, undefined, { cwd: projectRoot })).isError).toBe(true);
			expect((await context.execute("call", { query: "task", outputMode: "full", maxLines: 401 }, undefined, undefined, { cwd: projectRoot })).isError).toBe(false);
		} finally { restorePath(); rmSync(projectRoot, { recursive: true, force: true }); }
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
		const restorePath = installFakeIdxOnPath(projectRoot);

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
			restorePath();
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
