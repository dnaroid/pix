import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { withE2ERetry } from "../e2e-retry.js";
import type { AgentTask } from "../../src/async-subagents/lib.js";

// Live E2E tests are opt-in because they call a real model. They verify that
// the parent agent chooses the right sub-agent profile(s) in the subagents tool
// input for different routing cases. The recorder extension blocks execution
// before any sub-agent subprocess is spawned, so these tests check selection
// behavior without paying for nested agents. Run with:
// ASYNC_SUBAGENTS_SELECTION_E2E=1 ASYNC_SUBAGENTS_MODEL=zai/glm-5-turbo \
//   bun test test/async-subagents/selection-e2e.test.ts
const RUN_E2E = /^(1|true|yes)$/i.test(
	process.env.ASYNC_SUBAGENTS_SELECTION_E2E ?? process.env.ASYNC_SUBAGENTS_E2E ?? process.env.PROMPT_EVAL_E2E ?? "",
);
const KEEP_E2E_DIRS = /^(1|true|yes)$/i.test(process.env.ASYNC_SUBAGENTS_SELECTION_E2E_KEEP ?? process.env.ASYNC_SUBAGENTS_E2E_KEEP ?? "");
const DEFAULT_MODEL = "zai/glm-5-turbo";
const E2E_MODEL = (
	process.env.ASYNC_SUBAGENTS_SELECTION_E2E_MODEL ||
	process.env.ASYNC_SUBAGENTS_MODEL ||
	process.env.ASYNC_SUBAGENTS_E2E_MODEL ||
	process.env.PI_TOOLS_SUITE_E2E_MODEL ||
	DEFAULT_MODEL
).trim();
const E2E_TIMEOUT_MS = Number(process.env.ASYNC_SUBAGENTS_SELECTION_E2E_TIMEOUT_MS ?? process.env.ASYNC_SUBAGENTS_E2E_TIMEOUT_MS ?? 240_000);
const E2E_STREAM_IO = /^(1|true|yes)$/i.test(process.env.ASYNC_SUBAGENTS_SELECTION_E2E_STREAM_IO ?? process.env.ASYNC_SUBAGENTS_E2E_STREAM_IO ?? "");
const EXTENSION_ENTRYPOINT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "index.ts");
const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "demo-project");
const e2eTest = RUN_E2E ? test : test.skip;

type ToolEvent = {
	type: "tool_call" | "tool_result";
	toolName: string;
	input?: unknown;
	isError?: boolean;
};

type SubagentsInput = {
	action?: string;
	tasks?: AgentTask[];
};

function makeFixtureProject(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-selection-e2e-project-"));
	fs.cpSync(FIXTURE_DIR, dir, { recursive: true });
	return dir;
}

async function withFixtureProject<T>(fn: (projectDir: string) => Promise<T>): Promise<T> {
	const projectDir = makeFixtureProject();
	try {
		return await fn(projectDir);
	} finally {
		if (!KEEP_E2E_DIRS) fs.rmSync(projectDir, { recursive: true, force: true });
	}
}

function writeToolRecorderExtension(projectDir: string): { extensionPath: string; logPath: string } {
	const extensionPath = path.join(projectDir, ".pi", "subagent-selection-recorder.ts");
	const logPath = path.join(projectDir, ".pi", "subagent-selection-events.jsonl");
	fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
	fs.writeFileSync(extensionPath, `
import * as fs from "node:fs";

const LOG_PATH = ${JSON.stringify(logPath)};

function append(event: unknown) {
  fs.mkdirSync(${JSON.stringify(path.dirname(logPath))}, { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(event) + "\\n", "utf-8");
}

export default function recorder(pi: any) {
  pi.on("tool_call", async (event: any) => {
    append({ type: "tool_call", toolName: event.toolName, input: event.input ?? null });
    if (event.toolName === "subagents") {
      return { block: true, reason: "subagent selection e2e recorded this call; do not retry or spawn real sub-agents" };
    }
  });
  pi.on("tool_result", async (event: any) => {
    append({ type: "tool_result", toolName: event.toolName, isError: event.isError === true });
  });
}
`, "utf-8");
	return { extensionPath, logPath };
}

function writeIsolatedSubagentConfig(projectDir: string): string {
	const configPath = path.join(projectDir, ".pi", "async-subagents-selection.json");
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(configPath, JSON.stringify({ types: {} }), "utf-8");
	return configPath;
}

async function runPiSubagentSelectionE2E(
	projectDir: string,
	prompt: string,
	label: string,
): Promise<{ stdout: string; stderr: string; events: ToolEvent[]; configPath: string }> {
	if (!E2E_MODEL) throw new Error("ASYNC_SUBAGENTS_MODEL/ASYNC_SUBAGENTS_SELECTION_E2E_MODEL resolved to an empty model");

	return withE2ERetry(label, async () => {
		const sessionDir = path.join(projectDir, ".pi", `e2e-session-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(sessionDir, { recursive: true });
		const recorder = writeToolRecorderExtension(projectDir);
		fs.rmSync(recorder.logPath, { force: true });
		const configPath = writeIsolatedSubagentConfig(projectDir);
		const args = [
			"--model", E2E_MODEL,
			"--extension", EXTENSION_ENTRYPOINT,
			"--extension", recorder.extensionPath,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--session-dir", sessionDir,
			"--no-session",
			"-p", prompt,
		];

		const child = spawn("pi", args, {
			cwd: projectDir,
			env: {
				...e2eChildEnv(),
				ASYNC_SUBAGENTS_CONFIG: configPath,
				PI_SUBAGENTS_CONFIG: configPath,
				ASYNC_SUBAGENTS_MODEL: E2E_MODEL,
				PI_SUBAGENTS_MODEL: E2E_MODEL,
				PI_OFFLINE: "1",
				NO_COLOR: "1",
				CI: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			stdout += text;
			if (E2E_STREAM_IO) console.error(`[subagent-selection stdout:${label}] ${text.trimEnd()}`);
		});
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			stderr += text;
			if (E2E_STREAM_IO) console.error(`[subagent-selection stderr:${label}] ${text.trimEnd()}`);
		});

		const exitCode = await new Promise<number | null>((resolve, reject) => {
			const timeout = setTimeout(() => {
				child.kill("SIGTERM");
				reject(new Error(`pi subagent-selection e2e timed out after ${E2E_TIMEOUT_MS}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
			}, E2E_TIMEOUT_MS);
			child.once("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timeout);
				resolve(code);
			});
		});

		if (exitCode !== 0) {
			throw new Error(`pi subagent-selection e2e (${label}) exited with ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}\nEVENTS:\n${readOptionalFile(recorder.logPath)}`);
		}

		return { stdout, stderr, events: readToolEvents(recorder.logPath), configPath };
	}, {
		onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
			if (E2E_STREAM_IO) console.error(
				`[subagent-selection retry:${label}] 429/rate-limit on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs}ms (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
			);
		},
	});
}

function e2eChildEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (/^(ASYNC_SUBAGENTS|PI_SUBAGENTS)_/.test(key)) continue;
		env[key] = value;
	}
	return env;
}

function readOptionalFile(file: string): string {
	return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
}

function readToolEvents(file: string): ToolEvent[] {
	return readOptionalFile(file)
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as ToolEvent);
}

function firstSpawnInput(events: ToolEvent[]): SubagentsInput {
	const input = events.find((event) => event.type === "tool_call" && event.toolName === "subagents")?.input;
	expect(isRecord(input)).toBe(true);
	const subagentsInput = input as SubagentsInput;
	expect(subagentsInput.action).toBe("spawn");
	expect(Array.isArray(subagentsInput.tasks)).toBe(true);
	expect(subagentsInput.tasks!.length).toBeGreaterThan(0);
	return subagentsInput;
}

function expectResolvedTaskTypes(input: SubagentsInput, expected: Record<string, string>): void {
	const tasks = new Map((input.tasks ?? []).map((task) => [task.id, task]));
	for (const [id, expectedType] of Object.entries(expected)) {
		const task = tasks.get(id);
		expect(task, `Expected spawned task with id ${id}; got ids: ${[...tasks.keys()].join(", ")}`).toBeDefined();
		const resolvedType = task!.subagentType;
		expect(resolvedType).toBe(expectedType);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

describe("async-subagents live e2e sub-agent type selection", () => {
	e2eTest("omits optional routing overrides for a normal delegated task and does not poll", async () => {
		await withFixtureProject(async (projectDir) => {
			const prompt = `
Delegate one independent payment-flow review now using the agent id payment-check, then stop immediately after the spawn call.
Let the configured router choose the helper profile. Do not inspect files in the parent, do not wait for results, and do not check progress.`;

			const result = await runPiSubagentSelectionE2E(projectDir, prompt, "default router omission");
			const subagentCalls = result.events.filter((event) => event.type === "tool_call" && event.toolName === "subagents");
			expect(subagentCalls).toHaveLength(1);
			const input = firstSpawnInput(result.events);
			expect(input.tasks).toHaveLength(1);
			const task = input.tasks![0]!;
			expect(task.id).toBe("payment-check");
			expect(task.subagentType).toBeUndefined();
			expect(task.model).toBeUndefined();
			expect(task.thinking).toBeUndefined();
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("selects quick, scan, and review profiles for mixed explicit launch tracks", async () => {
		await withFixtureProject(async (projectDir) => {
			const prompt = `
Launch exactly three sub-agents now and then stop after the spawn call; do not wait for results and do not inspect files first.
Use exactly these agent ids and choose the appropriate logical sub-agent profile for each track:
- quick-lookup: a cheap README/package lookup to summarize what this fixture project is.
- repo-scan: a repo-wide file/search sweep to locate the checkout modules and test files.
- payment-review: an independent code quality and security review of the payment flow.
The goal is to route each track to the right kind of helper, not to complete the investigation in the parent.`;

			const result = await runPiSubagentSelectionE2E(projectDir, prompt, "mixed profile launch");
			const input = firstSpawnInput(result.events);
			expectResolvedTaskTypes(input, {
				"quick-lookup": "quick",
				"repo-scan": "scan",
				"payment-review": "review",
			});
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("selects deep profiles for root-cause and change-impact sub-agents", async () => {
		await withFixtureProject(async (projectDir) => {
			const prompt = `
Launch exactly two sub-agents now and then stop after the spawn call; do not wait for results and do not inspect files first.
Use exactly these agent ids and choose the appropriate logical sub-agent profile for hard reasoning work. These are not code-review, audit, security, or quality-review tracks:
- incident-root-cause: deep root cause analysis of duplicate checkout charges after retries, including complex debugging hypotheses across payments and observability signals.
- coupon-impact: deep architecture and broad impact analysis of changing coupon expiry handling from string comparison to Date parsing, including downstream design consequences.
The goal is correct sub-agent routing for complex debugging, architecture, and impact analysis.`;

			const result = await runPiSubagentSelectionE2E(projectDir, prompt, "deep profile launch");
			const input = firstSpawnInput(result.events);
			expectResolvedTaskTypes(input, {
				"incident-root-cause": "deep",
				"coupon-impact": "deep",
			});
		});
	}, E2E_TIMEOUT_MS);
});
