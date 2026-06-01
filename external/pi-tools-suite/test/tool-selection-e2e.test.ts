import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { withE2ERetry } from "./e2e-retry.js";

// Live E2E tests are opt-in because they call a real model and spawn real pi
// subprocesses. They verify prompt/tool metadata selection in both repo-aware
// and non-repo modes. Test prompts intentionally describe user intent without
// naming the expected tool, so failures catch broken promptSnippet/guideline
// routing instead of prompt-forced tool calls. Run with:
// TOOL_SELECTION_E2E=1 TOOL_SELECTION_E2E_MODEL=zai/glm-5-turbo \
//   bun test test/tool-selection-e2e.test.ts
const RUN_E2E = /^(1|true|yes)$/i.test(process.env.TOOL_SELECTION_E2E ?? "");
const KEEP_E2E_DIRS = /^(1|true|yes)$/i.test(process.env.TOOL_SELECTION_E2E_KEEP ?? "");
const DEFAULT_MODEL = "zai/glm-5-turbo";
const E2E_MODEL = (
	process.env.TOOL_SELECTION_E2E_MODEL ||
	process.env.PI_TOOLS_SUITE_E2E_MODEL ||
	DEFAULT_MODEL
).trim();
const E2E_TIMEOUT_MS = Number(process.env.TOOL_SELECTION_E2E_TIMEOUT_MS ?? 240_000);
const E2E_STREAM_IO = /^(1|true|yes)$/i.test(process.env.TOOL_SELECTION_E2E_STREAM_IO ?? "");
const EXTENSION_ENTRYPOINT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
const FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "demo-project");
const e2eTest = RUN_E2E ? test : test.skip;

type ToolEvent = {
	type: "tool_call" | "tool_result";
	toolName: string;
	input?: unknown;
	isError?: boolean;
};

function makeFixtureProject(options: { indexed: boolean }): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-selection-e2e-project-"));
	fs.cpSync(FIXTURE_DIR, dir, { recursive: true });
	if (options.indexed) fs.mkdirSync(path.join(dir, ".indexer-cli"), { recursive: true });
	return dir;
}

async function withFixtureProject<T>(options: { indexed: boolean }, fn: (projectDir: string) => Promise<T>): Promise<T> {
	const projectDir = makeFixtureProject(options);
	try {
		return await fn(projectDir);
	} finally {
		if (!KEEP_E2E_DIRS) fs.rmSync(projectDir, { recursive: true, force: true });
	}
}

function writeToolRecorderExtension(projectDir: string): { extensionPath: string; logPath: string } {
	const extensionPath = path.join(projectDir, ".pi", "tool-selection-recorder.ts");
	const logPath = path.join(projectDir, ".pi", "tool-selection-events.jsonl");
	fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
	fs.writeFileSync(extensionPath, `
import * as fs from "node:fs";

const LOG_PATH = ${JSON.stringify(logPath)};
const BLOCKED_TOOLS = new Set(["subagents"]);

function append(event: unknown) {
  fs.mkdirSync(${JSON.stringify(path.dirname(logPath))}, { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(event) + "\\n", "utf-8");
}

export default function recorder(pi: any) {
  pi.on("tool_call", async (event: any) => {
    append({ type: "tool_call", toolName: event.toolName, input: event.input ?? null });
    if (BLOCKED_TOOLS.has(event.toolName)) {
      return { block: true, reason: "subagents are blocked by the tool-selection e2e recorder; use the direct discovery tools instead" };
    }
  });
  pi.on("tool_result", async (event: any) => {
    append({ type: "tool_result", toolName: event.toolName, isError: event.isError === true });
  });
}
`, "utf-8");
	return { extensionPath, logPath };
}

function writeFakeIdxBin(projectDir: string): string {
	const binDir = path.join(projectDir, ".pi", "fake-bin");
	const idxPath = path.join(binDir, "idx");
	const logPath = path.join(projectDir, ".pi", "idx-events.jsonl");
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(idxPath, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const command = args[0] || "";
if (command === "search") {
  console.log("src/payments.ts:19-33 buildPaymentRequest creates the payment gateway request. The idempotencyKey is random (Date.now + Math.random), so retries can double-charge.");
} else if (command === "architecture") {
  console.log("Checkout fixture modules: cart, discounts, payments, audit. Payment request construction lives in src/payments.ts.");
} else if (command === "structure") {
  console.log("src/payments.ts — function buildPaymentRequest:19-33; src/cart.ts; src/discounts.ts; src/audit.ts");
} else if (command === "explain" || command === "deps" || command === "ast") {
  console.log("src/payments.ts::buildPaymentRequest handles cardToken, amountCents, and idempotencyKey.");
} else {
  console.log("fake idx ok");
}
`, "utf-8");
	fs.chmodSync(idxPath, 0o755);
	return binDir;
}

async function runPiToolSelectionE2E(
	projectDir: string,
	prompt: string,
	label: string,
	options: { fakeIdx?: boolean } = {},
): Promise<{ stdout: string; stderr: string; events: ToolEvent[] }> {
	if (!E2E_MODEL) throw new Error("TOOL_SELECTION_E2E_MODEL/PI_TOOLS_SUITE_E2E_MODEL resolved to an empty model");

	return withE2ERetry(label, async () => {
		const sessionDir = path.join(projectDir, ".pi", `e2e-session-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(sessionDir, { recursive: true });
		const recorder = writeToolRecorderExtension(projectDir);
		fs.rmSync(recorder.logPath, { force: true });
		const fakeBin = options.fakeIdx ? writeFakeIdxBin(projectDir) : undefined;
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
				...process.env,
				PATH: fakeBin ? `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` : process.env.PATH,
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
			if (E2E_STREAM_IO) console.error(`[tool-selection stdout:${label}] ${text.trimEnd()}`);
		});
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString("utf8");
			stderr += text;
			if (E2E_STREAM_IO) console.error(`[tool-selection stderr:${label}] ${text.trimEnd()}`);
		});

		const exitCode = await new Promise<number | null>((resolve, reject) => {
			const timeout = setTimeout(() => {
				child.kill("SIGTERM");
				reject(new Error(`pi tool-selection e2e timed out after ${E2E_TIMEOUT_MS}ms\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
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
			throw new Error(`pi tool-selection e2e (${label}) exited with ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}\nEVENTS:\n${readOptionalFile(recorder.logPath)}`);
		}

		return { stdout, stderr, events: readToolEvents(recorder.logPath) };
	}, {
		onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
			if (E2E_STREAM_IO) console.error(
				`[tool-selection retry:${label}] 429/rate-limit on attempt ${attempt}/${maxAttempts}; retrying in ${delayMs}ms (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`,
			);
		},
	});
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

function toolCallNames(events: ToolEvent[]): string[] {
	return events.filter((event) => event.type === "tool_call").map((event) => event.toolName);
}

function firstMatchingTool(names: string[], candidates: string[]): string | undefined {
	return names.find((name) => candidates.includes(name));
}

const DIRECT_DISCOVERY_TOOLS = ["read", "Read", "grep", "Grep", "find", "Glob", "ls", "bash", "Bash", "shell", "shell_command"];

type PromptVariant = {
	name: string;
	prompt: string;
};

const FOCUSED_PAYMENT_BEHAVIOR_PROMPTS: PromptVariant[] = [
	{
		name: "unknown owner",
		prompt: `
I'm trying to understand the checkout payment retry/idempotency behavior, but I don't know which file or symbol owns it yet.
Please identify where that behavior is implemented and tell me whether the current implementation can double-charge.`,
	},
	{
		name: "duplicate charge report",
		prompt: `
Users reported possible duplicate charges after a payment retry.
Find the code path that controls checkout payment request creation and explain the risky implementation detail with a file reference.`,
	},
	{
		name: "pre-bug trace",
		prompt: `
Before I file a bug, trace how checkout creates the gateway payment request and whether the retry key is stable enough.
I don't know where to start in this codebase, so cite the file that owns the behavior.`,
	},
];

const ARCHITECTURE_OVERVIEW_PROMPTS: PromptVariant[] = [
	{
		name: "new contributor",
		prompt: `
I'm new to this checkout project. Give me a quick architecture overview before we decide what to change.
I mainly need the important modules and how they fit together, not a deep code review.`,
	},
	{
		name: "before change",
		prompt: `
Before touching the checkout code, map the project at a high level.
Summarize the main components, module boundaries, and obvious dependency flow.`,
	},
	{
		name: "team onboarding",
		prompt: `
Prepare a short onboarding note for a teammate who has never seen this checkout fixture.
Focus on the project structure and the responsibilities of the main modules.`,
	},
];

const BROAD_NON_INDEXED_INVESTIGATION_PROMPTS: PromptVariant[] = [
	{
		name: "release readiness",
		prompt: `
Please assess this checkout project for release readiness by splitting the work into independent tracks.
Have one track look at architecture, another at payment/idempotency risks, another at existing tests, and another at rollout-plan gaps, then merge the findings with file references.`,
	},
	{
		name: "incident triage",
		prompt: `
Treat this as incident triage after reports of double charges and weak diagnostics.
Investigate likely causes as separate hypotheses: payment retry behavior, audit/observability, and rollout assumptions. Work those hypotheses independently where possible, then give me the evidence.`,
	},
	{
		name: "test strategy",
		prompt: `
Build a practical test and risk strategy for this checkout fixture using separate parallel review tracks.
Keep payments, discounts, cart totals, audit coverage, and release-plan risks as independent investigations, then combine the recommendations with the files that matter.`,
	},
];

const EXACT_LITERAL_SMALL_EDIT_PROMPTS: PromptVariant[] = [
	{
		name: "lsp clean-report wording",
		prompt: `
After edits, our LSP report shows the exact line "✅ typescript: no diagnostics".
Find where that literal wording appears in this project and update it to a more positive success message.
This is a tiny exact-string wording change, not architecture exploration or semantic behavior research.`,
	},
];

describe("repo-aware tool-selection live e2e", () => {
	for (const variant of FOCUSED_PAYMENT_BEHAVIOR_PROMPTS) {
		e2eTest(`uses repo_search for a single semantic discovery when repo_* tools are available (${variant.name})`, async () => {
			await withFixtureProject({ indexed: true }, async (projectDir) => {
				const result = await runPiToolSelectionE2E(projectDir, variant.prompt, `repo-search selection (${variant.name})`, { fakeIdx: true });
				const names = toolCallNames(result.events);
				expect(names).toContain("repo_search");
				expect(names).not.toContain("subagents");
				expect(names.find((name) => name === "repo_search" || ["read", "Read", "grep", "Grep", "find", "Glob"].includes(name))).toBe("repo_search");
				expect(result.stdout.toLowerCase() + result.stderr.toLowerCase()).toContain("src/payments.ts");
			});
		}, E2E_TIMEOUT_MS);
	}

	for (const variant of FOCUSED_PAYMENT_BEHAVIOR_PROMPTS) {
		e2eTest(`falls back to direct file/search tools when repo_* tools are unavailable (${variant.name})`, async () => {
			await withFixtureProject({ indexed: false }, async (projectDir) => {
				const result = await runPiToolSelectionE2E(projectDir, variant.prompt, `fallback selection (${variant.name})`);
				const names = toolCallNames(result.events);
				expect(names.some((name) => name.startsWith("repo_"))).toBe(false);
				expect(names).not.toContain("subagents");
				expect(names.some((name) => DIRECT_DISCOVERY_TOOLS.includes(name))).toBe(true);
				expect(result.stdout.toLowerCase() + result.stderr.toLowerCase()).toContain("src/payments.ts");
			});
		}, E2E_TIMEOUT_MS);
	}

	for (const variant of ARCHITECTURE_OVERVIEW_PROMPTS) {
		e2eTest(`uses repo_architecture before broad reads when repo_* tools are available (${variant.name})`, async () => {
			await withFixtureProject({ indexed: true }, async (projectDir) => {
				const result = await runPiToolSelectionE2E(projectDir, variant.prompt, `repo-architecture selection (${variant.name})`, { fakeIdx: true });
				const names = toolCallNames(result.events);
				expect(names).toContain("repo_architecture");
				expect(names).not.toContain("subagents");
				expect(firstMatchingTool(names, ["repo_architecture", ...DIRECT_DISCOVERY_TOOLS])).toBe("repo_architecture");
				expect(result.stdout.toLowerCase() + result.stderr.toLowerCase()).toContain("checkout");
			});
		}, E2E_TIMEOUT_MS);
	}

	for (const variant of EXACT_LITERAL_SMALL_EDIT_PROMPTS) {
		e2eTest(`uses direct search/read for exact-string small edits even when repo_* tools are available (${variant.name})`, async () => {
			await withFixtureProject({ indexed: true }, async (projectDir) => {
				const result = await runPiToolSelectionE2E(projectDir, variant.prompt, `repo-direct-exact-edit selection (${variant.name})`, { fakeIdx: true });
				const names = toolCallNames(result.events);
				expect(names).not.toContain("repo_architecture");
				expect(names).not.toContain("repo_search");
				expect(names.some((name) => DIRECT_DISCOVERY_TOOLS.includes(name))).toBe(true);
				expect(firstMatchingTool(names, ["repo_architecture", "repo_search", ...DIRECT_DISCOVERY_TOOLS])).not.toMatch(/^repo_/);
			});
		}, E2E_TIMEOUT_MS);
	}

	for (const variant of BROAD_NON_INDEXED_INVESTIGATION_PROMPTS) {
		e2eTest(`uses subagents for broad independent discovery when repo_* tools are unavailable (${variant.name})`, async () => {
			await withFixtureProject({ indexed: false }, async (projectDir) => {
				const result = await runPiToolSelectionE2E(projectDir, variant.prompt, `fallback-subagents selection (${variant.name})`);
				const names = toolCallNames(result.events);
				expect(names.some((name) => name.startsWith("repo_"))).toBe(false);
				expect(names).toContain("subagents");
			});
		}, E2E_TIMEOUT_MS);
	}

});
