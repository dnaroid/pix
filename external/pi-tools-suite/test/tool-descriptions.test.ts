import { describe, expect, test } from "bun:test";
import {
	CLAUDE_ALIAS_TOOL_DESCRIPTIONS,
	CLAUDE_ALIAS_TOOL_DESCRIPTIONS_WITH_REPO,
	CODEX_ALIAS_TOOL_DESCRIPTIONS,
	COMPRESS_TOOL_DESCRIPTION,
	REPOSITORY_DISCOVERY_GUIDELINES,
	SESSION_TOOL_DESCRIPTION,
	TODO_TOOL_DESCRIPTION,
	asyncSubagentToolDescriptions,
	astGrepToolDescriptions,
	codexAliasToolDescriptions,
} from "../src/tool-descriptions.js";
import projectSearch from "../src/project-search/index.js";
import { COMPRESS_RANGE_DESCRIPTION } from "../src/dcp/prompts.js";
import { TodoParamsSchema } from "../src/todo/tool/types.js";
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

	test("repository guidance uses available search without IDX-only tools", () => {
		const prompt = REPOSITORY_DISCOVERY_GUIDELINES.join("\n");
		expect(prompt).toContain("project_search");
		expect(prompt).toContain("sources=['code','knowledge']");
		expect(prompt).toContain("read the original files");
		for (const retired of ["repo_context", "repo_inspect", "repo_audit"]) expect(prompt).not.toContain(retired);
	});

	test("project_search preserves focused search guidance alongside the global configuration command", () => {
		let registered: any;
		const commands: string[] = [];
		const events: string[] = [];
		projectSearch({ registerTool: (tool: any) => { registered = tool; }, registerCommand: (name: string) => { commands.push(name); },
			on: (name: string) => { events.push(name); } } as never);
		expect(commands).toEqual(["search-semantic", "search-index"]);
		// Saved tasks, session chunks, manual indexing and source metadata each
		// own a lifecycle; running-agent events also fence idle session indexing.
		expect(events).toEqual([
			"session_start", "session_shutdown",
			"session_start", "agent_start", "agent_end", "turn_end", "message_end", "session_tree", "session_shutdown",
			"session_start", "session_shutdown",
			"session_start", "session_shutdown",
		]);
		expect(registered.name).toBe("project_search");
		expect(registered.promptSnippet).toContain("First pass maxFiles=3, no includeContent");
		expect(registered.promptSnippet).toContain("Start focused lookup with project_search using only enabled sources");
		expect(registered.parameters.properties.sources.items.enum).toEqual(["code"]);
		const guidance = registered.promptGuidelines.join("\n");
		expect(guidance).toContain("Only enabled project sources may be searched or indexed");
		expect(guidance).toContain("Global embedding configuration authorizes uploads but does not override the project selection");
		expect(guidance).toContain("Never configure providers on the user’s behalf");
		expect(guidance).not.toContain("Session searches can fill missing chunk vectors");
		expect(guidance).not.toContain("independent Desktop opt-ins");
		expect(guidance).not.toContain("independent project consent");
		expect(guidance).toContain("pathPrefix/dedupeFile");
		expect(guidance).toContain("Exact identifiers: available Grep/grep or shell with rg");
		expect(guidance).toContain("includeContent only for a narrow follow-up");
		expect(guidance).toContain("maxFiles=1");
		expect(guidance).toContain("Stop broad search");
		expect(registered.parameters.properties.indexMode.enum).toEqual(["hybrid", "semantic", "lexical"]);
		expect(registered.parameters.properties.includeContent.default).toBe(false);
	});

	test("repository guidance retains contracts and decision policy", () => {
		const text = REPOSITORY_DISCOVERY_GUIDELINES.join("\n");
		expect(text).toContain("material behavior change");
		expect(text).toContain("knowledge-auditor");
		expect(text).toContain("primary spec");
		expect(text).toContain("semantic drift");
		expect(text).toContain("specs/TEMPLATE.md");
		expect(text).toContain("kind: spec");
		expect(text).toContain("ask before creating one");
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
			expect(tool.description).toContain("Keep the primary spec aligned");
			expect(tool.description).not.toContain("repo_audit");
			expect(tool.description).not.toContain("repo_knowledge");
		}
	});

	test("documentation review stays task-scoped without mandatory audit receipts", () => {
		const text = REPOSITORY_DISCOVERY_GUIDELINES.join("\n");
		expect(text).toContain("Review affected documentation against final source and tests");
		expect(text).toContain("no dirty check, acknowledgment or exhaustive dependency review is required");
		expect(text).not.toMatch(/idx knowledge|every declared Implementation\/Tests dependency|Close the audit todo/);
		for (const tool of [CLAUDE_ALIAS_TOOL_DESCRIPTIONS_WITH_REPO.Edit, CLAUDE_ALIAS_TOOL_DESCRIPTIONS_WITH_REPO.Write, codexAliasToolDescriptions(true).applyPatch]) {
			expect(tool.description).toContain("Keep the primary spec aligned");
			expect(tool.description).not.toMatch(/repo_audit|knowledge-auditor|dirty|acknowledge/);
		}
	});

	test("subagent guidance requests documentation maintenance without knowledge-state gates", () => {
		for (const repoAware of [true, false]) {
			const tool = asyncSubagentToolDescriptions(repoAware).subagents;
			const text = [tool.description, tool.promptSnippet, ...tool.promptGuidelines].join("\n");
			expect(text).toContain("use the available knowledge-auditor to update affected documentation");
			expect(text).not.toMatch(/knowledge-audit gates|idx knowledge/);
		}
	});

	test("subagents descriptions and parent catalog agree on parent-first role selection", () => {
		for (const repoAware of [true, false]) {
			const tool = asyncSubagentToolDescriptions(repoAware).subagents;
			expect(tool.description).toContain(SUBAGENT_TYPE_SELECTION_GUIDANCE);
			expect(tool.promptSnippet).toContain("Choose a role from the effective catalog");
			expect(tool.promptSnippet).toContain("a serial parent checklist is not delegation");
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
			expect(assembled).toContain("When oracle is present in the current role catalog");
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
		expect(promptText).toContain("without quoting their markers or narrating their removal");
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
		expect(promptText).toContain("rather than creating a duplicate task");
		expect(promptText).toContain("Skip single trivial tasks");
		expect(TODO_TOOL_DESCRIPTION.description).toContain("no progress journals");
		expect(promptText).toContain("For create/update and batch items");
		expect(promptText).toContain("Omit description when the subject suffices");
		expect(promptText).toContain("1–2 short sentences");
		expect(promptText).toContain("Replace stale details rather than appending progress history");
		expect(promptText).toContain("On completion, update status without expanding the description");
		expect(promptText).toContain("normally send only action, id and status");
		expect(promptText).toContain("Change description only when scope, criteria, blocker or next action changes");
		expect(promptText).toContain("replace obsolete details with the current blocker and next action");
		expect(promptText).toContain("put test results and detailed evidence in the final response");
		expect(promptText).toContain("stop without cosmetic text updates or applying background results");
		expect(JSON.stringify(TodoParamsSchema.properties.subject)).toContain("Short action phrase");
		expect(JSON.stringify(TodoParamsSchema.properties.description)).toContain("1–2 short sentences");
		expect(JSON.stringify(TodoParamsSchema.properties.description)).not.toContain("Long-form");
		expect(JSON.stringify(TodoParamsSchema.properties.description)).toContain("normally omit on completion");
		expect(JSON.stringify(TodoParamsSchema.properties.activeForm)).toContain("not a progress report");
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
		expect(promptText).toContain("a concrete capability gap");
		expect(promptText).toContain("sufficiently large prescribed mechanical work with deterministic checks and an expected net saving");
		expect(promptText).toContain("seek a bounded read-only oracle opinion first");
		expect(promptText).toContain("Task size, parallelism, isolation, token price, or worker availability alone do not justify delegation");
		expect(promptText).toContain("duplicated context, briefing and integration");
		expect(promptText).not.toContain("substantial independent task that can run alongside useful parent work");
		expect(promptText).not.toContain("prefer implement (Luna");
		expect(promptText).toContain("Mandatory UI QA, architectural review and final documentation maintenance remain exceptions");
		expect(promptText).not.toContain("sequential task qualifies");
		expect(promptText).not.toContain("A substantive bounded edit can be delegated");
		expect(promptText).toContain("Delegate independent tracks/hypotheses/review axes");
		expect(promptText).toContain("repository discovery");
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

	test("oracle guidance bounds scope without inventing short watchdog caps in either tool mode", () => {
		for (const repoAware of [false, true]) {
			const prompt = asyncSubagentToolDescriptions(repoAware).subagents.description;
			expect(prompt).toContain("Bound scope instead: one question/invariant");
			expect(prompt).toContain("omit spawn-level and task-level timeoutSeconds");
			expect(prompt).toContain("30 minutes by default");
			expect(prompt).toContain("unless the user explicitly requests a shorter budget");
			expect(prompt).toContain("exact task diff/paths and exclusions, not a repository-wide audit");
			expect(prompt).toContain("A watchdog timeout means incomplete work");
			expect(prompt).toContain("not proof of a provider stall; do not switch models automatically");
		}
	});

	test("subagents prompt prioritizes broad fallback delegation when repo tools are unavailable", () => {
		const tool = asyncSubagentToolDescriptions(false).subagents;
		const promptText = [tool.description, tool.promptSnippet, ...tool.promptGuidelines].join("\n");

		expect(promptText).toContain("For incident triage");
		expect(promptText).toContain("separate hypotheses/review tracks");
		expect(promptText).toContain("prefer focused agents");
		expect(promptText).not.toContain("repo_context");
	});
});
