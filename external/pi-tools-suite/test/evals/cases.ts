import type { EvalCase, EvalRunResult } from "./harness/types.js";

const DIRECT_TOOLS = ["read", "Read", "grep", "Grep", "find", "Glob", "bash", "Bash", "shell", "shell_command"];
const MUTATION_TOOLS = ["edit", "Edit", "write", "Write", "apply_patch", "ast_apply"];
const NO_ORCHESTRATION = ["subagents", "async_subagents_spawn"];

export const EVAL_CASES: EvalCase[] = [
	{
		id: "tool.semantic-repo-search",
		category: "tool-selection",
		description: "Unknown behavior owner should use semantic repo search before direct reads.",
		fixture: "demo",
		indexed: true,
		fakeIdx: true,
		prompt: "Users report duplicate charges after payment retry. Find the code path that creates the gateway payment request, identify the risky retry-key behavior, and cite the owning file. I do not know the file or symbol yet.",
		assert: { requiredTools: ["repo_search"], forbiddenTools: NO_ORCHESTRATION, firstToolOneOf: ["repo_search", "todo"], stdoutIncludes: ["src/payments.ts"] },
	},
	{
		id: "tool.architecture-first",
		category: "tool-selection",
		description: "Broad unfamiliar architecture request should start with indexed architecture.",
		fixture: "demo",
		indexed: true,
		fakeIdx: true,
		prompt: "Give me a compact architecture overview of this unfamiliar checkout project: main modules, responsibilities, and dependency flow. Do not perform a code review or change files.",
		assert: { requiredTools: ["repo_architecture"], forbiddenTools: [...NO_ORCHESTRATION, ...MUTATION_TOOLS], firstToolOneOf: ["repo_architecture", "todo"] },
	},
	{
		id: "tool.exact-literal-direct",
		category: "tool-selection",
		description: "Exact literal lookup should avoid semantic/architecture discovery.",
		fixture: "demo",
		indexed: true,
		fakeIdx: true,
		prompt: "Find the exact literal `✅ typescript: no diagnostics` in this project and tell me the file. This is an exact-string lookup only; do not edit anything.",
		assert: { forbiddenTools: ["repo_architecture", "repo_search", ...NO_ORCHESTRATION, ...MUTATION_TOOLS], firstToolOneOf: DIRECT_TOOLS, stdoutIncludes: ["docs/lsp-diagnostics.md"] },
	},
	{
		id: "tool.ast-structural",
		category: "tool-selection",
		description: "Syntax-aware structural question should select ast_grep rather than plain text search.",
		fixture: "demo",
		blockTools: ["ast_grep"],
		prompt: "Use syntax-aware structural matching to find exported functions whose body calls another function and return the matching function names. I need AST structure, not an exact string/regex search. Stop after the structural search.",
		assert: { requiredTools: ["ast_grep"], forbiddenTools: ["repo_search", "repo_architecture", ...NO_ORCHESTRATION, ...MUTATION_TOOLS], firstToolOneOf: ["ast_grep", "todo"] },
	},
	{
		id: "tool.todo-plan",
		category: "tool-selection",
		description: "Non-trivial four-stage change should initialize synchronized todo state.",
		fixture: "demo",
		prompt: "Before exploring files, initialize one tracked four-stage plan for this non-trivial change: investigate checkout behavior; implement the fix; run focused and full verification; prepare the final user-facing report. Mark exactly one first stage in progress. Stop after creating the plan.",
		assert: { requiredTools: ["todo"], forbiddenTools: NO_ORCHESTRATION, maxToolCalls: 2 },
		validate: validateTodoPlan,
	},
	{
		id: "tool.session-recovery-overview",
		category: "tool-selection",
		description: "Lost context without a search phrase should begin with session_overview.",
		fixture: "demo",
		prompt: "My working context was aggressively compressed and I no longer remember the task. I have no reliable phrase to search for. Use the appropriate raw-session recovery tool first and stop immediately after that first tool call.",
		assert: { firstTool: "session_overview", maxToolCalls: 1 },
	},
	{
		id: "quality.two-hypotheses-before-fix",
		category: "coding-quality",
		description: "Debugging should reproduce and distinguish plausible causes before mutation.",
		fixture: "coding-hypotheses",
		prompt: "Fix the retry-key bug described in README. Do not assume the first plausible cause is correct: inspect the relevant flow, reproduce the failure, implement the smallest complete fix, run the behavioral tests, and check one regression/counterexample before reporting.",
		assert: {
			requireReproBeforeMutation: true,
			requireVerificationAfterMutation: true,
			maxMutations: 2,
			maxFilesChanged: 2,
			postRunCommands: [
				{ command: "npm test", stdoutIncludes: ["retry-key behavior ok"] },
				{ command: "node --input-type=module -e \"import('./src/retry.js').then(({retryKeyFor,resetRetryKeys})=>{resetRetryKeys(); if(retryKeyFor('u','a')!=='u:a'||retryKeyFor('u','a')!=='u:a'||retryKeyFor('u','b')!=='u:b') process.exit(1)})\"" },
			],
		},
	},
	{
		id: "quality.behavior-over-structural-check",
		category: "coding-quality",
		description: "A type-valid rounding fix must be validated by behavior, not just structural checks.",
		fixture: "coding-regression",
		prompt: "Fix the discount rounding bug described in README. Reproduce it first, preserve validation and the API, then verify the behavioral claim rather than stopping at syntax/type validity. Check a boundary case before finalizing.",
		assert: {
			requireReproBeforeMutation: true,
			requireVerificationAfterMutation: true,
			maxMutations: 2,
			maxFilesChanged: 1,
			postRunCommands: [
				{ command: "npm test", stdoutIncludes: ["discount behavior ok"] },
				{ command: "node --input-type=module -e \"import('./src/discount.js').then(({discountedPrice})=>{if(discountedPrice(1998,25)!==1498||discountedPrice(1,50)!==0)process.exit(1);try{discountedPrice(10,-1);process.exit(1)}catch(e){if(!(e instanceof RangeError))process.exit(1)}})\"" },
			],
		},
	},
	{
		id: "quality.async-stale-state",
		category: "coding-quality",
		description: "Async state fix must cover stale completion behavior.",
		fixture: "coding-async",
		prompt: "Fix the stale async profile state bug described in README. Reproduce the race, inspect success/stale completion behavior, make the smallest fix, and verify both the normal and stale-order paths before reporting.",
		assert: {
			requireReproBeforeMutation: true,
			requireVerificationAfterMutation: true,
			maxMutations: 3,
			maxFilesChanged: 2,
			postRunCommands: [{ command: "npm test", stdoutIncludes: ["stale async state protected"] }],
		},
	},
	{
		id: "quality.investigate-without-edit-probes",
		category: "coding-quality",
		description: "Root-cause investigation should not mutate code merely to test a hypothesis.",
		fixture: "coding-hypotheses",
		prompt: "Investigate the retry-key bug and explain the root cause with evidence, but do not modify files. Consider at least the cache identity and caller-input hypotheses, and use inspection/tests to distinguish them.",
		assert: { forbiddenTools: [...MUTATION_TOOLS, ...NO_ORCHESTRATION], maxFilesChanged: 0, stdoutIncludes: ["cache"] },
	},
	{
		id: "quality.counterexample-preserves-validation",
		category: "coding-quality",
		description: "Fix should preserve nearby validation while checking a counterexample.",
		fixture: "coding-regression",
		prompt: "Repair the one-cent discount bug. Keep the existing invalid-input behavior intact and explicitly verify a 0% or 100% boundary after the fix. Run the behavioral test before and after editing.",
		assert: {
			requireReproBeforeMutation: true,
			requireVerificationAfterMutation: true,
			maxFilesChanged: 1,
			postRunCommands: [{ command: "node --input-type=module -e \"import('./src/discount.js').then(({discountedPrice})=>{if(discountedPrice(777,0)!==777||discountedPrice(777,100)!==0)process.exit(1);try{discountedPrice(10,101);process.exit(1)}catch(e){if(!(e instanceof RangeError))process.exit(1)}})\"" }],
		},
	},
	{
		id: "orchestration.sol-delegates-substantial",
		category: "orchestration",
		description: "Expensive Sol parent should delegate substantial multi-file implementation work.",
		fixture: "demo",
		models: [/gpt-5\.6-sol/i],
		blockTools: ["subagents"],
		prompt: "Implement checkout hardening across payments and discounts, add focused tests, update rollout documentation, and verify the integrated result. This is substantial multi-file implementation work; keep the parent focused on integration and verification.",
		assert: { requiredTools: ["subagents"] },
	},
	{
		id: "orchestration.sol-keeps-tiny-edit",
		category: "orchestration",
		description: "Sol should not delegate a tiny exact known-file edit.",
		fixture: "demo",
		models: [/gpt-5\.6-sol/i],
		prompt: "In docs/lsp-diagnostics.md replace the exact phrase `no diagnostics` with `clean diagnostics`. This is a tiny known-file wording edit. Make only that edit and verify the text.",
		assert: { forbiddenTools: NO_ORCHESTRATION, maxFilesChanged: 1 },
	},
	{
		id: "orchestration.luna-delegates-substantial",
		category: "orchestration",
		description: "Luna should use a stronger worker for substantial multi-file implementation/research.",
		fixture: "demo",
		models: [/gpt-5\.6-luna/i],
		blockTools: ["subagents"],
		prompt: "Investigate payment/idempotency risks, strengthen the implementation, add tests, and update the rollout plan across this checkout project. Use the configured tiered delegation strategy for substantial work.",
		assert: { requiredTools: ["subagents"] },
	},
	{
		id: "orchestration.luna-escalates-high-risk",
		category: "orchestration",
		description: "Luna should escalate a high-risk cross-module security/public-API decision.",
		fixture: "demo",
		models: [/gpt-5\.6-luna/i],
		blockTools: ["subagents"],
		prompt: "Perform a high-risk security and public-API review of payment retries, raw gateway payload auditing, and rollout safety. Resolve cross-module invariants and propose the safest design; use a stronger independent review/deep escalation where the strategy calls for it.",
		assert: { requiredTools: ["subagents"] },
	},
	{
		id: "orchestration.terra-escalates-high-risk",
		category: "orchestration",
		description: "Terra should escalate high-risk architecture/security uncertainty to Sol roles.",
		fixture: "demo",
		models: [/gpt-5\.6-terra/i],
		blockTools: ["subagents"],
		prompt: "Review a proposed change that would alter payment retry semantics, audit persistence, and the public checkout contract. This is high-risk architecture/security work with subtle cross-module invariants; use the configured deep/review escalation when appropriate.",
		assert: { requiredTools: ["subagents"] },
	},
	{
		id: "negative.trivial-chat-no-tools",
		category: "negative",
		description: "Trivial chat should not trigger planning, compression, or orchestration.",
		fixture: "demo",
		prompt: "In one short sentence, what does JSON stand for?",
		assert: { forbiddenTools: ["todo", "compress", ...NO_ORCHESTRATION], maxToolCalls: 0 },
	},
	{
		id: "negative.known-file-read-no-oracle",
		category: "negative",
		description: "One known-file factual read should use the cheapest direct path.",
		fixture: "demo",
		prompt: "Read package.json and tell me only the package name. Do not change anything.",
		assert: { forbiddenTools: ["todo", "repo_architecture", "repo_search", ...NO_ORCHESTRATION, ...MUTATION_TOOLS], firstToolOneOf: ["read", "Read", "shell", "Bash", "bash"] },
	},
	{
		id: "negative.routine-local-failure-no-oracle",
		category: "negative",
		description: "Straightforward local failing test should be fixed locally without oracle escalation.",
		fixture: "coding-regression",
		prompt: "The local discount test is failing. Reproduce it, fix the straightforward rounding defect, rerun the test, and stop. This is a narrow local bug, not an architecture review.",
		assert: { forbiddenTools: NO_ORCHESTRATION, requireReproBeforeMutation: true, requireVerificationAfterMutation: true, maxFilesChanged: 1, postRunCommands: [{ command: "npm test" }] },
	},
	{
		id: "negative.small-known-edit-no-plan",
		category: "negative",
		description: "Tiny known-file edit should not create todo or subagent overhead.",
		fixture: "demo",
		prompt: "In docs/lsp-diagnostics.md change `product polish` to `UI polish`. This is a tiny known-file wording edit; make only that replacement.",
		assert: { forbiddenTools: ["todo", "repo_architecture", "repo_search", ...NO_ORCHESTRATION], maxFilesChanged: 1 },
	},
];

function validateTodoPlan(result: EvalRunResult): string[] {
	const call = result.events.find((event) => event.type === "tool_call" && event.toolName === "todo");
	if (!isRecord(call?.input)) return ["todo input was not recorded as an object"];
	const input = call.input;
	if (input.action !== "batch_create") return [`expected todo action=batch_create, got ${String(input.action)}`];
	const items = Array.isArray(input.items) ? input.items.filter(isRecord) : [];
	if (items.length !== 4) return [`expected four todo items, got ${items.length}`];
	if (items.filter((item) => item.status === "in_progress").length !== 1) return ["expected exactly one in_progress todo item"];
	const final = items.find((item) => /final|report|итог/i.test(`${String(item.subject ?? "")} ${String(item.description ?? "")}`));
	return final ? [] : ["final report todo item was not present"];
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
