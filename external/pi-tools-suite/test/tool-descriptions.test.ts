import { describe, expect, test } from "bun:test";
import {
	CLAUDE_ALIAS_TOOL_DESCRIPTIONS,
	CLAUDE_ALIAS_TOOL_DESCRIPTIONS_WITH_REPO,
	CODEX_ALIAS_TOOL_DESCRIPTIONS,
	COMPRESS_TOOL_DESCRIPTION,
	REPO_DISCOVERY_TOOLS,
	SESSION_RECOVERY_TOOL_DESCRIPTIONS,
	TODO_TOOL_DESCRIPTION,
	asyncSubagentToolDescriptions,
} from "../src/tool-descriptions.js";
import { COMPRESS_RANGE_DESCRIPTION } from "../src/dcp/prompts.js";
import { buildSubagentCatalogPrompt, SUBAGENT_TYPE_SELECTION_GUIDANCE } from "../src/async-subagents/core/agent-catalog.js";

describe("tool descriptions", () => {
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
			expect(prompt).toContain("save full stdout/stderr to a unique log; emit only TEST_RESULT");
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
		for (const prompt of [shell, bash]) expect(prompt.length).toBeLessThanOrEqual(650);
		expect(shell).toContain("Set workdir/cwd instead of cd");
		expect(shell).toContain("prefer read for simple file reads");
		expect(bash).toContain("Prefer Read/Edit/Write/Grep/Glob for file operations");
	});

	test("repo search starts without code bodies and permits only a narrow inline follow-up", () => {
		const tool = REPO_DISCOVERY_TOOLS.find((entry) => entry.name === "repo_search")!;
		expect(tool.description).toContain("First pass: at most 3 results, no --include-content");
		expect(tool.promptSnippet).toContain("keep hybrid unless lexical matches mislead");
		expect(tool.promptSnippet).toContain("offset/limit, not whole files");
		const guidance = tool.promptGuidelines.join("\n");
		expect(guidance).toContain("Grep for exact identifiers");
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
		// The six tools used 3326 characters including target descriptions before
		// this change. Strengthen guidance by replacing text, not appending policy.
		expect(REPO_DISCOVERY_TOOLS).toHaveLength(6);
		const size = REPO_DISCOVERY_TOOLS.reduce((total, tool) => total + [
			tool.description, tool.promptSnippet, ...tool.promptGuidelines, tool.targetDescription ?? "",
		].join("\n").length, 0);
		expect(size).toBeLessThanOrEqual(3326);
		for (const tool of REPO_DISCOVERY_TOOLS) expect(tool.promptGuidelines.length).toBeLessThanOrEqual(3);
	});

	test("subagents descriptions and parent catalog agree on parent-first role selection", () => {
		for (const repoAware of [true, false]) {
			const tool = asyncSubagentToolDescriptions(repoAware).subagents;
			expect(tool.description).toContain(SUBAGENT_TYPE_SELECTION_GUIDANCE);
			expect(tool.promptSnippet).toContain(SUBAGENT_TYPE_SELECTION_GUIDANCE);
			const text = [tool.description, tool.promptSnippet, ...tool.promptGuidelines].join("\n");
			expect(text).not.toContain("Usually omit subagentType");
			expect(text).not.toContain("omit subagentType unless user-named/deterministic");
			expect(text).toContain("resubmit the whole batch");
			expect(text).toContain("subagentType: \"browser-qa\"");
		}
		const catalog = buildSubagentCatalogPrompt({ types: { review: { description: "Review code." } } });
		expect(catalog).toContain(SUBAGENT_TYPE_SELECTION_GUIDANCE);
		expect(catalog).toContain("- review: Review code.");
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
		expect(promptText).toContain("Never use `clear`, `delete`");
	});

	test("session recovery prompt guides overview-first raw-history recovery", () => {
		const tools = Object.values(SESSION_RECOVERY_TOOL_DESCRIPTIONS);
		const promptText = tools.flatMap((tool) => [
			tool.description,
			tool.promptSnippet,
			...(tool.promptGuidelines ?? []),
		]).join("\n");

		expect(tools.map((tool) => tool.name)).toEqual([
			"session_overview",
			"session_read_section",
			"session_search",
			"session_recovery_context",
		]);
		expect(promptText).toContain("Use session_overview first");
		expect(promptText).toContain("raw session history");
		expect(promptText).toContain("lexical rather than semantic");
		expect(promptText).toContain("recentErrors as historical evidence");
	});

	test("subagents prompt keeps explicit delegation triggers in repo-aware mode", () => {
		const tool = asyncSubagentToolDescriptions(true).subagents;
		const promptText = [tool.description, tool.promptSnippet, ...tool.promptGuidelines].join("\n");

		expect(promptText).toContain("delegate/parallelize/split work");
		expect(promptText).toContain("one sequential task can qualify");
		expect(promptText).toContain("do not let repo_* availability suppress delegation");
		expect(promptText).toContain("one discovery question");
		expect(promptText).toContain("subagentType: \"browser-qa\"");
		expect(promptText).toContain("generated `.pi/qa_auth.jsonc` template path");
		expect(promptText).toContain("clickable screenshot, video, and trace links");
		expect(promptText).toContain("mandatory delegation trigger");
		expect(promptText).toContain("before checking prerequisites");
		expect(promptText).toContain("parent must not inspect the project first");
		expect(promptText).toContain("known target URL/app, user-visible flow, expected observable result, and required artifacts");
		expect(promptText).toContain("Do not turn it into a repository investigation plan");
		expect(promptText).toContain("invent a mock/synthetic target");
	});

	test("subagents prompt prioritizes broad fallback delegation when repo tools are unavailable", () => {
		const tool = asyncSubagentToolDescriptions(false).subagents;
		const promptText = [tool.description, tool.promptSnippet, ...tool.promptGuidelines].join("\n");

		expect(promptText).toContain("repo_* tools are unavailable");
		expect(promptText).toContain("incident-triage hypotheses");
		expect(promptText).toContain("delegate bounded research tracks");
		expect(promptText).toContain("call action='spawn' as the first discovery step");
	});
});
