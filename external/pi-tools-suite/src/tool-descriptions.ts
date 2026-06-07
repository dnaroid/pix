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
	promptSnippet: "Compress closed conversation slices as steady context housekeeping; after implementation + verification, compress before replying or starting a new task unless exact raw logs/diffs are still needed.",
	promptGuidelines: [
		"Treat completed implementation + verification slices as compression candidates immediately, not only at context-limit warnings.",
		"Do not carry large stale tool outputs, diffs, or exploration logs across task boundaries; summarize their actionable result instead.",
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
				"Sub-agent presets defined in async-subagents config and selected with /subagent-preset can choose per-role model/thinking/extra-arg configurations for future spawns across sessions until changed; AGENTS_PRESET or /subagent-preset session <name> overrides the saved preset for the current process/session; /subagent-preset init copies the bundled sample when no config exists.",
				"When subagentType is omitted, async-subagents asks a lightweight router model to choose the configured role from the current config; prefer omitting it unless the user or task constraints require an explicit role.",
				repoDiscovery
					? "Use for broad independent tracks, review axes, or hypotheses even though repo_* tools are available."
					: "Use first for broad codebase discovery split into tracks, review axes, or incident-triage hypotheses when repo_* tools are unavailable.",
				"Use action=spawn/status/wait/result/stop/cleanup with the matching options; spawned runs are registered under project .pi/subagents while the main session is alive so status/wait/stop can omit runDir for the latest run and result can resolve runDir by agentId. The parent session receives a follow-up system/custom message for each background agent when it finishes or fails, so the parent can stop after spawning instead of polling for completion.",
				"Collect compact results only when the parent task needs them.",
				"Spawned agents run in isolated background pi processes with extensions disabled to prevent recursive sub-agent spawning.",
				"Each agent has a wall-clock watchdog timeout (default 30 minutes); spawn timeoutSeconds or task timeoutSeconds can shorten it for tests or bounded probes.",
				"Concurrency is limited project-wide by maxConcurrent (default 5); excess agents queue automatically.",
				"Failed agents can be auto-retried with exponential backoff when retry is configured per type or globally.",
				"Preset fallbackModels can switch future sub-agent spawns in the current process/session to a fallback provider/model after quota/rate-limit failures; Antigravity account rotation is allowed to exhaust all accounts for the model first.",
			].join(" "),
			promptSnippet:
				"Use subagents action='spawn' when multiple independent agents are useful, the user asks to delegate/parallelize/split work, or one large review/deep investigation should stay out of the main context. " +
				"Default to omitting subagentType so the configured router chooses from the live role config; set it only when the user explicitly named a role, vision/image handling is required, or a deterministic technical override is needed. Avoid trivial reads/edits, and do not call status/wait immediately after spawn just for progress. " +
				(repoDiscovery
					? "For one semantic code-discovery question, use repo_search directly instead; for independent tracks/hypotheses/review axes, delegate even when repo_* tools are available. Use result with compact=true only after completion when findings are needed in the parent context."
					: "For one focused code-discovery question, use direct read/grep tools instead. When the user asks for broad discovery split into tracks, hypotheses, incident triage, release readiness, risk strategy, or parallel reviews and indexed discovery is unavailable, spawn several focused scan/quick agents first before parent-context file search. Use result with compact=true only after completion when findings are needed in the parent context."),
			promptGuidelines: [
				"Use action='spawn' only for LARGE or PARALLEL tasks: independent investigations, repo-wide sweeps, deep debugging, or code review/audit that would bloat the parent context.",
				"Treat explicit requests to delegate, use sub-agents, run parallel agents, split into independent tracks, investigate hypotheses, or run separate review axes as spawn triggers; spawn first unless the request is trivial or clearly single-file.",
				repoDiscovery
					? "Do not spawn merely because code is unfamiliar; make one direct repo_search call for a single discovery question, and spawn only when several separate questions or review axes should run independently."
					: "Do not spawn merely because code is unfamiliar; use direct read/grep tools for a single discovery question, and spawn only when several separate questions or review axes should run independently.",
				repoDiscovery
					? "When repo_search answers one discovery question, prefer it over a swarm; do not let repo_* availability suppress delegation for multi-track reviews, independent hypotheses, explicit parallelism, or deep isolated review."
					: "When indexed discovery is unavailable and the task spans multiple files, modules, hypotheses, or explicitly separate tracks, spawn a small swarm of focused scan/quick agents before serial grep/read in the parent context, even for a small project.",
				repoDiscovery
					? "For incident triage, release-readiness, or risk/test-strategy prompts with separate hypotheses or review tracks, prefer spawning focused review agents over doing every track serially in the parent context."
					: "For incident triage, release-readiness, or risk/test-strategy prompts with separate hypotheses or review tracks and no repo_* tools, call action='spawn' as the first discovery step; direct read/grep can follow after delegation if needed.",
				repoDiscovery
					? "Do not use subagents for exact-string lookups, known-file edits, typo/text replacements, or obvious one-file changes; use the cheapest direct path instead."
					: "Do not use subagents for exact-string lookups, known-file edits, typo/text replacements, or obvious one-file changes; use the cheapest direct path instead.",
				"Spawn multiple focused agents in one action='spawn' call when they investigate independent questions.",
				"For synthetic tests or intentionally bounded probes, pass timeoutSeconds slightly above the expected runtime so hung sub-agents are stopped automatically.",
				"For subagents action='spawn', default to leaving subagentType unset and let the lightweight router choose from configured role descriptions. Do not choose a role just because a built-in example seems to fit; the router has the current user config and presets. Set subagentType explicitly only when the user named the role, image inspection requires vision, tests need deterministic routing, or there is another concrete technical reason to bypass the router.",
				"Use subagentType='vision' with imagePaths and optional focus when a text-only/blind parent model needs a visual description of screenshots, UI state, diagrams, or other images.",
				"If the user asks to start, run, launch, or test parallel sub-agents, call action='spawn' and then stop; completion/failure notifications will wake the parent so do not immediately call action='status' or action='wait' just to see whether agents finished.",
				"Use action='status' for a non-blocking progress check or to recover after reload/crash.",
				"After spawn, project-local .pi/subagents/registry.json records latest runDir and agentId mappings until normal main-session shutdown; if runDir is missing after compaction/reload, call status without runDir or result with agentId instead of failing solely because runDir was lost.",
				"Use action='wait' only when the user asks to wait/collect now, or your next parent step depends on completion.",
				"Use action='result' only after status/wait confirms completion; keep compact=true unless full output is necessary.",
				"Use action='stop' when the user asks to stop, cancel, or kill running sub-agents.",
				"Use action='cleanup' with delete=true after collecting all results to free disk space.",
				"Do NOT use subagents for trivial tasks, single file reads, simple edits, or interactive user input.",
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
				"By default returns a compact structured summary/findings/files/risks/next actions plus artifact paths, not the full raw result text.",
				"Set compact=false only when the parent needs the full result text and stderr in context.",
				"A result.json with machine-readable structured output is written alongside the raw result.md on completion.",
				"Defaults to compact output to avoid polluting the parent context; the full result.md path is included for later inspection.",
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
			"Do not launch several broad repo_search calls for the same question before reading results. Make one targeted search, read the best returned ranges, then refine only if evidence is missing.",
			"Write a specific conceptual target, not a generic word. Add --path-prefix, --max-files, --dedupe-file, or --exclude-tests in args to reduce noise.",
			"After repo_search, read the returned ranges instead of launching another broad search unless a specific gap remains; prefer read over --include-content for full evidence unless you only need a compact preview.",
			"For mutation-site, bug-location, or behavior-cause questions, the assignment/write/branch/call that directly causes the behavior is the answer. If a read range contains that exact evidence, stop searching and answer from it.",
			"Avoid repeated near-duplicate searches after finding direct source evidence. Continue only for a named gap such as callers, persistence path, tests, or user-requested impact analysis, and make the follow-up query narrower.",
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
	description: "Track and keep in sync non-trivial multi-step work as todos. Actions: create, update, batch_create, batch_update, list, get, delete, clear, export, import. Supports parent/subtask hierarchy, blockers, deferred out-of-scope items, dependencies, and replace:true on create/batch_create/import for intentionally replacing an obsolete plan; skip trivial or chat-only requests. Resynchronize the plan when requirements are added, canceled, or become obsolete, whether from user input or discovered facts. For multi-step plans, include a final user-facing report todo in the initial create/batch_create plan when possible. Keep exactly one task in_progress and complete it only after verification.",
	promptSnippet: "Track/sync non-trivial multi-step work; include final report item; resync when requirements change; keep one task in_progress",
	promptGuidelines: [
		"Use `todo` for complex work with 3+ steps, explicit user task lists, or new non-trivial requirements. Skip single trivial tasks and purely conversational requests.",
		"For any multi-step implementation/debugging plan, include a final todo item in the initial create/batch_create plan for the user-facing final report. Give that final-report todo explicit description/acceptance criteria covering changed files/behavior, verification commands/results, remaining manual actions, and never substitute a compression/housekeeping note for the final report.",
		"When the user adds, removes, cancels, reprioritizes, or changes the goal, scope, requirements, constraints, or chosen approach, use `todo` before continuing to synchronize the plan: update still-relevant tasks, defer or delete obsolete tasks, add new required tasks, and adjust dependencies/order.",
		"When your own investigation or verification discovers new facts that make the current todo plan stale, incomplete, impossible, unsafe, or no longer the best approach, use `todo` to revise the plan immediately instead of following outdated tasks.",
		"Update todos as part of the workflow, not as end-of-task cleanup: whenever you start, finish, block, split, abandon, or materially change a step, call `todo` immediately before continuing.",
		"Before any non-trivial read/edit/test/tool work on a planned task, mark exactly one task in_progress with activeForm (present-continuous label); do this immediately after creating a plan if no task is active. Mark it completed immediately after the required verification, never in batches.",
		"If implementation is partial, tests fail, or a blocker remains, keep the task in_progress and add/update a blocker task instead of completing it.",
		"Never use `clear`, `delete`, or batch deletion to hide unfinished, stale, or forgotten todos. Defer obsolete items or update them with the reason; only delete when the user explicitly asks or the item was created by mistake.",
		"Before giving a final response for work that used todos, ensure every visible todo is completed, deferred, or intentionally still in_progress with a blocker/explanation.",
		"Keep subjects short and imperative; put details in description only when needed. Use parentId for large plans; use blockedBy on create and addBlockedBy/removeBlockedBy on update for dependencies.",
		"Use batch_create/batch_update for large explicit plans, but still keep exactly one visible task in_progress unless the user asks otherwise.",
		"When starting a new plan that supersedes existing unfinished todos, use batch_create with replace:true instead of appending; only omit replace when intentionally extending the current plan.",
		"list hides deleted tombstones unless includeDeleted:true; pass status or blockedOnly only when you need a filtered list.",
		"Use export/import for handoff or plan migration; import with replace:true only when the user explicitly wants to overwrite the current todo state.",
		"When every visible todo is completed, todo state clears automatically; do not call clear afterward just to remove completed tasks.",
		"Optional project persistence is controlled by `/todos persist on|off|status` or the discoverable `/todos-persist on|off|status` alias; when resuming a persisted plan, ask the user which items are in scope and run `/todos scope <id...>` or `/todos-scope <id...>` so out-of-scope active tasks become deferred.",
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
		description: "Run shell commands for builds, tests, package managers, git, and project CLIs. Set workdir/cwd instead of cd; prefer read for simple file reads.",
	},
	applyPatch: {
		name: "apply_patch",
		label: "apply_patch",
		description: `Apply file edits with a relative-path patch or a standard unified diff. Use for creating, updating, moving, or deleting files; keep each patch focused.

Begin-patch format:
*** Begin Patch
*** Update File: path/to/file
@@ optional context
-old text
+new text
*** End Patch

Begin-patch sections: *** Add File (new lines start with +), *** Update File (may include *** Move to: new/path), and *** Delete File. A single Begin Patch block may contain multiple file sections and modify multiple files; use one multi-file patch for tightly related edits, while keeping unrelated changes separate. Update hunks may use @@ optional context, omit the first @@, and use *** End of File. The whole begin patch may be wrapped in <<EOF ... EOF. Matching tolerates trailing-space, trim, and common Unicode punctuation differences.

Unified diff is also supported (for example, git diff output with ---/+++ headers). Paths must be workspace-relative, never absolute. Provide the complete patch in input.`,
	},
} satisfies Record<string, ToolDescription>;
