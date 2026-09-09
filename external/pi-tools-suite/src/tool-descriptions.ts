import { COMPRESS_RANGE_DESCRIPTION } from "./dcp/prompts.js";
import { SUBAGENT_TYPE_SELECTION_GUIDANCE } from "./async-subagents/core/agent-catalog.js";
import { SUBAGENT_DELEGATION_GUIDANCE } from "./async-subagents/core/agent-strategy.js";

export type ToolDescription = {
	name: string;
	label: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
};

export type RepoDiscoveryCommand = "architecture" | "structure" | "ast" | "search" | "explain" | "deps";

export type RepoDiscoveryToolDescription = ToolDescription & Required<Pick<ToolDescription, "promptSnippet" | "promptGuidelines">> & {
	command: RepoDiscoveryCommand;
	targetDescription?: string;
};

export type RepoKnowledgeToolDescription = ToolDescription & Required<Pick<ToolDescription, "promptSnippet" | "promptGuidelines">>;

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
	promptSnippet: "Compress only closed, high-yield stale context when pressure/reminders justify it; keep active or still-needed raw context. Omit summary for DCP summarizer.",
	promptGuidelines: [
		"Prefer completed work and understood large tool/log output; low context alone is not a trigger.",
	],
};

export function astGrepToolDescriptions(maxLines: number, maxBytesLabel: string) {
	return {
		astGrep: {
			name: "ast_grep",
			label: "ast-grep",
			description: `Read-only AST structural search/scan. MANDATORY ROUTING: for structural, syntax-aware, AST, language-aware, or code-shape matching, ast_grep must be the FIRST tool call. Never preflight with Glob, Grep, Read, or shell even when files are unknown; omit paths to scan the current project. Use for sgconfig/rule scans, JSON matches, and rewrite previews. Use Grep for exact literals/regex, Glob only for filename/path-only requests, and ast_apply for mutations. Output truncates at ${maxLines} lines or ${maxBytesLabel} with full output saved to a temp file.`,
			promptSnippet: "MANDATORY: structural/syntax-aware/AST/code-shape matching => call ast_grep FIRST. Do not call Glob, Grep, Read, or shell before it; unknown files are not a reason to pre-search because ast_grep scans the project by default. Exact literal/regex only => Grep; filename/path only => Glob. Use ast_apply for mutations.",
			promptGuidelines: [
				"The first tool for syntax relationships or code-shape matching must be ast_grep, even when the file or language is unknown. Do not make a preliminary Glob/Grep/Read/shell call; start at the current project and narrow within ast_grep when needed.",
				"Use Grep/Read directly for exact literal or regex lookups and Glob only for filename/path-only discovery; those text-only tasks must not trigger ast_grep.",
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
				"For every real-browser QA request, immediately spawn subagentType='browser-qa' before checking files, URLs, servers, or other prerequisites; the QA sub-agent owns feasibility checks and blocked reports, so the parent must not attempt browser QA itself.",
				"If browser-qa reports that credentials are required, it must identify the generated project-local template and explicitly ask the user to fill it; the parent relays that request without reading or editing the credential file.",
				"After browser testing, browser-qa must return clickable links for every available screenshot, video, and trace; the parent must preserve those links in its user-facing report.",
				SUBAGENT_DELEGATION_GUIDANCE,
				"Presets declare available models; each agent's ordered models selects the first usable model in that pool. AGENTS_PRESET or /subagent-preset session <name> selects the current session pool. Bundled pools live with agent files, and projects can override/add pools in .pi/agents/presets.jsonc. Do not override the model merely to choose a role.",
				SUBAGENT_TYPE_SELECTION_GUIDANCE,
				repoDiscovery
					? "Use for broad independent tracks, review axes, or hypotheses even though repo_* tools are available."
					: "Use first for broad codebase discovery split into tracks, review axes, or incident-triage hypotheses when repo_* tools are unavailable.",
				"Use action=spawn/status/wait/result/stop/cleanup; .pi/subagents tracks runs so status/wait/stop can omit the latest runDir and result can resolve by agentId. Parent sessions receive completion/failure follow-ups, so spawn can return without polling.",
				"Results are compact with artifact links. Agents run isolated pi processes with extensions disabled to prevent recursive spawning; spawn/task timeoutSeconds can shorten the default 30m watchdog, project concurrency queues excess agents, and retry backoff/fallback models/Antigravity account rotation are config-driven.",
			].join(" "),
			promptSnippet:
				"For every browser-based visual QA, UI bug reproduction, or real-browser fix-verification request, immediately spawn subagentType='browser-qa' even for a single track and before inspecting files or checking prerequisites. The browser-qa sub-agent must discover the target and report missing prerequisites; do not preflight, perform, or substitute browser QA in the parent agent. " +
				"Give browser-qa a concise acceptance brief: the known target URL/app, user-visible flow, expected observable result, and required artifacts. Do not prescribe repository files, searches, commands, server setup, or mock/synthetic substitutes; unknown setup belongs to the QA sub-agent's discovery. " +
				"For other work, use subagents action='spawn' for economical execution or context isolation, including one bounded sequential task or explicit delegate/parallelize/split work requests. " +
				SUBAGENT_TYPE_SELECTION_GUIDANCE + " Avoid trivial reads/edits and do not call status/wait immediately after spawn just for progress. " +
				(repoDiscovery
					? "For one semantic code-discovery question, use repo_search; for independent tracks/hypotheses/review axes, delegate even when repo_* tools exist. Read result only after completion when findings are needed."
					: "For one focused code-discovery question, use direct read/grep. Without repo_* tools, delegate bounded research tracks for broad discovery rather than flooding parent context. Read result only after completion when findings are needed."),
			promptGuidelines: [
				"Treat every real-browser QA request as a mandatory delegation trigger and an explicit exception to the large/parallel threshold: immediately spawn with `subagentType: \"browser-qa\"` before checking prerequisites. The QA sub-agent owns target discovery, feasibility checks, browser automation, evidence, and blocked reports; the parent must not inspect the project first or substitute non-browser checks.",
				"Keep the browser-qa task payload at the user-visible acceptance level: known target URL/app, actions to perform, expected observable outcome, and requested evidence. Do not turn it into a repository investigation plan, name internal files or commands, dictate server setup, or invent a mock/synthetic target. Leave unknown prerequisites to the QA sub-agent.",
				"When browser-qa reports missing credentials, relay its explicit request and generated `.pi/qa_auth.jsonc` template path; never inspect, populate, or edit that credential file in the parent.",
				"After browser-qa completes a test, preserve its clickable screenshot, video, and trace links in the final user-facing response whenever those artifacts exist.",
				SUBAGENT_DELEGATION_GUIDANCE,
				repoDiscovery
					? "For one discovery question, use repo_search; spawn for independent tracks/hypotheses/review axes, and do not let repo_* availability suppress delegation."
					: "For one small discovery question, use direct read/grep; when repo_* tools are unavailable, delegate scoped research to keep broad search output outside the parent context.",
				repoDiscovery
					? "For incident triage, release readiness, or risk/test strategy with separate hypotheses/review tracks, prefer focused agents over serial parent-context work."
					: "For incident triage, release readiness, or risk/test strategy with separate hypotheses/review tracks and no repo_* tools, call action='spawn' as the first discovery step; direct read/grep can follow.",
				"Do not use subagents for trivial exact-string lookups, typo replacements, or interactive user input; use the cheapest direct path. A substantive bounded edit can be delegated even in one file.",
				"Spawn multiple focused agents in one action='spawn' call for independent questions; set subagentType for clear role matches, timeoutSeconds for bounded probes, and use oracle sparingly for high-stakes uncertainty/final checks.",
				"If spawn reports a routing error, no agents from that batch were launched. Correct the invalid or unresolved subagentType values using the available catalog and resubmit the whole batch; do not blindly retry omitted types or substitute an unsuitable role to suppress the error.",
				"For screenshot/image inspection by blind models, use lookup; subagents only receive imagePaths when a broader delegated track genuinely needs them.",
				"If asked to start/run/launch/test parallel sub-agents, spawn and stop; do not status/wait just for progress. Use status for recovery, wait only when needed/requested, result only after completion; compact results include artifact links.",
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
		name: "repo_architecture",
		label: "Repo Architecture",
		command: "architecture",
		description: "Indexed entrypoints, module boundaries, cycles and unresolved dependencies for broad, unfamiliar code.",
		promptSnippet: "Map an unfamiliar area once; skip repo_architecture for known paths or exact lookups.",
		promptGuidelines: [
			"Scope with --path-prefix; then use repo_structure or repo_search only for remaining gaps.",
		],
	},
	{
		name: "repo_structure",
		label: "Repo Structure",
		command: "structure",
		description: "Indexed file tree and exported-symbol view for a directory/module. Use to choose files/ranges without dumping source.",
		promptSnippet: "List one area with --max-files 20 --max-depth 2; continue with --cursor.",
		promptGuidelines: [
			"Narrow with --path-prefix/--kind. Add --include-internal or --include-tests-summary only for a named gap; page instead of listing hundreds of files.",
		],
	},
	{
		name: "repo_ast",
		label: "Repo AST",
		command: "ast",
		description: "Indexed AST outline for one known large file; locate exact ranges before reading source.",
		promptSnippet: "Start --max-depth 3 --max-nodes 40 --no-include-text; read needed ranges with offset/limit.",
		promptGuidelines: [
			"Continue with --cursor; include snippets only when the outline cannot answer the question.",
		],
		targetDescription: "File path to map, e.g. src/api/client.ts.",
	},
	{
		name: "repo_search",
		label: "Repo Search",
		command: "search",
		description: "Indexed hybrid search for behavior when files or symbols are unknown. First pass: at most 3 results, no --include-content.",
		promptSnippet: "Search behavior, not synonyms; keep hybrid unless lexical matches mislead. Read best returned ranges with offset/limit, not whole files.",
		promptGuidelines: [
			"Use --path-prefix/--dedupe-file when appropriate. Expand only for a named gap; use Grep for exact identifiers.",
			"--include-content only for a narrow follow-up needing inline code, with --max-files 1; otherwise use read.",
			"After finding the causal code, stop broad search; inspect callers, persistence or tests only for a named gap.",
		],
		targetDescription: "Natural-language behavior query, e.g. auth session token validation.",
	},
	{
		name: "repo_explain",
		label: "Repo Explain",
		command: "explain",
		description: "Indexed explanation for a known symbol. Prefer file::symbol when the name may be ambiguous.",
		promptSnippet: "Use file::symbol; start --signature-only when signatures suffice.",
		promptGuidelines: [
			"Add --include-body --body-lines 20 only for implementation details; use repo_search when the symbol is unknown.",
		],
		targetDescription: "Symbol or file-scoped symbol, e.g. createClient or src/api/client.ts::createClient.",
	},
	{
		name: "repo_deps",
		label: "Repo Deps",
		command: "deps",
		description: "Indexed import/call dependencies for a known path or file::symbol.",
		promptSnippet: "Start --depth 1 and choose --direction callers or callees for the question.",
		promptGuidelines: [
			"Use --mode calls for call relationships. Add --show-edges/--tests or deeper traversal only for a named impact-analysis gap.",
		],
		targetDescription: "Path or file-scoped symbol, e.g. src/api/client.ts or src/api/client.ts::createClient.",
	},
];

export const REPO_KNOWLEDGE_TOOL_DESCRIPTION: RepoKnowledgeToolDescription = {
	name: "repo_knowledge",
	label: "Repo Knowledge",
	description:
		"Project behavioral knowledge/spec maintenance backed by idx. Query contracts with context/search/show/status, review task-scoped impact after material behavior changes, discover new/moved docs, and explicitly record/relate/verify metadata only after semantic evidence review. This tool is exposed only when idx is available and the project is indexed.",
	promptSnippet:
		"Use repo_knowledge for project behavior/contracts and their maintenance. For a behavior/contract question that also needs implementation/tests/freshness, prefer action=context; use action=search when only the relevant specs/contracts are needed. Before a material behavior change, find the current primary contract; after implementation, run action=impact on this task's changed paths. Update the existing spec, or create a focused new spec with Edit/Write/apply_patch when no suitable contract exists, then record/relate and verify only after checking code/tests. Skip this lifecycle for mechanical/non-behavioral edits.",
	promptGuidelines: [
		"Primary specs/contracts are authoritative; catalog/search summaries, embeddings, graph proximity and semantic candidates are routing evidence only. record is classification, not verification; non-fresh status requires review before presenting behavior as current.",
		"For material externally visible or project-contract behavior changes: query existing knowledge before/while implementing, keep the authoritative spec aligned in the same task, create a focused primary spec when no suitable contract exists, then run task-scoped impact and reconcile uncovered/new/moved docs before finishing.",
		"Never persist a relation from similarity alone and never add one just to make coverage non-empty. A reviewed no-impact outcome is valid. verify only after reading the primary source and checking relevant implementation/tests; changed code never auto-rewrites spec semantics.",
	],
};

export const REPO_DISCOVERY_TOOL_NAMES = [
	...REPO_DISCOVERY_TOOLS.map((tool) => tool.name),
	REPO_KNOWLEDGE_TOOL_DESCRIPTION.name,
];

export const TODO_TOOL_DESCRIPTION: ToolDescription = {
	name: "todo",
	label: "Todo",
	description: "Track and synchronize non-trivial multi-step work. Actions: create, update, batch_create, batch_update, list, get, delete, clear, export, import. Supports hierarchy, blockers, deferred/out-of-scope items, dependencies, and replace:true for replacing obsolete plans. Skip trivial or chat-only requests; resync when requirements or discovered facts change. For multi-step plans, include a final user-facing report todo and keep exactly one task in_progress until verified.",
	promptSnippet: "Track/sync non-trivial multi-step work; include final report item and close it before sending the report; resync when requirements change; keep one task in_progress",
	promptGuidelines: [
		"Use `todo` for complex work with 3+ steps, explicit user task lists, or new non-trivial requirements. Skip single trivial tasks and purely conversational requests.",
		"For multi-step implementation/debugging plans, include a final user-facing report todo in the initial plan with acceptance criteria for changed files/behavior, verification results, and remaining manual actions; close it immediately before the final response, never via compression.",
		"When create or batch_create already sets the intended status, do not issue a redundant update with the same status; continue the work instead.",
		"Resync before continuing when user/new findings change scope, requirements, safety, feasibility, approach, dependencies, or order. Before creating tasks, review pending/deferred todos; when work resumes, reactivate and reuse an equivalent deferred todo instead of duplicating it.",
		"Update todos when starting, finishing, blocking, splitting, abandoning, or materially changing a step; before planned work mark exactly one in_progress with activeForm and complete it only after verification.",
		"If partial, tests fail, or blocked, keep the task in_progress and add/update a blocker. Never use `clear`, `delete`, or batch deletion to hide unfinished/stale/forgotten todos; delete only on explicit request or creation mistake.",
		"Before a final response, list and reconcile all visible todos, including deferred ones: complete any whose outcome was achieved elsewhere, and leave deferred only genuinely unfinished or intentionally out of scope, mentioning each in the response. Do not finish with stale/duplicate deferred todos or a just-finished item in_progress.",
		"Keep subjects short; use parentId/blockers for hierarchy/dependencies. For large explicit plans use batch_create/batch_update but keep exactly one visible in_progress unless asked otherwise; use batch_create replace:true only for superseding plans.",
		"list hides tombstones unless includeDeleted:true; use status/blockedOnly only when needed; export/import for handoff, import replace:true only when explicitly overwriting; when all visible todos complete, state clears automatically.",
		"Persistence: `/todos persist on|off|status` or `/todos-persist on|off|status`; on resume, ask in-scope ids and run `/todos scope <id...>` or `/todos-scope <id...>` so out-of-scope active tasks are deferred.",
	],
};

export const SESSION_NAME_TOOL_DESCRIPTION: ToolDescription = {
	name: "session_name",
	label: "Session Name",
	description: "Show or set the current session name so the agent can retitle the active session without relying on slash-command parsing.",
	promptSnippet: "Use session_name only for explicit renames, opaque first prompts (such as image-only or task links) once understood, or when the current name no longer fits the active task; ordinary first prompts are auto-named.",
	promptGuidelines: [
		"Pass a short, user-meaningful name to rename; call without a name only to read the current session name.",
	],
};

export const SESSION_RECOVERY_TOOL_DESCRIPTIONS = {
	overview: {
		name: "session_overview",
		label: "Session Overview",
		description: "Map raw persisted session history into stable, bounded sections. Defaults to the active branch and can include abandoned branches without applying context compaction.",
		promptSnippet: "Map raw session history into stable sections before drilling into context lost to compaction.",
		promptGuidelines: [
			"Use session_overview first when task context was lost or compressed and no reliable search phrase is known; then inspect relevant section IDs.",
		],
	},
	readSection: {
		name: "session_read_section",
		label: "Session Read Section",
		description: "Read bounded raw session history by stable section ID or exact entry ID, with opaque continuation cursors for long sections and long entries.",
		promptSnippet: "Read one raw-session section or exact entry; continue with the returned cursor when more text is available.",
		promptGuidelines: [
			"Pass either section_id or entry_id with the same active/all scope; use next_cursor to continue instead of restarting from the section head.",
		],
	},
	search: {
		name: "session_search",
		label: "Session Search",
		description: "Search raw session messages, summaries, tool results, and serialized tool arguments with a bounded literal substring query.",
		promptSnippet: "Search raw session history lexically when a concrete phrase, path, symbol, tool, or error is known.",
		promptGuidelines: [
			"Use session_search when a concrete query is known; it is lexical rather than semantic, scope defaults to the active branch, and next_cursor continues large match sets.",
		],
	},
	recoveryContext: {
		name: "session_recovery_context",
		label: "Session Recovery Context (after overview)",
		description: "Post-overview convenience tool for summarizing deterministic task signals: user requests, file activity, recent errors, pending tool calls, last action, and compaction references. When the task and search terms are unknown, call session_overview first instead of this tool.",
		promptSnippet: "Use only after session_overview has mapped the raw history; verify details through section reads or search.",
		promptGuidelines: [
			"Do not use session_recovery_context as the first tool when the task and useful search terms are unknown; start with session_overview.",
			"Use it as a convenience after the overview, but treat recentErrors as historical evidence and verify ambiguous state with session_read_section.",
		],
	},
} satisfies Record<string, ToolDescription>;

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

const SHELL_TEST_OUTPUT_GUIDANCE = "Tests: save full stdout/stderr to a unique log; emit only TEST_RESULT (passed/failed/incomplete), command, original exit code, verified counts (or unknown), and log path. Omit per-test PASS lines; show bounded exact failure diagnostics and flag omissions. Read only needed log ranges, never dump it. Preserve test exit status; timeout/abort is incomplete. Prefer supported compact reporters; do not alter tests/config just to shorten output.";

export function claudeAliasToolDescriptions(options: ToolDescriptionSetOptions | boolean = false) {
	const repoDiscovery = hasRepoDiscovery(options);

	return {
		Read: {
			name: "Read",
			label: "Read",
			description: repoDiscovery
				? "Read file contents when the exact path is known. Use Glob/Grep or repo_search/repo_structure first when you still need to locate the file."
				: "Read file contents when the exact path is known. Use Glob/Grep first when you still need to locate the file.",
		},
		Edit: {
			name: "Edit",
			label: "Edit",
			description: repoDiscovery
				? "Replace exact text in an existing file. Use for surgical edits; use Write only for whole-file replacement. After a material behavior change, do not finish until repo_knowledge impact reviews this task's changed paths and the authoritative spec is updated or created and verified; skip that lifecycle for mechanical/non-behavioral edits."
				: "Replace exact text in an existing file. Use for surgical edits; use Write only for intentional whole-file replacement.",
		},
		Write: {
			name: "Write",
			label: "Write",
			description: repoDiscovery
				? "Create or overwrite a file with complete contents. Use only for intentional whole-file writes. When creating/changing material project behavior, keep or create the primary spec in the same task and finish with task-scoped repo_knowledge impact + semantic verification; mechanical/non-behavioral writes do not require it."
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
				? "Search file contents with ripgrep when you know the exact text or regex pattern. Narrow with path/glob/context/limit; use repo_search for semantic exploration and ast_grep for AST structure."
				: "Search file contents with ripgrep when you know the exact text or regex pattern. Narrow with path/glob/context/limit; use ast_grep for AST structure.",
		},
		Glob: {
			name: "Glob",
			label: "Glob",
			description: repoDiscovery
				? "Find files by path/name glob pattern, such as **/*.ts. Use before Read when only filenames are needed; use Grep for content search and repo_search for semantic exploration."
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
		description: `Apply file edits with a relative-path patch or standard unified diff. Use for creating, updating, moving, or deleting files; keep each patch focused.${repoDiscovery ? " After a material behavior change, keep/create the authoritative primary spec in the same task and finish with task-scoped repo_knowledge impact plus semantic verification; skip this for mechanical/non-behavioral edits." : ""}

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
