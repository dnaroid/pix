import { COMPRESS_RANGE_DESCRIPTION } from "./dcp/prompts.js";
import { PROJECT_ARTIFACTS_DIR } from "./artifact-paths.js";
import { SUBAGENT_TYPE_SELECTION_GUIDANCE } from "./async-subagents/core/agent-catalog.js";
import { SUBAGENT_DELEGATION_GUIDANCE } from "./async-subagents/core/agent-strategy.js";

export type ToolDescription = {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
};

export type RepoDiscoveryCommand = "context" | "audit" | "inspect";

export type RepoDiscoveryToolDescription = ToolDescription & Required<Pick<ToolDescription, "promptSnippet" | "promptGuidelines">> & {
	command: RepoDiscoveryCommand;
	targetDescription?: string;
};

export type ToolDescriptionSetOptions = {
	repoDiscovery?: boolean;
};

function hasRepoDiscovery(options: ToolDescriptionSetOptions | boolean = false): boolean {
	return typeof options === "boolean" ? options : options.repoDiscovery === true;
}

export const COMPRESS_TOOL_DESCRIPTION: ToolDescription = {
	name: "compress",
	label: "Compress Context",
	description: COMPRESS_RANGE_DESCRIPTION,
	promptSnippet: "Compress only closed, high-yield stale context when pressure/reminders justify it; keep active or still-needed raw context. Write the summary yourself.",
	promptGuidelines: [
		"Prefer completed work and understood large tool/log output; low context alone is not a trigger.",
		"Before submitting a summary, remove incidental log markers entirely, including sentences announcing their removal. Preserve actionable error identifiers, constraints, decisions and next steps instead.",
	],
};

export function astGrepToolDescriptions(maxLines: number, maxBytesLabel: string) {
	return {
		astGrep: {
			name: "ast_grep",
			label: "ast-grep",
			description: `Read-only AST structural search/scan. MANDATORY ROUTING: for structural, syntax-aware, AST, language-aware, or code-shape matching, ast_grep must be the FIRST tool call. Never preflight with Glob, Grep, Read, or shell even when files are unknown; omit paths to scan the current project. Use for sgconfig/rule scans, JSON matches, and rewrite previews. For text-only search use available Grep/grep, otherwise shell with rg; for paths use available Glob/find, otherwise shell with rg --files. Use ast_apply for mutations. Output truncates at ${maxLines} lines or ${maxBytesLabel} with full output saved to a temp file.`,
			promptSnippet: "MANDATORY: structural/syntax-aware/AST/code-shape matching => call ast_grep FIRST, without preliminary file discovery. Text-only search: available Grep/grep or shell with rg; paths only: available Glob/find or shell with rg --files. Use ast_apply for mutations.",
			promptGuidelines: [
				"The first tool for syntax relationships or code-shape matching must be ast_grep, even when the file or language is unknown. Do not make a preliminary Glob/Grep/Read/shell call; start at the current project and narrow within ast_grep when needed.",
				"For exact literal/regex lookups use available Grep/grep or shell with rg; for filename/path-only discovery use available Glob/find or shell with rg --files. Read known paths directly. Never call unavailable tools or route text-only searches through ast_grep.",
				"ast_grep is read-only: use rewrite to preview only; use ast_apply for mutations or command=scan fixes.",
			],
		},
		astApply: {
			name: "ast_apply",
			label: "ast-apply",
			description: `Mutating AST rewrite/fix tool powered by ast-grep. Use for structural replacements or scan fixes after you know the pattern/rule is correct. Reports changedFiles for post-edit diagnostics and truncates output at ${maxLines} lines or ${maxBytesLabel}.`,
			promptSnippet: "Use ast_apply only when you intend to mutate files with ast-grep structural rewrites or scan fixes.",
			promptGuidelines: [
				"Use ast_apply for AST-aware bulk edits, not simple one-off text replacements; preview with ast_grep when matches are uncertain.",
				"Pattern rewrites: command=run with pattern/rewrite/lang; rule fixes: command=scan with rule, inlineRules, or config.",
			],
		},
	} satisfies Record<string, ToolDescription>;
}

export function asyncSubagentToolDescriptions(options: ToolDescriptionSetOptions | boolean = false) {
	const repoDiscovery = hasRepoDiscovery(options);

	return {
		subagents: {
			name: "subagents",
			label: "Subagents",
			description: [
				"For every real user-interface QA request (browser, terminal/TUI, or desktop GUI), immediately spawn subagentType='ui-qa' before checking files, URLs, servers, launch commands, or other prerequisites; the QA sub-agent owns feasibility checks and blocked reports, so the parent must not substitute static checks for requested UI QA.",
				"If ui-qa browser testing reports that credentials are required, it must identify the generated project-local template and explicitly ask the user to fill it; the parent relays that request without reading or editing the credential file.",
				"After UI testing, ui-qa must return clickable links for every available screenshot, terminal capture, video, trace, or other retained evidence; the parent must preserve those links in its user-facing report.",
				SUBAGENT_DELEGATION_GUIDANCE,
				"Each agent role owns an ordered model candidate list. Parent-provider policy and runtime availability select the first usable candidate; project-local .pi/agents/*.md files may replace role profiles. Do not override the model merely to choose a role.",
				SUBAGENT_TYPE_SELECTION_GUIDANCE,
				"When knowledge-auditor appears in the effective catalog, use it for the final task-scoped repository-knowledge pass after implementation; give it the concise final behavior/result plus exact task-changed project-relative paths, and handle any escalation in the parent.",
				repoDiscovery
					? "Use for broad independent tracks, review axes, or hypotheses even though repo_* tools are available."
					: "Use first for broad codebase discovery split into tracks, review axes, or incident-triage hypotheses when repo_* tools are unavailable.",
				"Use action=spawn/status/wait/result/stop/cleanup; .pi/subagents tracks runs so status/wait/stop can omit the latest runDir and result can resolve by agentId. Parent sessions receive completion/failure follow-ups, so spawn can return without polling.",
				"Results are compact with artifact links. Agents run isolated pi processes with extensions disabled to prevent recursive spawning; spawn/task timeoutSeconds can shorten the default 30m watchdog, project concurrency queues excess agents, and retry backoff/fallback models/Antigravity account rotation are config-driven.",
			].join(" "),
			promptSnippet:
				"When the user requests independent investigation/review tracks, spawn scoped research agents before doing those tracks yourself; a serial parent checklist is not delegation. For other delegation see this tool's description. Real UI QA immediately uses ui-qa before preflight; preserve evidence links and credential boundaries. Choose a role from the effective catalog. Continue independent work after spawning. Obtain the final knowledge-auditor result when available.",
			promptGuidelines: [
				"Treat every real UI QA request as a mandatory delegation trigger and an explicit exception to the large/parallel threshold: immediately spawn with `subagentType: \"ui-qa\"` before checking prerequisites. The QA sub-agent owns target discovery, feasibility checks, UI automation, evidence, and blocked reports; the parent must not inspect the project first or substitute non-UI checks.",
				"Keep the ui-qa task payload at the user-visible acceptance level: known target URL/app/command, actions to perform, expected observable outcome, and requested evidence. Do not turn it into a repository investigation plan, name internal files or commands, dictate setup, or invent a mock/synthetic target. Leave unknown prerequisites to the QA sub-agent.",
				"When ui-qa browser testing reports missing credentials, relay its explicit request and generated `.pi/qa_auth.jsonc` template path; never inspect, populate, or edit that credential file in the parent.",
				"After ui-qa completes a test, preserve its clickable screenshot, terminal capture, video, trace, and other evidence links in the final user-facing response whenever those artifacts exist.",
				"When `knowledge-auditor` is present in the effective role catalog, use it as the final repository-knowledge handoff: supply the concise final behavior/result and exact task-changed project-relative paths; accept small documentation repairs from the child and keep substantial/ambiguous decisions in the parent.",
				repoDiscovery
					? "For general discovery, start with repo_context; use project_search for focused code/document lookup. Spawn for independent tracks/hypotheses/review axes, and do not let repo_* availability suppress delegation."
					: "For one small discovery question, use direct read/grep; when repo_* tools are unavailable, delegate scoped research to keep broad search output outside the parent context.",
				repoDiscovery
					? "For incident triage, release readiness, or risk/test strategy with separate hypotheses/review tracks, prefer focused agents over serial parent-context work."
					: "For incident triage, release readiness, or risk/test strategy with separate hypotheses/review tracks and no repo_* tools, call action='spawn' as the first discovery step; direct read/grep can follow.",
				"Do not use subagents for trivial exact-string lookups, typo replacements, or interactive user input; use the cheapest direct path.",
				"Spawn multiple focused agents in one action='spawn' call for independent questions; set subagentType for clear role matches, timeoutSeconds for bounded probes, and use oracle sparingly for high-stakes uncertainty/final checks.",
				"If spawn reports a routing error, no agents from that batch were launched. Correct the invalid or unresolved subagentType values using the available catalog and resubmit the whole batch; do not blindly retry omitted types or substitute an unsuitable role to suppress the error.",
				"For screenshot/image inspection by blind models, use lookup; subagents only receive imagePaths when a broader delegated track genuinely needs them.",
				"If asked to start/run/launch/test parallel sub-agents, spawn and stop; do not status/wait just for progress. Continue independent parent work after spawn. Use status for recovery, wait only when a child result is a true dependency and no independent parent work remains, and result only after completion; compact results include artifact links. If requirements change, stop or rescope affected workers before they continue editing.",
				"Use action='stop' for stop/cancel/kill requests and action='cleanup' with delete=true only after collecting results.",
			],
		},
		spawnAction: {
			name: "async_subagents_spawn",
			label: "Subagent Spawn Action",
			description: "Internal action implementation for subagents action='spawn'.",
		},
		statusAction: {
			name: "async_subagents_status",
			label: "Subagent Status Action",
			description: "Non-blocking status check for async sub-agents in a run directory. Shows running/done/failed/planned for each agent.",
		},
		waitAction: {
			name: "async_subagents_wait",
			label: "Subagent Wait Action",
			description: [
				"Wait for async sub-agents only when completion is required before the parent can proceed.",
				"Returns final status of each agent. Use action='result' to read completed output.",
			].join(" "),
		},
		resultAction: {
			name: "async_subagents_result",
			label: "Subagent Result Action",
			description: [
				"Read output from one async sub-agent after it completes.",
				"Returns compact structured summary/findings/files/risks/next actions plus artifact paths, not raw result text or stderr.",
				"Writes structured result.json alongside raw result.md; full result.md and stderr.log paths are included for manual inspection.",
			].join(" "),
		},
		stopAction: {
			name: "async_subagents_stop",
			label: "Subagent Stop Action",
			description: "Stop running async sub-agents in a run directory when the user asks to cancel/stop/kill them. Sends SIGTERM by default or SIGKILL with force=true.",
		},
		cleanupAction: {
			name: "async_subagents_cleanup",
			label: "Subagent Cleanup Action",
			description: "Clean up old completed async sub-agent run directories after results are collected. Dry-run by default; pass delete=true to remove.",
		},
	} satisfies Record<string, ToolDescription>;
}

export const ASYNC_SUBAGENT_TOOL_DESCRIPTIONS = asyncSubagentToolDescriptions(false);
export const ASYNC_SUBAGENT_TOOL_DESCRIPTIONS_WITH_REPO = asyncSubagentToolDescriptions(true);

export const REPO_DISCOVERY_TOOLS: RepoDiscoveryToolDescription[] = [
	{
		name: "repo_context", label: "Repo Context", command: "context",
		description: "First choice for general task discovery or authoritative contracts: compact documents plus implementation and tests. For a high-level module map or architecture/onboarding overview, start with repo_inspect mode=architecture instead. For focused code-path lookup or diagnosis, start with project_search.",
		promptSnippet: "Use repo_context for a general starting point or primary contract plus implementation/tests. A reading guide to understand a behavior is context discovery, not a cross-module architecture map. Start explicit cross-module architecture maps with repo_inspect mode=architecture. Use project_search first for a focused code-path lookup or diagnosis, even when the owner is unknown. Before creating a spec or making a material behavior change, use repo_context to find any existing primary contract and read returned sources directly.",
		promptGuidelines: [
			"For any repo_* tool, pass projectPath when the task targets another project; omit it for the current project. Use the same selected root for related calls and keep targets, scopes and audit paths relative to it. projectPath accepts absolute, session-cwd-relative or ~/ paths, requires .indexer-cli directly in that root, and does not change cwd; do not run setup implicitly. Resolve returned file paths against that root when using read. The parent model owns reasoning and synthesis from retrieved evidence; repo_context is retrieval, not a second answer-generating model.",
			"Documents remain searchable even without frontmatter. Retrieval rankings are navigation, not authoritative contracts; an empty result does not prove no contract exists.",
			"Before significant changes, read linked decision records as well as the current spec; search docs/decisions when needed. Check status and superseding links: historical rationale is not the current contract. Default to no new decision record. Record only when explicitly requested by the user, or when a choice involves materially different plausible alternatives, consequential accepted risk or costly reversal AND its durable rationale helps avoid repeating a dispute or mistake not already captured by an existing record. Ask whether the rationale will still be useful in six months. Features, UX changes, bug fixes, implementation details, dependency/model changes and changed specs alone are not triggers; keep ordinary behavior in specs. Do not invent alternatives; link existing applicable records. Do not prune or rewrite historical records merely to apply this prospective threshold.",
		],
	},
	{
		name: "repo_audit", label: "Repo Audit", command: "audit",
		description: "Task-scoped documentation relationship signals for changed paths; read-only, not proof of semantic correctness.",
		promptSnippet: "After implementation, use knowledge-auditor for the final task-scoped audit when available; otherwise run repo_audit with only this task's changed paths. Obtain the result and resolve task-related semantic drift, escalations and missing review coverage, or report blockers. Close the audit todo when task-scoped review is complete; global knowledge dirty=yes alone must not keep it open.",
		promptGuidelines: [
			"Keep or create the primary spec for material behavior changes; mechanical edits still need review-state checks. Audit may use a stale index: read sources and verify semantics. After all final edits, the auditor (or parent fallback) runs idx knowledge dirty, acknowledges only explicit active specs reviewed against current content and every declared Implementation/Tests dependency via idx knowledge acknowledge <spec-paths...>, then rechecks dirty. Audit/index/tests alone are not acknowledgment. Report task audit passed/blocked separately from global dirty yes/no/unknown and check errors; unclassified global dirtiness alone is not a task blocker or proof of unrelated changes. Uncovered task-related specs or concurrent changes to reviewed specs/dependencies still require resolution; never bulk-acknowledge unrelated specs to force no.",
			"For a new spec, use the non-overwriting template installed by idx init at .indexer-cli/spec-template.md. Declare kind: spec and the intended status in frontmatter; list project-root-relative paths under Implementation and Tests. If the template is absent, ask before running setup instead of inventing one.",
			"Record qualifying choices in docs/decisions via project template while context is available: status, context, evidence vs assumptions, decision/scope, alternatives, consequences and revisit triggers; link the spec both ways. Parent handoff: paths and rationale (or no-record reason); missing rationale is an escalation only for qualifying choices; never invent motives from code. Supersede old decisions explicitly instead of erasing history.",
		],
	},
	{
		name: "repo_inspect",
		label: "Repo Inspect",
		command: "inspect",
		description: "Compact indexed architecture, structure, AST, symbol and dependency views. Select a mode; read exact returned source ranges when needed.",
		promptSnippet: "For a high-level map or cross-module onboarding overview, start with mode architecture (not structure). Being new to a repository alone is not an architecture request: a behavior reading guide starts with repo_context. Use structure for a scoped file/symbol listing (limit 20, depth 2), ast (depth 3, limit 40), explain (signature by default), or deps (depth 1, direction callers/callees).",
		promptGuidelines: [
			"Optional scope is a project-relative path prefix for architecture, structure and explain. Structure supports kind, includeInternal and tests=include|exclude|summary; structure/AST support depth and cursor. AST always returns an outline without source text.",
			"Explain a known symbol with target=file::symbol; set includeBody only for implementation details (body limit defaults to 20). Use project_search when the symbol is unknown.",
			"Dependencies default to one level and callers; select modules, module-imports, calls or call-graph and a direction for the question. `tests: include` and showEdges are optional; add edges/tests or depth only for a named gap.",
		],
		targetDescription: "Required for ast/explain/deps; a file path or file-scoped symbol, e.g. src/api/client.ts::createClient.",
	},
];

export const REPO_DISCOVERY_TOOL_NAMES = REPO_DISCOVERY_TOOLS.map((tool) => tool.name);

export const TODO_TOOL_DESCRIPTION: ToolDescription = {
	name: "todo",
	label: "Todo",
	description: "Track and synchronize non-trivial multi-step work. Actions: create, update, batch_create, batch_update, list, get, delete, clear, export, import. Supports hierarchy, blockers, deferred/out-of-scope items, dependencies, and replace:true for replacing obsolete plans. Keep task text concise: short labels, optional brief descriptions, no progress journals. Skip trivial or chat-only requests; resync when requirements or discovered facts change. For multi-step plans, include a final user-facing report todo and keep exactly one task in_progress until verified.",
	promptSnippet: "Track/sync non-trivial multi-step work; include final report item and close it before sending the report; resync when requirements change; keep one task in_progress",
	promptGuidelines: [
		"Use `todo` for complex work with 3+ steps, explicit user task lists, or new non-trivial requirements. Skip single trivial tasks and purely conversational requests.",
		"For create/update and batch items, keep subject and activeForm to short action phrases. Omit description when the subject suffices; otherwise use 1–2 short sentences for essential scope, acceptance criteria, or the current blocker/next action. Replace stale details rather than appending progress history. Change description only when scope, criteria, blocker or next action changes, or the user explicitly requests a brief checkpoint. For blocked work, retain acceptance criteria and replace obsolete details with the current blocker and next action. Do not store reports, test logs, path inventories, or context-recovery narratives in todos; put test results and detailed evidence in the final response or a linked artifact. Include a specific path or identifier only when needed to act on the task. On completion, update status without expanding the description; normally send only action, id and status (or id and status per batch item).",
		"For multi-step implementation/debugging plans, include a final user-facing report todo in the initial plan with acceptance criteria for changed files/behavior, verification results, and remaining manual actions; close it immediately before the final response, never via compression. If the requested plan already includes that report stage, put the criteria there rather than creating a duplicate task.",
		"When create or batch_create already sets the intended status, do not issue a redundant update with the same status; continue the work instead. If the user asks to stop after creation, stop without cosmetic text updates or applying background results.",
		"Resync before continuing when user/new findings change scope, requirements, safety, feasibility, approach, dependencies, or order. Before creating tasks, review pending/deferred todos; when work resumes, reactivate and reuse an equivalent deferred todo instead of duplicating it.",
		"Update todos when starting, finishing, blocking, splitting, abandoning, or materially changing a step; before planned work mark exactly one in_progress with activeForm and complete it only after verification.",
		"Keep partial/failed/blocked work in_progress while actively resolving it. Before switching to independent work, return the blocked task to pending with a recorded blocker and mark only the new current task in_progress; do not mark blocked work completed. Use deferred for genuinely out-of-scope work or waiting on user input. Never use `clear`, `delete`, or batch deletion to hide unfinished/stale/forgotten todos; delete only on explicit request or creation mistake.",
		"Before a final response, list and reconcile all visible todos, including deferred ones: complete any whose outcome was achieved elsewhere, and leave deferred only genuinely unfinished or intentionally out of scope, mentioning each in the response. Do not finish with stale/duplicate deferred todos or a just-finished item in_progress.",
		"Keep subjects short; use parentId/blockers for hierarchy/dependencies. For large explicit plans use batch_create/batch_update but keep exactly one visible in_progress unless asked otherwise; use batch_create replace:true only for superseding plans.",
		"list hides tombstones unless includeDeleted:true; use status/blockedOnly only when needed; export/import for handoff, import replace:true only when explicitly overwriting; when all visible todos complete, state clears automatically.",
		"Persistence: `/todos persist on|off|status` or `/todos-persist on|off|status`; on resume, ask in-scope ids and run `/todos scope <id...>` or `/todos-scope <id...>` so out-of-scope active tasks are deferred.",
	],
};

export const SESSION_TOOL_DESCRIPTION: ToolDescription = {
	name: "session",
	label: "Session",
	description: "Name or inspect the current session. Actions: name (get/set title), overview (map raw history), read (section/entry), search (literal substring), recovery (deterministic task signals). Start lost-context recovery with overview when no reliable search phrase is known. All history actions default to the active branch; scope all includes abandoned branches. Pass only arguments for the selected action.",
	promptSnippet: "Use session action=name for explicit renames; action=overview first for unknown lost context, then read/search; recovery is a post-overview convenience.",
	promptGuidelines: [
		"Use session action=name only for explicit renames, opaque first prompts once understood, or when the current name no longer fits; ordinary first prompts are auto-named. Pass a short user-meaningful name; omit name to read the title.",
		"Use session action=overview first when task context was lost or compressed and no reliable search phrase is known; then inspect relevant section IDs with action=read.",
		"For session action=read, pass section_id or entry_id with the same active/all scope; use nextCursor as cursor to continue long sections or entries instead of restarting.",
		"Use session action=search when a concrete phrase, path, symbol, tool, or error is known. Search raw session history lexically, not semantically; use nextCursor as cursor to continue matches.",
		"Use session action=recovery only after overview has mapped the raw history. Treat recentErrors as historical evidence, not unresolved errors; verify ambiguous state with read or search.",
	],
};

export const WEB_SEARCH_TOOL_DESCRIPTIONS = {
	webSearch: {
		name: "web_search",
		label: "web-search",
		description:
			"Search the web for real-time information through Ollama, with automatic configured Tavily fallback. Credentials come from /web-credentials or environment variables. Supports per-call timeout_ms and PI_WEB_SEARCH_TIMEOUT_MS.",
		promptSnippet: "Search the web for current or real-time information through Ollama, with Tavily fallback when configured.",
		promptGuidelines: [
			"Use web_search only for current public web information; keep queries focused and set max_results only when useful.",
			"Never include secrets, tokens, or private repository data; do not use web_search for repo-local discovery—use repo_* or file/search tools.",
		],
	},
	webFetch: {
		name: "web_fetch",
		label: "web-fetch",
		description:
			"Fetch and extract text content from a web page URL through Ollama, with automatic configured Tavily Extract fallback. Credentials come from /web-credentials or environment variables. Supports per-call timeout_ms and PI_WEB_SEARCH_TIMEOUT_MS.",
		promptSnippet: "Fetch and extract text from a specific URL through Ollama, with Tavily Extract fallback when configured.",
		promptGuidelines: [
			"Use web_fetch for user-provided URLs or web_search results needing deeper reading; never pass secret/private-credential URLs, and use read for local files.",
		],
	},
} satisfies Record<string, ToolDescription>;

const SHELL_TEST_OUTPUT_GUIDANCE = `Tests: save full stdout/stderr to a unique log under the current project's ${PROJECT_ARTIFACTS_DIR}/ (never root artifacts/ or .artifacts/); emit only TEST_RESULT (passed/failed/incomplete), command, original exit code, verified counts (or unknown), and log path. Omit per-test PASS lines; show bounded exact failure diagnostics and flag omissions. Read only needed log ranges, never dump it. Preserve test exit status; timeout/abort is incomplete. Prefer supported compact reporters; do not alter tests/config just to shorten output.`;

export function claudeAliasToolDescriptions(options: ToolDescriptionSetOptions | boolean = false) {
	const repoDiscovery = hasRepoDiscovery(options);

	return {
		Read: {
			name: "Read",
			label: "Read",
			description: repoDiscovery
				? "Read file contents when the exact path is known. Use Glob/Grep or project_search/repo_inspect (mode structure) first when you still need to locate the file."
				: "Read file contents when the exact path is known. Use Glob/Grep first when you still need to locate the file.",
		},
		Edit: {
			name: "Edit",
			label: "Edit",
			description: repoDiscovery
				? "Replace exact text in an existing file. Use for surgical edits; use Write only for whole-file replacement. Keep the primary spec aligned for behavior changes; follow repo_audit finalization guidance."
				: "Replace exact text in an existing file. Use for surgical edits; use Write only for intentional whole-file replacement.",
		},
		Write: {
			name: "Write",
			label: "Write",
			description: repoDiscovery
				? "Create or overwrite a file with complete contents. Use only for intentional whole-file writes. Keep the primary spec aligned for behavior changes; follow repo_audit finalization guidance."
				: "Create or overwrite a file with complete contents. Use only when replacing the whole file is intended.",
		},
		Bash: {
			name: "Bash",
			label: "Bash",
			description: `Run shell commands for builds, tests, package managers, git, and project CLIs. Prefer Read/Edit/Write/Grep/Glob for file operations. ${SHELL_TEST_OUTPUT_GUIDANCE}`,
		},
		Grep: {
			name: "Grep",
			label: "Grep",
			description: repoDiscovery
				? "Search file contents with ripgrep when you know the exact text or regex pattern. Narrow with path/glob/context/limit; use project_search for semantic exploration and ast_grep for AST structure."
				: "Search file contents with ripgrep when you know the exact text or regex pattern. Narrow with path/glob/context/limit; use ast_grep for AST structure.",
		},
		Glob: {
			name: "Glob",
			label: "Glob",
			description: repoDiscovery
				? "Find files by path/name glob pattern, such as **/*.ts. Use before Read when only filenames are needed; use Grep for content search and project_search for semantic exploration."
				: "Find files by path/name glob pattern, such as **/*.ts. Use before Read when only filenames are needed; use Grep for content search.",
		},
	} satisfies Record<string, ToolDescription>;
}

export const CLAUDE_ALIAS_TOOL_DESCRIPTIONS = claudeAliasToolDescriptions(false);
export const CLAUDE_ALIAS_TOOL_DESCRIPTIONS_WITH_REPO = claudeAliasToolDescriptions(true);

export function codexAliasToolDescriptions(options: ToolDescriptionSetOptions | boolean = false) {
	const repoDiscovery = hasRepoDiscovery(options);
	return {
	shellCommand: {
		name: "shell",
		label: "shell",
		description: `Run shell commands for builds, tests, package managers, git, and project CLIs. Set workdir/cwd instead of cd; prefer read for simple file reads. ${SHELL_TEST_OUTPUT_GUIDANCE}`,
	},
	applyPatch: {
		name: "apply_patch",
		label: "apply_patch",
		description: `Apply file edits with a relative-path patch or standard unified diff. Use for creating, updating, moving, or deleting files; keep each patch focused.${repoDiscovery ? " Keep the primary spec aligned for behavior changes; follow repo_audit finalization guidance." : ""}

Begin-patch format:
*** Begin Patch
*** Update File: path/to/file
@@ optional context
-old text
+new text
*** End Patch

Sections: *** Add File (new lines start with +), *** Update File (optionally *** Move to: new/path), and *** Delete File. One Begin Patch may edit multiple tightly related files; keep unrelated changes separate. Update hunks may use optional @@ context, omit line numbers/the first @@, use *** End of File, and be wrapped in <<EOF ... EOF. Matching tolerates trailing-space, trim, and common Unicode punctuation differences.

Unified diff with ---/+++ headers is also supported. Paths must be workspace-relative, never absolute. Provide the complete patch in input.`,
	},
	} satisfies Record<string, ToolDescription>;
}

export const CODEX_ALIAS_TOOL_DESCRIPTIONS = codexAliasToolDescriptions(false);
export const CODEX_ALIAS_TOOL_DESCRIPTIONS_WITH_REPO = codexAliasToolDescriptions(true);
