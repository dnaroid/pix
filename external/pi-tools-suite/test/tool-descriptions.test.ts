import { describe, expect, test } from "bun:test";
import {
	CLAUDE_ALIAS_TOOL_DESCRIPTIONS,
	CLAUDE_ALIAS_TOOL_DESCRIPTIONS_WITH_REPO,
	CODEX_ALIAS_TOOL_DESCRIPTIONS,
	COMPRESS_TOOL_DESCRIPTION,
	REPO_DISCOVERY_TOOLS,
	SESSION_TOOL_DESCRIPTION,
	TODO_TOOL_DESCRIPTION,
	asyncSubagentToolDescriptions,
	astGrepToolDescriptions,
	codexAliasToolDescriptions,
} from "../src/tool-descriptions.js";
import { COMPRESS_RANGE_DESCRIPTION } from "../src/dcp/prompts.js";
import { buildSubagentCatalogPrompt, SUBAGENT_TYPE_SELECTION_GUIDANCE } from "../src/async-subagents/core/agent-catalog.js";
import { agentStrategyPrompt, SUBAGENT_DELEGATION_GUIDANCE } from "../src/async-subagents/core/agent-strategy.js";

describe("tool descriptions", () => {
	test("text and path lookups have available-tool fallbacks without weakening AST-first routing", () => {
		const tool = astGrepToolDescriptions(2000, "50KB").astGrep;
		for (const text of [tool.description, tool.promptSnippet, tool.promptGuidelines.join("\n")]) {
			expect(text).toContain("Grep/grep");
			expect(text).toContain("Glob/find");
			expect(text).toContain("shell with rg");
			expect(text).toContain("shell with rg --files");
		}
		expect(tool.description).toContain("ast_grep must be the FIRST tool call");
		expect(tool.promptGuidelines.join("\n")).toContain("Never call unavailable tools");
	});
	test("shell aliases share a compact pre-delivery test-output contract", () => {
		const prompts = [
			CODEX_ALIAS_TOOL_DESCRIPTIONS.shellCommand.description,
			CLAUDE_ALIAS_TOOL_DESCRIPTIONS.Bash.description,
			CLAUDE_ALIAS_TOOL_DESCRIPTIONS_WITH_REPO.Bash.description,
		];
		const guidance = prompts[0].slice(prompts[0].indexOf("Tests:"));
		for (const prompt of prompts) {
			expect(prompt.slice(prompt.indexOf("Tests:"))).toBe(guidance);
			expect(prompt.match(/TEST_RESULT/g)).toHaveLength(1);
			expect(prompt).toContain("save full stdout/stderr to a unique log under the current project's .pi/artifacts/");
			expect(prompt).toContain("never root artifacts/ or .artifacts/");
			expect(prompt).toContain("emit only TEST_RESULT");
			expect(prompt).toContain("command, original exit code, verified counts (or unknown), and log path");
			expect(prompt).toContain("Omit per-test PASS lines");
			expect(prompt).toContain("bounded exact failure diagnostics and flag omissions");
			expect(prompt).toContain("Read only needed log ranges, never dump it");
			expect(prompt).not.toContain("show only bounded tail on failure");
		}
	});

	test("shell test guidance preserves outcome and verification scope", () => {
		for (const prompt of [CODEX_ALIAS_TOOL_DESCRIPTIONS.shellCommand.description, CLAUDE_ALIAS_TOOL_DESCRIPTIONS.Bash.description]) {
			expect(prompt).toContain("passed/failed/incomplete");
			expect(prompt).toContain("Preserve test exit status; timeout/abort is incomplete");
			expect(prompt).toContain("Prefer supported compact reporters");
			expect(prompt).toContain("do not alter tests/config just to shorten output");
		}
	});

	test("shell guidance stays bounded and retains file-tool routing", () => {
		const shell = CODEX_ALIAS_TOOL_DESCRIPTIONS.shellCommand.description;
		const bash = CLAUDE_ALIAS_TOOL_DESCRIPTIONS.Bash.description;
		// Keep the full description, including routing and test policy, compact.
		for (const prompt of [shell, bash]) expect(prompt.length).toBeLessThanOrEqual(750);
		expect(shell).toContain("Set workdir/cwd instead of cd");
		expect(shell).toContain("prefer read for simple file reads");
		expect(bash).toContain("Prefer Read/Edit/Write/Grep/Glob for file operations");
	});

	test("repo guidance selects another indexed project explicitly and preserves its root across calls", () => {
		const context = REPO_DISCOVERY_TOOLS.find((tool) => tool.name === "repo_context")!;
		const guidance = context.promptGuidelines.join("\n");
		expect(guidance).toContain("For any repo_* tool, pass projectPath when the task targets another project");
		expect(guidance).toContain("omit it for the current project");
		expect(guidance).toContain("same selected root for related calls");
		expect(guidance).toContain("targets, scopes and audit paths relative to it");
		expect(guidance).toContain("absolute, session-cwd-relative or ~/ paths");
		expect(guidance).toContain("requires .indexer-cli directly in that root");
		expect(guidance).toContain("does not change cwd");
		expect(guidance).toContain("do not run setup implicitly");
		expect(guidance).toContain("Resolve returned file paths against that root when using read");
	});

	test("repo search starts without code bodies and permits only a narrow inline follow-up", () => {
		const tool = REPO_DISCOVERY_TOOLS.find((entry) => entry.name === "repo_search")!;
		expect(tool.description).toContain("First pass: at most 3 results, no --include-content");
		expect(tool.promptSnippet).toContain("keep hybrid unless lexical matches mislead");
		expect(tool.promptSnippet).toContain("offset/limit, not whole files");
		const guidance = tool.promptGuidelines.join("\n");
		expect(guidance).toContain("Exact identifiers: available Grep/grep or shell with rg");
		expect(guidance).toContain("--path-prefix/--dedupe-file");
		expect(guidance).toContain("--include-content only for a narrow follow-up");
		expect(guidance).toContain("--max-files 1");
		expect(guidance).toContain("stop broad search");
		expect(guidance).toContain("callers, persistence or tests only for a named gap");
	});

	test("repo maps prefer scoped pages and exact reads over large trees or snippets", () => {
		const architecture = REPO_DISCOVERY_TOOLS.find((entry) => entry.name === "repo_architecture")!;
		expect(architecture.promptSnippet).toContain("skip repo_architecture for known paths or exact lookups");
		expect(architecture.promptGuidelines.join("\n")).toContain("--path-prefix");
		const structure = REPO_DISCOVERY_TOOLS.find((entry) => entry.name === "repo_structure")!;
		expect(structure.promptSnippet).toContain("--max-files 20 --max-depth 2");
		expect(structure.promptSnippet).toContain("--cursor");
		expect(structure.promptGuidelines.join("\n")).toContain("--include-tests-summary only for a named gap");
		const ast = REPO_DISCOVERY_TOOLS.find((entry) => entry.name === "repo_ast")!;
		expect(ast.promptSnippet).toContain("--max-depth 3 --max-nodes 40 --no-include-text");
		expect(ast.promptSnippet).toContain("offset/limit");
		expect(ast.promptGuidelines.join("\n")).toContain("--cursor");
	});

	test("repo symbol and impact guidance allows scoped details without default expansion", () => {
		const explain = REPO_DISCOVERY_TOOLS.find((entry) => entry.name === "repo_explain")!;
		expect(explain.promptSnippet).toContain("--signature-only when signatures suffice");
		expect(explain.promptGuidelines.join("\n")).toContain("--include-body --body-lines 20");
		const deps = REPO_DISCOVERY_TOOLS.find((entry) => entry.name === "repo_deps")!;
		expect(deps.promptSnippet).toContain("--depth 1");
		expect(deps.promptSnippet).toContain("--direction callers or callees");
		expect(deps.promptGuidelines.join("\n")).toContain("--mode calls");
		expect(deps.promptGuidelines.join("\n")).toContain("--show-edges/--tests or deeper traversal only for a named impact-analysis gap");
	});

	test("repo guidance fits within the pre-economy description budget", () => {
		const existing = REPO_DISCOVERY_TOOLS.filter((tool) => !["context", "audit"].includes(tool.command));
		expect(REPO_DISCOVERY_TOOLS).toHaveLength(8);
		const size = existing.reduce((total, tool) => total + [
			tool.description, tool.promptSnippet, ...tool.promptGuidelines, tool.targetDescription ?? "",
		].join("\n").length, 0);
		expect(size).toBeLessThanOrEqual(3326);
		for (const tool of REPO_DISCOVERY_TOOLS) expect(tool.promptGuidelines.length).toBeLessThanOrEqual(3);
	});

	test("repo guidance starts with context, routes contracts and changed paths, and omits removed wiki lifecycle", () => {
		const names = REPO_DISCOVERY_TOOLS.map((tool) => tool.name);
		expect(names.slice(0, 2)).toEqual(["repo_context", "repo_audit"]);
		const text = REPO_DISCOVERY_TOOLS.flatMap((tool) => [tool.description, tool.promptSnippet, ...tool.promptGuidelines]).join("\n");
		expect(text).toContain("general indexed behavior/task discovery");
		expect(text).toContain("parent model");
		expect(text).toContain("material behavior change");
		expect(text).toContain("knowledge-auditor");
		expect(text).toContain("primary spec");
		expect(text).toContain("semantic drift");
		expect(text).toContain(".indexer-cli/spec-template.md");
		expect(text).toContain("kind: spec");
		expect(text).toContain("ask before running setup");
		expect(text).toContain("read linked decision records");
		expect(text).toContain("historical rationale is not the current contract");
		expect(text).toContain("evidence vs assumptions");
		expect(text).toContain("never invent motives from code");
		expect(text).toContain("Supersede old decisions explicitly");
		expect(text).toContain("Default to no new decision record");
		expect(text).toContain("only when explicitly requested by the user");
		expect(text).toContain("costly reversal AND its durable rationale");
		expect(text).toContain("useful in six months");
		expect(text).toContain("changed specs alone are not triggers");
		expect(text).toContain("Do not invent alternatives; link existing applicable records");
		expect(text).toContain("missing rationale is an escalation only for qualifying choices");
		expect(text).toContain("Do not prune or rewrite historical records");
		expect(text).not.toContain("repo_ask");
		expect(text).not.toMatch(/wiki|include-secondary|action=impact|receiptPath/);
		for (const tool of [CLAUDE_ALIAS_TOOL_DESCRIPTIONS_WITH_REPO.Edit, CLAUDE_ALIAS_TOOL_DESCRIPTIONS_WITH_REPO.Write, codexAliasToolDescriptions(true).applyPatch]) {
			expect(tool.description).toContain("repo_audit");
			expect(tool.description).not.toContain("repo_knowledge");
		}
	});

	test("knowledge finalization covers receipts and fallback without mechanical bypass or prompt bloat", () => {
		const audit = REPO_DISCOVERY_TOOLS.find((tool) => tool.name === "repo_audit")!;
		const text = [audit.promptSnippet, ...audit.promptGuidelines].join("\n");
		expect(text).toContain("Obtain the result");
		expect(text).toContain("missing review coverage");
		expect(text).toContain("mechanical edits still need review-state checks");
		expect(text).toContain("auditor (or parent fallback)");
		expect(text).toContain("every declared Implementation/Tests dependency");
		expect(text).toContain("idx knowledge acknowledge <spec-paths...>");
		expect(text).toContain("then rechecks dirty");
		expect(text).toContain("never bulk-acknowledge unrelated specs");
		expect(text.length).toBeLessThan(2000);
		for (const tool of [CLAUDE_ALIAS_TOOL_DESCRIPTIONS_WITH_REPO.Edit, CLAUDE_ALIAS_TOOL_DESCRIPTIONS_WITH_REPO.Write, codexAliasToolDescriptions(true).applyPatch]) {
			expect(tool.description).toContain("repo_audit finalization guidance");
			expect(tool.description).not.toContain("skip for mechanical");
		}
	});

	test("task audit completion does not depend on global knowledge cleanliness", () => {
		const audit = REPO_DISCOVERY_TOOLS.find((tool) => tool.name === "repo_audit")!;
		const text = [audit.promptSnippet, ...audit.promptGuidelines].join("\n");
		expect(text).toContain("Close the audit todo when task-scoped review is complete");
		expect(text).toContain("global knowledge dirty=yes alone must not keep it open");
		expect(text).toContain("task audit passed/blocked separately from global dirty yes/no/unknown");
		expect(text).toContain("unclassified global dirtiness alone is not a task blocker");
		expect(text).toContain("concurrent changes to reviewed specs/dependencies still require resolution");
	});

	test("subagents descriptions and parent catalog agree on parent-first role selection", () => {
		for (const repoAware of [true, false]) {
			const tool = asyncSubagentToolDescriptions(repoAware).subagents;
			expect(tool.description).toContain(SUBAGENT_TYPE_SELECTION_GUIDANCE);
			expect(tool.promptSnippet).toContain("Choose a role from the effective catalog");
			const text = [tool.description, tool.promptSnippet, ...tool.promptGuidelines].join("\n");
			expect(text).not.toContain("Usually omit subagentType");
			expect(text).not.toContain("omit subagentType unless user-named/deterministic");
			expect(text).toContain("resubmit the whole batch");
			expect(text).toContain("subagentType: \"ui-qa\"");
		}
		const catalog = buildSubagentCatalogPrompt({ types: { review: { description: "Review code." } } });
		expect(catalog).toContain(SUBAGENT_TYPE_SELECTION_GUIDANCE);
		expect(catalog).toContain("- review: Review code.");
	});

	test("the assembled guidance emits the full delegation policy only once, even without a strategy", () => {
		for (const env of [{}, { PI_AGENT_STRATEGY: "off" }]) {
			const tool = asyncSubagentToolDescriptions(true).subagents;
			const assembled = [tool.description, tool.promptSnippet, ...tool.promptGuidelines,
				agentStrategyPrompt({ env }), buildSubagentCatalogPrompt({ types: { research: {} } }),
			].join("\n");
			expect(assembled.split(SUBAGENT_DELEGATION_GUIDANCE)).toHaveLength(2);
			expect(assembled).toContain("When frontier-review is present in the current role catalog");
			expect(assembled).toContain("before checking prerequisites");
			expect(assembled).toContain("knowledge-auditor");
		}
	});

	test("apply_patch prompt documents begin-patch and unified diff support", () => {
		const promptText = CODEX_ALIAS_TOOL_DESCRIPTIONS.applyPatch.description;

		expect(promptText).toContain("unified diff");
		expect(promptText).toContain("*** Begin Patch");
		expect(promptText).toContain("*** Move to:");
		expect(promptText).toContain("*** End of File");
		expect(promptText).toContain("<<EOF");
		expect(promptText).toContain("workspace-relative");
	});

	test("compress prompt encourages context-pressure housekeeping after completed work", () => {
		const promptText = [
			COMPRESS_TOOL_DESCRIPTION.description,
			COMPRESS_TOOL_DESCRIPTION.promptSnippet,
			...(COMPRESS_TOOL_DESCRIPTION.promptGuidelines ?? []),
		].join("\n");

		expect(promptText).toContain("closed stale context");
		expect(promptText).toContain("pressure/reminders justify it");
		expect(promptText).toContain("low context alone is not a trigger");
		expect(promptText).toContain("large tool/log output");
		expect(promptText).toContain("keep active or still-needed raw context");
		expect(COMPRESS_TOOL_DESCRIPTION.description).toBe(COMPRESS_RANGE_DESCRIPTION);
	});

	test("todo prompt locks the model-facing workflow invariants", () => {
		const promptText = [
			TODO_TOOL_DESCRIPTION.description,
			TODO_TOOL_DESCRIPTION.promptSnippet,
			...(TODO_TOOL_DESCRIPTION.promptGuidelines ?? []),
		].join("\n");

		expect(promptText).toContain("complex work with 3+ steps");
		expect(promptText).toContain("Skip single trivial tasks");
		expect(promptText).toContain("final user-facing report todo");
		expect(promptText).toContain("changed files/behavior, verification results, and remaining manual actions");
		expect(promptText).toContain("close it immediately before the final response");
		expect(promptText).toContain("do not issue a redundant update");
		expect(promptText).toContain("Resync before continuing");
		expect(promptText).toContain("reactivate and reuse an equivalent deferred todo instead of duplicating it");
		expect(promptText).toContain("list and reconcile all visible todos, including deferred ones");
		expect(promptText).toContain("Do not finish with stale/duplicate deferred todos");
		expect(promptText).toContain("exactly one in_progress");
		expect(promptText).toContain("return the blocked task to pending with a recorded blocker");
		expect(promptText).toContain("mark only the new current task in_progress");
		expect(promptText).not.toContain("If partial, tests fail, or blocked, keep the task in_progress");
		expect(promptText).toContain("Never use `clear`, `delete`");
	});

	test("session recovery prompt guides overview-first raw-history recovery", () => {
		const tools = [SESSION_TOOL_DESCRIPTION];
		const promptText = tools.flatMap((tool) => [
			tool.description,
			tool.promptSnippet,
			...(tool.promptGuidelines ?? []),
		]).join("\n");

		expect(tools.map((tool) => tool.name)).toEqual(["session"]);
		expect(promptText).toContain("Use session action=overview first");
		expect(promptText).toContain("raw session history");
		expect(promptText).toContain("lexically, not semantically");
		expect(promptText).toContain("recentErrors as historical evidence");
	});

	test("subagents prompt keeps explicit delegation triggers in repo-aware mode", () => {
		const tool = asyncSubagentToolDescriptions(true).subagents;
		const promptText = [tool.description, tool.promptSnippet, ...tool.promptGuidelines].join("\n");

		expect(promptText).toContain("delegate/parallelize/split work");
		expect(promptText).toContain("Write code in the parent by default");
		expect(promptText).toContain("substantial independent task that can run alongside useful parent work");
		expect(promptText).toContain("Mandatory UI QA, review and knowledge-audit gates remain exceptions");
		expect(promptText).not.toContain("sequential task qualifies");
		expect(promptText).not.toContain("A substantive bounded edit can be delegated");
		expect(promptText).toContain("do not let repo_* availability suppress delegation");
		expect(promptText).toContain("general discovery");
		expect(promptText).toContain("subagentType: \"ui-qa\"");
		expect(promptText).toContain("generated `.pi/qa_auth.jsonc` template path");
		expect(promptText).toContain("clickable screenshot, terminal capture, video, trace");
		expect(promptText).toContain("mandatory delegation trigger");
		expect(promptText).toContain("before checking prerequisites");
		expect(promptText).toContain("parent must not inspect the project first");
		expect(promptText).toContain("known target URL/app/command, actions to perform, expected observable outcome, and requested evidence");
		expect(promptText).toContain("Do not turn it into a repository investigation plan");
		expect(promptText).toContain("invent a mock/synthetic target");
	});

	test("subagents prompt prioritizes broad fallback delegation when repo tools are unavailable", () => {
		const tool = asyncSubagentToolDescriptions(false).subagents;
		const promptText = [tool.description, tool.promptSnippet, ...tool.promptGuidelines].join("\n");

		expect(promptText).toContain("repo_* tools are unavailable");
		expect(promptText).toContain("incident-triage hypotheses");
		expect(promptText).toContain("delegate scoped research");
		expect(promptText).toContain("call action='spawn' as the first discovery step");
	});
});
