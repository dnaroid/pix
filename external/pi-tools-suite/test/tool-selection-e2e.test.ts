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
const RUN_E2E = /^(1|true|yes)$/i.test(
	process.env.TOOL_SELECTION_E2E ?? process.env.PROMPT_EVAL_E2E ?? "",
);
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

const INJECTED_DCP_REMINDER = `<dcp-system-reminder>
ACTION REQUIRED: Context usage is high. Before any more exploration, compress the immediately preceding closed stale material using only currently injected valid boundary IDs. Use message mode for one stale message or range mode for a multi-message slice. Preserve only continuation-critical facts, do not infer missing details, and drop disposable repeated output.
</dcp-system-reminder>`;

const INJECTED_DCP_HISTORY = [
	{
		role: "user",
		content: [{ type: "text", text: "Investigate the duplicate checkout charge and finish the investigation before the next implementation phase." }],
		timestamp: 1,
	},
	{
		role: "assistant",
		content: [{ type: "text", text: `Investigation complete and closed.
USER_INTENT_RAVEN: fix duplicate checkout charges without changing the public API.
CONSTRAINT_NO_SCHEMA_CHANGE: do not alter the database schema.
DECISION_USE_IDEMPOTENCY_KEY: use the existing payment idempotency key.
ERROR_E409_RETRY_LOOP: the focused retry test still fails with E409.
NEXT_STEP_PATCH_PAYMENTS_TS: patch src/payments.ts, then rerun the focused test.
Disposable output followed: DISPOSABLE_LOG_LINE_777 repeated many times. No additional implementation detail was established.` }],
		timestamp: 2,
		api: "openai-completions",
		provider: "zai",
		model: "prompt-eval-history",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
	},
];

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

function writeToolRecorderExtension(
	projectDir: string,
	options: { injectDcpReminder?: boolean } = {},
): { extensionPath: string; historyExtensionPath?: string; logPath: string } {
	const extensionPath = path.join(projectDir, ".pi", "tool-selection-recorder.ts");
	const historyExtensionPath = options.injectDcpReminder
		? path.join(projectDir, ".pi", "tool-selection-history-injector.ts")
		: undefined;
	const logPath = path.join(projectDir, ".pi", "tool-selection-events.jsonl");
	fs.mkdirSync(path.dirname(extensionPath), { recursive: true });
	fs.writeFileSync(extensionPath, `
import * as fs from "node:fs";

const LOG_PATH = ${JSON.stringify(logPath)};
const BLOCKED_TOOLS = new Set(${JSON.stringify(options.injectDcpReminder ? ["subagents"] : ["subagents", "compress"])});
const INJECT_DCP_REMINDER = ${JSON.stringify(options.injectDcpReminder === true)};

function append(event: unknown) {
  fs.mkdirSync(${JSON.stringify(path.dirname(logPath))}, { recursive: true });
  fs.appendFileSync(LOG_PATH, JSON.stringify(event) + "\\n", "utf-8");
}

export default function recorder(pi: any) {
  if (INJECT_DCP_REMINDER) {
    let reminderInjected = false;
    pi.on("context", async (event: any) => {
      if (reminderInjected) return undefined;
      reminderInjected = true;
      return { messages: [...event.messages, {
        role: "user",
        content: [{ type: "text", text: ${JSON.stringify(INJECTED_DCP_REMINDER)} }],
        timestamp: Date.now(),
      }] };
    });
  }
  pi.on("tool_call", async (event: any) => {
    append({ type: "tool_call", toolName: event.toolName, input: event.input ?? null });
    if (BLOCKED_TOOLS.has(event.toolName)) {
      return { block: true, reason: event.toolName + " execution is blocked by the tool-selection e2e recorder; the call was captured, so do not retry it" };
    }
  });
  pi.on("tool_result", async (event: any) => {
    append({ type: "tool_result", toolName: event.toolName, isError: event.isError === true });
  });
}
`, "utf-8");
	if (historyExtensionPath) {
		fs.writeFileSync(historyExtensionPath, `
const DCP_HISTORY = ${JSON.stringify(INJECTED_DCP_HISTORY)};

export default function historyInjector(pi: any) {
  let historyInjected = false;
  pi.on("context", async (event: any) => {
    if (historyInjected) return undefined;
    historyInjected = true;
    return { messages: [...DCP_HISTORY, ...event.messages] };
  });
}
`, "utf-8");
	}
	return { extensionPath, historyExtensionPath, logPath };
}

function writeFakeIdxBin(projectDir: string): string {
	const binDir = path.join(projectDir, ".pi", "fake-bin");
	const idxPath = path.join(binDir, "idx");
	const logPath = path.join(projectDir, ".pi", "idx-events.jsonl");
	fs.mkdirSync(binDir, { recursive: true });
	fs.writeFileSync(idxPath, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args }) + "\\n");
const command = args[0] || "";
const joined = args.join(" ").toLowerCase();
if (command === "context" && joined.includes("shipment freeze")) {
  console.log("CONTEXT query=shipment freeze behavior\\nWarnings:\\n! No primary knowledge matched the query.\\nRead next:\\n> src/payments.ts");
} else if (command === "context") {
  console.log("CONTEXT query=payment retry idempotency\\nPrimary knowledge:\\nS specs/payment-retry.md status=fresh lifecycle=active score=9.10\\nImplementation:\\nC src/payments.ts:19-33 reason=tracked+semantic\\nTests:\\nT test/payments.test.ts reason=explicit conf=high");
} else if (command === "wiki" && args[1] === "search") {
  if (joined.includes("shipment freeze")) console.log("no indexed project knowledge matched");
  else console.log("score=9.10 active fresh specs/payment-retry.md — Payment retry contract\\n      Payment retries reuse a stable idempotency key.");
} else if (command === "wiki" && args[1] === "impact") {
  if (joined.includes("src/audit.ts")) {
    console.log("changed: 1 | known affected: 0 | uncovered: 1 | changed docs: 0 | semantic sweep: yes\\n  uncovered src/audit.ts\\n  candidates src/audit.ts: specs/payment-retry.md");
  } else if (joined.includes("retry-contract.md")) {
    console.log("changed: 2 | known affected: 0 | uncovered: 0 | changed docs: 1 | semantic sweep: yes\\n  missing specs/payment-retry.md\\n  doc specs/payments/retry-contract.md — unclassified — score=8 spec-candidate");
  } else {
    console.log("changed: 1 | known affected: 1 | uncovered: 0 | changed docs: 0 | semantic sweep: yes\\n  known specs/payment-retry.md — inputs-changed — src/payments.ts");
  }
} else if (command === "wiki" && args[1] === "record") {
  const pathIndex = args.indexOf("--path");
  console.log("recorded spec: " + (args[pathIndex + 1] || "unknown") + " — unverified");
} else if (command === "wiki" && args[1] === "verify") {
  const pathIndex = args.indexOf("--path");
  console.log("verified: " + (args[pathIndex + 1] || "unknown") + " — fresh");
} else if (command === "search") {
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
	options: { fakeIdx?: boolean; injectDcpReminder?: boolean } = {},
): Promise<{ stdout: string; stderr: string; events: ToolEvent[] }> {
	if (!E2E_MODEL) throw new Error("TOOL_SELECTION_E2E_MODEL/PI_TOOLS_SUITE_E2E_MODEL resolved to an empty model");

	return withE2ERetry(label, async () => {
		const sessionDir = path.join(projectDir, ".pi", `e2e-session-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(sessionDir, { recursive: true });
		const recorder = writeToolRecorderExtension(projectDir, options);
		fs.rmSync(recorder.logPath, { force: true });
		const fakeBin = options.fakeIdx ? writeFakeIdxBin(projectDir) : undefined;
		const extensionArgs = recorder.historyExtensionPath
			? ["--extension", recorder.historyExtensionPath, "--extension", EXTENSION_ENTRYPOINT, "--extension", recorder.extensionPath]
			: ["--extension", EXTENSION_ENTRYPOINT, "--extension", recorder.extensionPath];
		const args = [
			"--model", E2E_MODEL,
			...extensionArgs,
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

const TODO_PLAN_PROMPT = `
Before exploring files, initialize a tracked four-stage implementation plan in one operation for this non-trivial change:
1. investigate the current checkout behavior;
2. implement the fix;
3. run focused and full verification;
4. prepare the user-facing final report.

Mark exactly the first stage in progress and leave the others pending. The final report stage must have acceptance criteria containing the exact phrases "changed files and behavior", "verification results", and "remaining manual actions". Stop immediately after initializing the plan.`;

const COMPRESS_HIGH_PRESSURE_PROMPT = `
The earlier checkout investigation is closed, and I am about to begin the next implementation phase. Follow any injected context-pressure instruction before doing anything else. Do not inspect the repository first, and stop immediately after handling that instruction.`;

const TRIVIAL_CHAT_PROMPT = "In one short sentence, what does JSON stand for?";

const SESSION_RECOVERY_PROMPT = `
My working context was aggressively compressed and I no longer remember the task.
I do not know a reliable phrase to search for. Use the appropriate raw-session recovery tool first, and stop immediately after that first tool call.`;

const KNOWLEDGE_BEHAVIOR_PROMPT = `
Before changing checkout payment retry behavior, find the current authoritative project contract and the implementation/tests that enforce it.
I do not know which spec file contains the requirement. Use the indexed project knowledge path rather than broad filesystem discovery, then stop after the first useful knowledge result.`;

const KNOWLEDGE_IMPACT_PROMPT = `
I just completed a material behavior change in src/payments.ts that changes payment retry/idempotency behavior.
Before finishing, perform the project-contract maintenance checkpoint for this task-scoped changed path. Do not broaden to the whole dirty worktree; stop after the impact result.`;

const KNOWLEDGE_CREATE_SPEC_PROMPT = `
We are planning a new externally visible "shipment freeze" behavior: high-risk checkout requests must be held before payment submission.
Before implementation, check indexed project knowledge for an existing primary contract. If no suitable primary contract exists, create one focused active Change spec under specs/ describing the intended behavior and non-goals, then record that source in project knowledge. Do not modify production code/tests yet and do not verify an unimplemented change. Stop after the new spec is recorded.`;

const KNOWLEDGE_UPDATE_SPEC_PROMPT = `
The material behavior change in src/payments.ts is intentional and already complete: each gateway payment request now gets a fresh idempotency key; this is the desired current contract.
The existing specs/payment-retry.md still says retries reuse the same stable idempotency key. Finish knowledge maintenance only: run task-scoped impact for src/payments.ts, inspect the spec and implementation, update the existing primary spec to the desired current behavior, then semantically verify it. Do not change production code or tests.`;

const KNOWLEDGE_NO_IMPACT_PROMPT = `
I changed only src/audit.ts formatting and event-label rendering; it should not change checkout/payment behavior.
Run the task-scoped project-knowledge impact review for src/audit.ts. If a nearby payment spec appears only as a semantic candidate, inspect enough evidence to decide whether it is actually affected. A reviewed no-impact result is valid: do not edit specs, verify specs, or create a relation just to make coverage non-empty. Stop after the review.`;

const KNOWLEDGE_MOVE_SPEC_PROMPT = `
The primary payment retry contract was moved without semantic changes from specs/payment-retry.md to specs/payments/retry-contract.md; the source bytes are already moved and production code is unchanged.
Reconcile project knowledge for this move: run task-scoped impact on the moved document path(s), inspect the moved source, record the new primary path with the same current semantics, verify it against its existing code evidence, then remove only the old knowledge metadata. Do not rewrite the moved spec or production code.`;

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
				expect(names).not.toContain("repo_knowledge");
				expect(names.some((name) => DIRECT_DISCOVERY_TOOLS.includes(name))).toBe(true);
				expect(firstMatchingTool(names, ["repo_architecture", "repo_search", ...DIRECT_DISCOVERY_TOOLS])).not.toMatch(/^repo_/);
			});
		}, E2E_TIMEOUT_MS);
	}

	e2eTest("uses repo_knowledge context for an authoritative behavior/contract question", async () => {
		await withFixtureProject({ indexed: true }, async (projectDir) => {
			const result = await runPiToolSelectionE2E(projectDir, KNOWLEDGE_BEHAVIOR_PROMPT, "repo-knowledge context selection", { fakeIdx: true });
			const calls = result.events.filter((event) => event.type === "tool_call");
			expect(calls[0]?.toolName).toBe("repo_knowledge");
			expect(calls[0]?.input).toMatchObject({ action: "context" });
			expect(result.stdout.toLowerCase() + result.stderr.toLowerCase()).toContain("specs/payment-retry.md");
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("uses task-scoped repo_knowledge impact after a material behavior change", async () => {
		await withFixtureProject({ indexed: true }, async (projectDir) => {
			const result = await runPiToolSelectionE2E(projectDir, KNOWLEDGE_IMPACT_PROMPT, "repo-knowledge impact selection", { fakeIdx: true });
			const calls = result.events.filter((event) => event.type === "tool_call");
			expect(calls[0]?.toolName).toBe("repo_knowledge");
			expect(calls[0]?.input).toMatchObject({ action: "impact", paths: ["src/payments.ts"] });
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("creates and records a new primary spec when no suitable contract exists", async () => {
		await withFixtureProject({ indexed: true }, async (projectDir) => {
			const paymentsPath = path.join(projectDir, "src", "payments.ts");
			const paymentsBefore = fs.readFileSync(paymentsPath, "utf8");
			const result = await runPiToolSelectionE2E(projectDir, KNOWLEDGE_CREATE_SPEC_PROMPT, "repo-knowledge create-spec maintenance", { fakeIdx: true });
			const calls = result.events.filter((event) => event.type === "tool_call");
			const knowledgeCalls = calls.filter((event) => event.toolName === "repo_knowledge");
			expect(knowledgeCalls.some((event) => isRecord(event.input) && ["context", "search"].includes(String(event.input.action)))).toBe(true);
			expect(knowledgeCalls.some((event) => isRecord(event.input) && event.input.action === "record" && event.input.sourceReviewed === true)).toBe(true);
			expect(knowledgeCalls.some((event) => isRecord(event.input) && event.input.action === "verify")).toBe(false);

			const specsDir = path.join(projectDir, "specs");
			expect(fs.existsSync(specsDir)).toBe(true);
			const specFiles = fs.readdirSync(specsDir).filter((name) => name.endsWith(".md"));
			expect(specFiles.length).toBeGreaterThan(0);
			const specText = specFiles.map((name) => fs.readFileSync(path.join(specsDir, name), "utf8")).join("\n").toLowerCase();
			expect(specText).toContain("shipment");
			expect(specText).toContain("freeze");
			expect(fs.readFileSync(paymentsPath, "utf8")).toBe(paymentsBefore);
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("updates an existing primary spec and verifies after intentional semantic drift", async () => {
		await withFixtureProject({ indexed: true }, async (projectDir) => {
			const specDir = path.join(projectDir, "specs");
			fs.mkdirSync(specDir, { recursive: true });
			const specPath = path.join(specDir, "payment-retry.md");
			fs.writeFileSync(specPath, [
				"# Payment retry contract",
				"",
				"## Type",
				"As-Is",
				"",
				"## Lifecycle",
				"Active",
				"",
				"## Behavior",
				"Retries reuse the same stable idempotency key for the same checkout.",
				"",
				"## Related files",
				"- `src/payments.ts`",
				"",
			].join("\n"), "utf8");
			const paymentsPath = path.join(projectDir, "src", "payments.ts");
			const paymentsBefore = fs.readFileSync(paymentsPath, "utf8");

			const result = await runPiToolSelectionE2E(projectDir, KNOWLEDGE_UPDATE_SPEC_PROMPT, "repo-knowledge update-spec maintenance", { fakeIdx: true });
			const knowledgeCalls = result.events.filter((event) => event.type === "tool_call" && event.toolName === "repo_knowledge");
			expect(knowledgeCalls.some((event) => isRecord(event.input) && event.input.action === "impact" && Array.isArray(event.input.paths) && event.input.paths.includes("src/payments.ts"))).toBe(true);
			expect(knowledgeCalls.some((event) => isRecord(event.input) && event.input.action === "verify" && event.input.evidenceReviewed === true)).toBe(true);
			const updated = fs.readFileSync(specPath, "utf8").toLowerCase();
			expect(updated).not.toContain("reuse the same stable idempotency key");
			expect(updated).toMatch(/fresh|new|unique|per[- ]request|random/);
			expect(fs.readFileSync(paymentsPath, "utf8")).toBe(paymentsBefore);
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("accepts reviewed no-impact without inventing a relation or spec mutation", async () => {
		await withFixtureProject({ indexed: true }, async (projectDir) => {
			const specDir = path.join(projectDir, "specs");
			fs.mkdirSync(specDir, { recursive: true });
			const specPath = path.join(specDir, "payment-retry.md");
			fs.writeFileSync(specPath, "# Payment retry contract\n\nPayment retry semantics are unrelated to audit label formatting.\n", "utf8");
			const beforeSpec = fs.readFileSync(specPath, "utf8");
			const beforeAudit = fs.readFileSync(path.join(projectDir, "src", "audit.ts"), "utf8");

			const result = await runPiToolSelectionE2E(projectDir, KNOWLEDGE_NO_IMPACT_PROMPT, "repo-knowledge no-impact maintenance", { fakeIdx: true });
			const calls = result.events.filter((event) => event.type === "tool_call");
			const knowledgeCalls = calls.filter((event) => event.toolName === "repo_knowledge");
			expect(knowledgeCalls.some((event) => isRecord(event.input) && event.input.action === "impact" && Array.isArray(event.input.paths) && event.input.paths.includes("src/audit.ts"))).toBe(true);
			for (const forbiddenAction of ["record", "relate", "verify", "remove"]) {
				expect(knowledgeCalls.some((event) => isRecord(event.input) && event.input.action === forbiddenAction)).toBe(false);
			}
			expect(calls.some((event) => ["Edit", "Write", "edit", "write", "apply_patch", "ast_apply"].includes(event.toolName ?? ""))).toBe(false);
			expect(fs.readFileSync(specPath, "utf8")).toBe(beforeSpec);
			expect(fs.readFileSync(path.join(projectDir, "src", "audit.ts"), "utf8")).toBe(beforeAudit);
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("reconciles a moved primary spec without rewriting its source", async () => {
		await withFixtureProject({ indexed: true }, async (projectDir) => {
			const oldPath = path.join(projectDir, "specs", "payment-retry.md");
			const newPath = path.join(projectDir, "specs", "payments", "retry-contract.md");
			fs.mkdirSync(path.dirname(oldPath), { recursive: true });
			fs.writeFileSync(oldPath, [
				"# Payment retry contract",
				"",
				"## Type",
				"As-Is",
				"",
				"## Lifecycle",
				"Active",
				"",
				"## Behavior",
				"Each gateway request receives a fresh idempotency key.",
				"",
				"## Related files",
				"- `../../src/payments.ts`",
				"",
			].join("\n"), "utf8");
			fs.mkdirSync(path.dirname(newPath), { recursive: true });
			fs.renameSync(oldPath, newPath);
			const movedBefore = fs.readFileSync(newPath, "utf8");
			const paymentsPath = path.join(projectDir, "src", "payments.ts");
			const paymentsBefore = fs.readFileSync(paymentsPath, "utf8");

			const result = await runPiToolSelectionE2E(projectDir, KNOWLEDGE_MOVE_SPEC_PROMPT, "repo-knowledge move-spec maintenance", { fakeIdx: true });
			const knowledgeCalls = result.events.filter((event) => event.type === "tool_call" && event.toolName === "repo_knowledge");
			expect(knowledgeCalls.some((event) => isRecord(event.input) && event.input.action === "impact")).toBe(true);
			expect(knowledgeCalls.some((event) => isRecord(event.input) && event.input.action === "record" && event.input.path === "specs/payments/retry-contract.md" && event.input.sourceReviewed === true)).toBe(true);
			expect(knowledgeCalls.some((event) => isRecord(event.input) && event.input.action === "verify" && event.input.path === "specs/payments/retry-contract.md" && event.input.evidenceReviewed === true)).toBe(true);
			expect(knowledgeCalls.some((event) => isRecord(event.input) && event.input.action === "remove" && event.input.path === "specs/payment-retry.md" && event.input.metadataOnlyConfirmed === true)).toBe(true);
			expect(fs.readFileSync(newPath, "utf8")).toBe(movedBefore);
			expect(fs.readFileSync(paymentsPath, "utf8")).toBe(paymentsBefore);
			expect(fs.existsSync(oldPath)).toBe(false);
		});
	}, E2E_TIMEOUT_MS);

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

	e2eTest("creates a synchronized todo plan for non-trivial multi-stage work", async () => {
		await withFixtureProject({ indexed: false }, async (projectDir) => {
			const result = await runPiToolSelectionE2E(projectDir, TODO_PLAN_PROMPT, "todo plan selection");
			const todoCalls = result.events.filter((event) => event.type === "tool_call" && event.toolName === "todo");
			expect(todoCalls).toHaveLength(1);

			const input = todoCalls[0]!.input;
			expect(isRecord(input)).toBe(true);
			expect((input as Record<string, unknown>).action).toBe("batch_create");
			const items = (input as { items?: unknown[] }).items ?? [];
			expect(items).toHaveLength(4);
			expect(items.filter((item) => isRecord(item) && item.status === "in_progress")).toHaveLength(1);

			const finalReport = items.find((item) => {
				if (!isRecord(item)) return false;
				const text = `${String(item.subject ?? "")} ${String(item.description ?? "")}`.toLowerCase();
				return text.includes("final report") || text.includes("итог");
			});
			expect(finalReport).toBeDefined();
			const acceptance = String((finalReport as Record<string, unknown>).description ?? "").toLowerCase();
			expect(acceptance).toContain("changed files and behavior");
			expect(acceptance).toContain("verification results");
			expect(acceptance).toContain("remaining manual actions");
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("compresses a high-pressure closed range with continuation-critical details", async () => {
		await withFixtureProject({ indexed: false }, async (projectDir) => {
			const result = await runPiToolSelectionE2E(projectDir, COMPRESS_HIGH_PRESSURE_PROMPT, "compress high-pressure selection", { injectDcpReminder: true });
			expect(toolCallNames(result.events)[0]).toBe("compress");
			const compressCalls = result.events.filter((event) => event.type === "tool_call" && event.toolName === "compress");
			expect(compressCalls).toHaveLength(1);

			const input = compressCalls[0]!.input;
			expect(isRecord(input)).toBe(true);
			const ranges = (input as { ranges?: unknown[] }).ranges ?? [];
			const messages = (input as { messages?: unknown[] }).messages ?? [];
			expect(ranges.length + messages.length).toBe(1);
			if (ranges.length === 1) {
				expect(ranges[0]).toMatchObject({ startId: expect.stringMatching(/^m\d{3}$/), endId: expect.stringMatching(/^m\d{3}$/) });
			} else {
				expect(messages[0]).toMatchObject({ messageId: expect.stringMatching(/^m\d{3}$/) });
			}
			const selected = ranges[0] ?? messages[0];
			const summary = String(isRecord(selected) ? selected.summary ?? "" : "");
			const normalizedSummary = summary.toLowerCase();
			for (const fact of [
				/duplicate (?:checkout )?charge/,
				/public api/,
				/(?:database schema|schema change)/,
				/idempotency key/,
				/e409/,
				/src\/payments\.ts/,
				/rerun/,
			]) expect(normalizedSummary).toMatch(fact);
			expect(summary).not.toContain("DISPOSABLE_LOG_LINE_777");
			expect(summary).not.toContain("Date.now");
			expect(summary).not.toContain("Math.random");
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("starts unknown-query context recovery with session_overview", async () => {
		await withFixtureProject({ indexed: false }, async (projectDir) => {
			const result = await runPiToolSelectionE2E(projectDir, SESSION_RECOVERY_PROMPT, "session overview recovery selection");
			expect(toolCallNames(result.events)[0]).toBe("session_overview");
		});
	}, E2E_TIMEOUT_MS);

	e2eTest("does not create todos or compress for a trivial chat question", async () => {
		await withFixtureProject({ indexed: false }, async (projectDir) => {
			const result = await runPiToolSelectionE2E(projectDir, TRIVIAL_CHAT_PROMPT, "trivial chat negative control");
			const names = toolCallNames(result.events);
			expect(names).not.toContain("todo");
			expect(names).not.toContain("compress");
			expect(names).not.toContain("subagents");
		});
	}, E2E_TIMEOUT_MS);
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
