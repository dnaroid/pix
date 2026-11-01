import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { evaluateAssertions } from "./harness/assertions.js";
import { deriveMetrics } from "./harness/metrics.js";
import { renderEvalReportMarkdown } from "./harness/report.js";
import { isolatedGitEnvironment, writeRecorder } from "./harness/runner.js";
import { EVAL_CASES } from "./cases.js";
import type { EvalCase, EvalEvent, EvalReport } from "./harness/types.js";

describe("eval harness", () => {
	test("architecture discovery uses project search instead of a removed specialized tool", () => {
		const scenario = EVAL_CASES.find((item) => item.id === "tool.architecture-first")!;
		expect(scenario.assert?.requiredTools).toContain("project_search");
		expect(scenario.assert?.firstToolOneOf).toEqual(["project_search", "todo"]);
		const mentionedTools = [
			...(scenario.assert?.requiredTools ?? []),
			...(scenario.assert?.forbiddenTools ?? []),
			...(scenario.assert?.firstToolOneOf ?? []),
		];
		expect(mentionedTools.some((name) => name.startsWith("repo_"))).toBe(false);
	});

	test("generated recorder logs calls, native results and usage without extra modules", async () => {
		const artifactRoot = path.resolve(import.meta.dir, "../../../../.pi/artifacts");
		fs.mkdirSync(artifactRoot, { recursive: true });
		const projectDir = fs.mkdtempSync(path.join(artifactRoot, "eval-recorder-"));
		try {
			const { extensionPath, logPath } = writeRecorder(projectDir, ["apply_patch"]);
			const handlers = new Map<string, (event: Record<string, unknown>) => Promise<unknown>>();
			const { default: recorder } = await import(extensionPath);
			recorder({ on: (name: string, handler: (event: Record<string, unknown>) => Promise<unknown>) => handlers.set(name, handler) });
			expect(await handlers.get("tool_call")!({ toolCallId: "c1", toolName: "apply_patch", input: {} })).toMatchObject({ block: true });
			await handlers.get("tool_result")!({
				toolCallId: "c2", toolName: "project_search", content: [{ type: "text", text: "result" }],
			});
			await handlers.get("agent_end")!({ messages: [{ role: "assistant", usage: { input: 10, output: 2, totalTokens: 12, cost: { total: 0.01 } } }] });
			const events = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result", "agent_end"]);
			expect(events[1].contentBytes).toBeGreaterThan(0);
			expect(events[1].textBytes).toBe(6);
			expect(events[2].usage).toMatchObject({ totalTokens: 12, cost: 0.01 });
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	test("selection checkpoint blocks the entire batch, preserves text and counts every selected call once", async () => {
		const artifactRoot = path.resolve(import.meta.dir, "../../../../.pi/artifacts");
		fs.mkdirSync(artifactRoot, { recursive: true });
		const projectDir = fs.mkdtempSync(path.join(artifactRoot, "eval-selection-"));
		try {
			const { extensionPath, logPath } = writeRecorder(projectDir, [], ["question"]);
			const handlers = new Map<string, (event: Record<string, unknown>) => Promise<unknown>>();
			const { default: recorder } = await import(extensionPath);
			recorder({ on: (name: string, handler: (event: Record<string, unknown>) => Promise<unknown>) => handlers.set(name, handler) });
			const calls = [
				{ type: "toolCall", id: "c1", name: "question", arguments: { questions: [] } },
				{ type: "toolCall", id: "c2", name: "shell", arguments: { command: "touch forbidden" } },
			];
			await handlers.get("message_end")!({ message: { role: "user", content: "Hello" } });
			await handlers.get("message_end")!({ message: { role: "assistant", content: [{ type: "text", text: "Earlier" }] } });
			expect(fs.existsSync(logPath)).toBe(false);
			await handlers.get("message_end")!({ message: {
				role: "assistant", stopReason: "toolUse",
				content: [{ type: "text", text: "Choose." }, ...calls, { type: "text", text: "```pix-actions\n- Wrong duplicate\n```" }],
			} });
			for (const call of calls) {
				expect(await handlers.get("tool_call")!({ toolCallId: call.id, toolName: call.name, input: call.arguments }))
					.toMatchObject({ block: true, terminate: true });
			}
			await handlers.get("agent_end")!({ messages: [{ role: "assistant", usage: { totalTokens: 12 } }] });
			const events = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			expect(events.map((event) => event.type)).toEqual(["selection_checkpoint", "tool_call", "tool_call", "agent_end"]);
			expect(events[0]).toMatchObject({ text: "Choose.\n```pix-actions\n- Wrong duplicate\n```", stopReason: "toolUse" });
			expect(events[1].input).toEqual(calls[0]!.arguments);
			expect(events[2].toolName).toBe("shell");
			expect(events[3].usage.totalTokens).toBe(12);
		} finally {
			fs.rmSync(projectDir, { recursive: true, force: true });
		}
	});

	test("Git cannot discover the enclosing repository or inherit an explicit parent Git directory", () => {
		const artifactRoot = path.resolve(import.meta.dir, "../../../../.pi/artifacts");
		fs.mkdirSync(artifactRoot, { recursive: true });
		const parent = fs.mkdtempSync(path.join(artifactRoot, "eval-git-"));
		const projectDir = path.join(parent, "nested", "fixture");
		fs.mkdirSync(projectDir, { recursive: true });
		const cleanEnv = { ...process.env, ...isolatedGitEnvironment(parent) };
		try {
			expect(spawnSync("git", ["init", "--quiet", parent], { env: cleanEnv }).status).toBe(0);
			const inherited = { ...process.env, GIT_DIR: path.join(parent, ".git"), GIT_WORK_TREE: parent };
			expect(spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectDir, env: inherited }).status).toBe(0);
			const env = { ...inherited, ...isolatedGitEnvironment(projectDir) };
			const blocked = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectDir, env, encoding: "utf8" });
			expect(blocked.status).not.toBe(0);
			expect(blocked.stdout).toBe("");
			// A fixture-local repository remains usable.
			expect(spawnSync("git", ["init", "--quiet", projectDir], { env }).status).toBe(0);
			const local = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: projectDir, env, encoding: "utf8" });
			expect(local.status).toBe(0);
			expect(fs.realpathSync(local.stdout.trim())).toBe(fs.realpathSync(projectDir));
		} finally {
			fs.rmSync(parent, { recursive: true, force: true });
		}
	});

	test("derives mutation and verification metrics including historical repo tool events", () => {
		const events: EvalEvent[] = [
			{ type: "tool_call", toolName: "shell", input: { command: "npm test" } },
			{ type: "tool_result", toolName: "shell", isError: true, contentBytes: 30, textBytes: 20 },
			{ type: "tool_call", toolName: "apply_patch", input: { input: "patch" } },
			{ type: "tool_result", toolName: "apply_patch", isError: false, contentBytes: 40, textBytes: 35 },
			{ type: "tool_call", toolName: "shell", input: { command: "npm test" } },
			{ type: "tool_result", toolName: "shell", isError: false, contentBytes: 50, textBytes: 45 },
			{ type: "tool_call", toolCallId: "r1", toolName: "repo_inspect", input: { mode: "structure", scope: "fixture" } },
			{ type: "tool_result", toolCallId: "r1", toolName: "repo_inspect", isError: true, contentBytes: 60, textBytes: 50, nativePolicy: { refused: true, outputMode: "compact", reason: "compact-limit-exceeded" } },
			{ type: "tool_call", toolCallId: "r2", toolName: "repo_inspect", input: { mode: "structure", scope: "fixture", outputMode: "full" } },
			{ type: "tool_result", toolCallId: "r2", toolName: "repo_inspect", isError: false, contentBytes: 70, textBytes: 60, nativePolicy: { refused: false, outputMode: "full" } },
			{ type: "agent_end", usage: { input: 80, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 105, cost: 0.01 } },
		];
		const metrics = deriveMetrics({ events, elapsedMs: 1234, changedFiles: ["src/a.ts"], projectDir: "/missing", sessionDir: "/missing" });
		expect(metrics.toolCallCount).toBe(5);
		expect(metrics.mutationCount).toBe(1);
		expect(metrics.verificationCount).toBe(2);
		expect(metrics.failedToolResults).toBe(2);
		expect(metrics.toolResultContentBytes).toBe(250);
		expect(metrics.toolResultTextBytes).toBe(210);
		expect(metrics.repoResultContentBytes).toBe(130);
		expect(metrics.nativePolicyResults).toBe(2);
		expect(metrics.nativePolicyRefusals).toBe(1);
		expect(metrics.nativePolicyFullOverrides).toBe(1);
		expect(metrics.retryAfterNativeRefusalCount).toBe(1);
		expect(metrics.changedFiles).toEqual(["src/a.ts"]);
		expect(metrics.parentUsage.totalTokens).toBe(105);
		expect(metrics.parentUsage.cost).toBe(0.01);
	});

	test("charges project_search results to repository retrieval metrics after repo_search retirement", () => {
		const metrics = deriveMetrics({
			events: [{ type: "tool_result", toolName: "project_search", contentBytes: 128, textBytes: 110 }],
			elapsedMs: 2, changedFiles: [], projectDir: "/missing", sessionDir: "/missing",
		});
		expect(metrics.repoResultContentBytes).toBe(128);
		expect(metrics.toolResultContentBytes).toBe(128);
	});

	test("enforces reproduce-before-edit and verify-after-edit workflow assertions", () => {
		const evalCase: EvalCase = {
			id: "workflow",
			category: "coding-quality",
			description: "workflow",
			fixture: "demo",
			prompt: "workflow",
			assert: { requireReproBeforeMutation: true, requireVerificationAfterMutation: true },
		};
		const events: EvalEvent[] = [
			{ type: "tool_call", toolName: "shell", input: { command: "npm test" } },
			{ type: "tool_call", toolName: "apply_patch", input: { input: "patch" } },
			{ type: "tool_call", toolName: "shell", input: { command: "npm test" } },
		];
		const metrics = deriveMetrics({ events, elapsedMs: 1, changedFiles: ["src/a.ts"], projectDir: "/missing", sessionDir: "/missing" });
		const assertions = evaluateAssertions(evalCase, {
			caseId: evalCase.id,
			model: "test/model",
			projectDir: "/missing",
			stdout: "",
			stderr: "",
			exitCode: 0,
			timedOut: false,
			events,
			metrics,
		});
		expect(assertions.filter((item) => !item.passed)).toEqual([]);
	});

	test("renders comparable model/token/cost report", () => {
		const report: EvalReport = {
			startedAt: "2026-01-01T00:00:00.000Z",
			finishedAt: "2026-01-01T00:00:01.000Z",
			models: ["zai/glm-5.3"],
			results: [{
				caseId: "case",
				model: "zai/glm-5.3",
				projectDir: "/tmp/case",
				stdout: "",
				stderr: "",
				exitCode: 0,
				timedOut: false,
				events: [],
				metrics: {
					elapsedMs: 1000,
					toolCallCount: 2,
					toolCalls: ["project_search", "read"],
					failedToolResults: 0,
					toolResultContentBytes: 1200,
					toolResultTextBytes: 1000,
					repoResultContentBytes: 900,
					nativePolicyResults: 2,
					nativePolicyRefusals: 1,
					nativePolicyFullOverrides: 1,
					retryAfterNativeRefusalCount: 1,
					mutationCount: 0,
					verificationCount: 0,
					changedFiles: [],
					parentUsage: { input: 80, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: 0.01 },
					subagentUsage: { input: 40, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 50, cost: 0.002 },
					subagentCount: 1,
				},
				assertions: [],
				passed: true,
			}],
		};
		const markdown = renderEvalReportMarkdown(report);
		expect(markdown).toContain("zai/glm-5.3");
		expect(markdown).toContain("100");
		expect(markdown).toContain("50");
		expect(markdown).toContain("$0.0120");
		expect(markdown).toContain("1200");
		expect(markdown).toContain("2/1/1/1");
	});
});
