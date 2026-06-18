import { COMPRESS_RANGE_DESCRIPTION } from "./dcp/prompts.js";

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
	promptSnippet: "Use compress for context-pressure housekeeping: summarize closed, high-yield stale slices when context is meaningfully high or a DCP reminder gives concrete candidates; do not compress just because low-context work produced a small closed slice.",
	promptGuidelines: [
		"Treat completed implementation, verification, config/doc edits, answered exploration, dead ends, and log inspection as compression candidates when they are large, stale, or context pressure is meaningful.",
		"Do not carry large stale shell/read/repo/web outputs, diffs, or passing logs across task boundaries when their exact text is no longer useful; summarize their actionable result instead.",
		"Keep active, still-needed context raw; compress only closed ranges whose exact content is unlikely to be needed next.",
	],
};

export function astGrepToolDescriptions(maxLines: number, maxBytesLabel: string) {
	return {
		astGrep: {
			name: "ast_grep",
			label: "ast-grep",
			description: `Read-only AST structural search/scan. Use for language-aware patterns, sgconfig/rule scans, JSON matches, and rewrite previews. Use text search for plain strings and ast_apply for mutations. Output truncates at ${maxLines} lines or ${maxBytesLabel} with full output saved to a temp file.`,
			promptSnippet: "Use ast_grep for AST/structural code search, not plain text search. It previews rewrites only; use ast_apply to mutate files.",
			promptGuidelines: [
				"Use ast_grep when syntax/AST structure matters; use Grep/text search for exact strings or regex.",
				"Keep searches narrow with paths/globs and set lang explicitly for ambiguous snippets.",
				"ast_grep is read-only: use rewrite to preview replacements, never to apply them.",
				"Use ast_apply for intended ast-grep rewrites or scan fixes; use command=scan with rule, inlineRules, or config for rule-based scans.",
			],
		},
		astApply: {
			name: "ast_apply",
			label: "ast-apply",
			description: `Mutating AST rewrite/fix tool powered by ast-grep. Use for structural replacements or scan fixes after you know the pattern/rule is correct. Reports changedFiles for post-edit diagnostics and truncates output at ${maxLines} lines or ${maxBytesLabel}.`,
			promptSnippet: "Use ast_apply only when you intend to mutate files with ast-grep structural rewrites or scan fixes.",
			promptGuidelines: [
				"Use ast_apply for AST-aware bulk edits, not simple one-off text replacements.",
				"For pattern rewrites, use command=run with pattern, rewrite, and lang when ambiguous; for rule fixes, use command=scan with rule, inlineRules, or config.",
				"Run ast_grep first when the match set is uncertain; use ast_apply directly only for obvious, scoped rewrites.",
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
				"Manage isolated async sub-agents for large, parallel, context-heavy work.",
				"Presets from async-subagents config and /subagent-preset choose role model/thinking/args; AGENTS_PRESET or /subagent-preset session <name> overrides the current session; /subagent-preset init creates a sample config.",
				"Omit subagentType so the router chooses a configured role unless the user or task requires a role, vision, or deterministic override.",
				repoDiscovery
					? "Use for broad independent tracks, review axes, or hypotheses even though repo_* tools are available."
					: "Use first for broad codebase discovery split into tracks, review axes, or incident-triage hypotheses when repo_* tools are unavailable.",
				"Use action=spawn/status/wait/result/stop/cleanup; .pi/subagents tracks runs so status/wait/stop can omit the latest runDir and result can resolve by agentId. Parent sessions receive completion/failure follow-ups, so spawn can return without polling.",
				"Results are compact with artifact links. Agents run isolated pi processes with extensions disabled to prevent recursive spawning; spawn/task timeoutSeconds can shorten the default 30m watchdog, project concurrency queues excess agents, and retry backoff/fallback models/Antigravity account rotation are config-driven.",
			].join(" "),
			promptSnippet:
				"Use subagents action='spawn' for multiple independent agents, explicit delegate/parallelize/split work requests, or one large review/debug track that should stay out of the parent context. " +
				"Usually omit subagentType so the router chooses; set it only for user-named roles, vision/image handling, deterministic tests, or another concrete override. Avoid trivial reads/edits and do not call status/wait immediately after spawn just for progress. " +
				(repoDiscovery
					? "For one semantic code-discovery question, use repo_search; for independent tracks/hypotheses/review axes, delegate even when repo_* tools exist. Read result only after completion when findings are needed."
					: "For one focused code-discovery question, use direct read/grep. Without repo_* tools, spawn several focused scan/quick agents first for broad multi-track discovery, incident triage, release readiness, risk strategy, or parallel reviews. Read result only after completion when findings are needed."),
			promptGuidelines: [
				"Use action='spawn' only for LARGE or PARALLEL tasks: independent investigations, repo-wide sweeps, deep debugging, or code review/audit that would bloat the parent context.",
				"Treat explicit requests to delegate, use sub-agents, run parallel agents, split into independent tracks, investigate hypotheses, or run separate review axes as spawn triggers; spawn first unless the request is trivial or clearly single-file.",
				repoDiscovery
					? "For one discovery question, use repo_search; spawn only for several independent tracks/hypotheses/review axes, and do not let repo_* availability suppress delegation."
					: "For one discovery question, use direct read/grep; without repo_* tools, spawn a small focused swarm before parent-context search when the task spans several files/modules/hypotheses/tracks.",
				repoDiscovery
					? "For incident triage, release readiness, or risk/test strategy with separate hypotheses or review tracks, prefer focused review agents over serial parent-context work."
					: "For incident triage, release readiness, or risk/test strategy with separate hypotheses or review tracks and no repo_* tools, call action='spawn' as the first discovery step; direct read/grep can follow.",
				"Do not use subagents for exact-string lookups, known-file edits, typo/text replacements, obvious one-file changes, or interactive user input; use the cheapest direct path.",
				"Spawn multiple focused agents in one action='spawn' call for independent questions; for synthetic tests or bounded probes, pass timeoutSeconds slightly above expected runtime.",
				"For spawn, leave subagentType unset so the router chooses from configured roles. Set it only for user-named roles, vision/image handling, deterministic tests, or another concrete override.",
				"Use subagentType='vision' with imagePaths and optional focus when images/screenshots/diagrams need visual inspection.",
				"If the user asks to start, run, launch, or test parallel sub-agents, call action='spawn' and then stop; completion/failure notifications will wake the parent so do not immediately call action='status' or action='wait' just to see whether agents finished.",
				"Use status for non-blocking progress/recovery, wait only when requested or needed, and result only after completion; registry mappings can recover latest runDir/agentId after reload.",
				"Result output is compact with artifact links; inspect raw artifacts only when full details are necessary.",
				"Use action='stop' when the user asks to stop, cancel, or kill running sub-agents.",
				"Use action='cleanup' with delete=true after collecting all results to free disk space.",
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
		description: "Indexed repo architecture map: entrypoints, module boundaries, cycles, and unresolved dependency classes. Use before broad reads in unfamiliar codebases; skip for exact-string lookups, known-file edits, or other trivial changes.",
		promptSnippet: "Use repo_architecture for a compact indexed architecture overview before broad multi-file reads, not for simple literal searches or small known-scope edits.",
		promptGuidelines: [
			"For exact strings, filenames, known symbols, typo/text replacements, or obvious one-file edits, skip repo_architecture and use the cheapest direct path: text search/read, then edit.",
			"For broad exploration in an unfamiliar codebase, make one narrow architecture call first; add --path-prefix in args when a subsystem is known.",
			"Use repo_structure for file/symbol listings and repo_search for behavior questions after this overview.",
		],
	},
	{
		name: "repo_structure",
		label: "Repo Structure",
		command: "structure",
		description: "Indexed file tree and exported-symbol view for a directory/module. Use to choose files/ranges without dumping source.",
		promptSnippet: "Use repo_structure for file trees, module contents, and exported symbols; narrow with idx flags.",
		promptGuidelines: [
			"Pass --path-prefix, --kind, --max-files, or --max-depth in args whenever possible.",
			"Use repo_ast for one large file's syntax map and repo_search for semantic behavior discovery.",
		],
	},
	{
		name: "repo_ast",
		label: "Repo AST",
		command: "ast",
		description: "Indexed AST map for one file. Use before repeated reads of a large file or when parent syntax structure matters.",
		promptSnippet: "Use repo_ast with target=<file> to map one large file before choosing exact ranges to read.",
		promptGuidelines: [
			"Use this for one known file, not repo-wide search.",
			"Pass --max-depth or --max-nodes in args to keep the AST map compact.",
		],
		targetDescription: "File path to map, e.g. src/api/client.ts.",
	},
	{
		name: "repo_search",
		label: "Repo Search",
		command: "search",
		description: "Indexed hybrid/semantic repository search for behavior questions when exact identifiers or files are unknown. Use natural-language behavior queries, not synonym dumps. Defaults to hybrid ranking; read returned ranges next.",
		promptSnippet: "Use repo_search for conceptual codebase questions; query for behavior, not a bag of synonyms. Leave default hybrid ranking for first-pass searches and use Grep/read when exact names or positions are known.",
		promptGuidelines: [
			"Phrase target as the behavior to locate, not a whitespace-separated pile of near-synonyms; keep exact identifiers only as useful anchors.",
			"For initial unknown-file behavior searches, prefer the default hybrid ranking; pass --mode semantic only when lexical/symbol terms are misleading or the query is purely conceptual.",
			"Make one targeted search, read the best returned ranges (prefer read over --include-content for full evidence), then refine only for a named gap; do not launch duplicate broad searches.",
			"Use a specific conceptual target and narrow with --path-prefix, --max-files, --dedupe-file, or --exclude-tests when useful.",
			"For bug/cause questions, stop when a read range shows the causal assignment/write/branch/call; continue only for a named gap such as callers, persistence, tests, or requested impact, and narrow follow-ups.",
		],
		targetDescription: "Natural-language behavior query, e.g. auth session token validation.",
	},
	{
		name: "repo_explain",
		label: "Repo Explain",
		command: "explain",
		description: "Indexed explanation for a known symbol. Prefer file::symbol when the name may be ambiguous.",
		promptSnippet: "Use repo_explain for a known symbol after you already know its name or file scope.",
		promptGuidelines: [
			"Prefer target=file::symbol for ambiguous names.",
			"Use repo_search instead when you do not yet know the relevant symbol.",
		],
		targetDescription: "Symbol or file-scoped symbol, e.g. createClient or src/api/client.ts::createClient.",
	},
	{
		name: "repo_deps",
		label: "Repo Deps",
		command: "deps",
		description: "Indexed dependency/caller tracing for a known path or symbol. Use for import impact and first-hop call/dependency analysis.",
		promptSnippet: "Use repo_deps with target=<path|path::symbol> to trace imports, imported-by, callers, or callees.",
		promptGuidelines: [
			"Start with --depth 1 in args; add --direction callers|callees|both, --mode calls, or --show-edges only when needed.",
			"Use repo_search first when you do not yet know the target path or symbol.",
		],
		targetDescription: "Path or file-scoped symbol, e.g. src/api/client.ts or src/api/client.ts::createClient.",
	},
];

export const REPO_DISCOVERY_TOOL_NAMES = REPO_DISCOVERY_TOOLS.map((tool) => tool.name);

export const TODO_TOOL_DESCRIPTION: ToolDescription = {
	name: "todo",
	label: "Todo",
	description: "Track and synchronize non-trivial multi-step work. Actions: create, update, batch_create, batch_update, list, get, delete, clear, export, import. Supports hierarchy, blockers, deferred/out-of-scope items, dependencies, and replace:true for replacing obsolete plans. Skip trivial or chat-only requests; resync when requirements or discovered facts change. For multi-step plans, include a final user-facing report todo and keep exactly one task in_progress until verified.",
	promptSnippet: "Track/sync non-trivial multi-step work; include final report item and close it before sending the report; resync when requirements change; keep one task in_progress",
	promptGuidelines: [
		"Use `todo` for complex work with 3+ steps, explicit user task lists, or new non-trivial requirements. Skip single trivial tasks and purely conversational requests.",
		"For multi-step implementation/debugging plans, include a final user-facing report todo in the initial plan with acceptance criteria for changed files/behavior, verification results, and remaining manual actions; close it immediately before the final response, never via compression.",
		"Resync before continuing when the user or new findings change scope, requirements, safety, feasibility, approach, dependencies, or order; update relevant tasks, add required tasks/blockers, and defer obsolete work.",
		"Update todos when you start, finish, block, split, abandon, or materially change a step; do not leave todo maintenance for end-of-task cleanup.",
		"Before non-trivial planned work, mark exactly one task in_progress with activeForm. Complete it only after required verification, never in batches.",
		"If implementation is partial, tests fail, or a blocker remains, keep the task in_progress and add/update a blocker task instead of completing it.",
		"Never use `clear`, `delete`, or batch deletion to hide unfinished, stale, or forgotten todos. Defer obsolete items or update them with the reason; only delete when the user explicitly asks or the item was created by mistake.",
		"Before giving a final response for work that used todos, ensure every visible todo is completed, deferred, or intentionally still in_progress with a blocker/explanation. Do not leave any just-finished todo item in_progress after you stop.",
		"Keep subjects short and imperative; put details in description only when needed. Use parentId for large plans; use blockedBy on create and addBlockedBy/removeBlockedBy on update for dependencies.",
		"Use batch_create/batch_update for large explicit plans, but still keep exactly one visible task in_progress unless the user asks otherwise.",
		"When starting a new plan that supersedes existing unfinished todos, use batch_create with replace:true instead of appending; only omit replace when intentionally extending the current plan.",
		"list hides deleted tombstones unless includeDeleted:true; use status/blockedOnly filters only when needed. Use export/import for handoff or migration; import with replace:true only when explicitly overwriting todo state.",
		"When every visible todo is completed, todo state clears automatically; do not call clear afterward just to remove completed tasks.",
		"Persistence uses `/todos persist on|off|status` or `/todos-persist on|off|status`; when resuming, ask which ids are in scope and run `/todos scope <id...>` or `/todos-scope <id...>` so out-of-scope active tasks are deferred.",
	],
};

export const SESSION_NAME_TOOL_DESCRIPTION: ToolDescription = {
	name: "session_name",
	label: "Session Name",
	description: "Show or set the current session name so the agent can retitle the active session without relying on slash-command parsing.",
	promptSnippet: "Use session_name to rename the current session directly when the task calls for updating the session title.",
	promptGuidelines: [
		"Pass a short, user-meaningful name when renaming the current session.",
		"Call without a name only when you need to read the current session name.",
	],
};

export const WEB_SEARCH_TOOL_DESCRIPTIONS = {
	webSearch: {
		name: "web_search",
		label: "web-search",
		description:
			"Search the web for real-time information using your local Ollama instance's web_search API. Requires Ollama running locally with web search enabled; supports per-call timeout_ms and PI_WEB_SEARCH_TIMEOUT_MS.",
		promptSnippet: "Search the web for current or real-time information through the local Ollama web_search API.",
		promptGuidelines: [
			"Use web_search when the user needs current public web information that may not be in the model's training data.",
			"Keep web_search queries focused; use max_results only when a different result count is useful.",
			"Do not include secrets, tokens, or private repository data in web_search queries.",
			"Do not use web_search for repository-local code discovery; use repo_* or file/search tools instead.",
		],
	},
	webFetch: {
		name: "web_fetch",
		label: "web-fetch",
		description:
			"Fetch and extract text content from a web page URL using your local Ollama instance's web_fetch API. Requires Ollama running locally with web fetch enabled; supports per-call timeout_ms and PI_WEB_SEARCH_TIMEOUT_MS.",
		promptSnippet: "Fetch and extract text from a specific URL through the local Ollama web_fetch API.",
		promptGuidelines: [
			"Use web_fetch when the user provides a URL or after web_search returns a specific page that needs deeper reading.",
			"Do not pass URLs containing secrets or private credentials to web_fetch.",
			"Do not use web_fetch as a generic repository file reader; use read for local files.",
		],
	},
} satisfies Record<string, ToolDescription>;

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
			description: "Replace exact text in an existing file. Use for surgical edits; use Write only for intentional whole-file replacement.",
		},
		Write: {
			name: "Write",
			label: "Write",
			description: "Create or overwrite a file with complete contents. Use only when replacing the whole file is intended.",
		},
		Bash: {
			name: "Bash",
			label: "Bash",
			description: "Run shell commands for builds, tests, package managers, git, and project CLIs. Prefer Read/Edit/Write/Grep/Glob for file operations.",
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

export const CODEX_ALIAS_TOOL_DESCRIPTIONS = {
	shellCommand: {
		name: "shell",
		label: "shell",
		description: "Run shell commands for builds, tests, package managers, git, and project CLIs. For long/verification output, redirect to a log and show only bounded tail on failure; summarize passing logs. Set workdir/cwd instead of cd; prefer read for simple file reads.",
	},
	applyPatch: {
		name: "apply_patch",
		label: "apply_patch",
		description: `Apply file edits with a relative-path patch or standard unified diff. Use for creating, updating, moving, or deleting files; keep each patch focused.

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
