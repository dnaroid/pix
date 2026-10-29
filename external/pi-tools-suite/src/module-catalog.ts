export interface PiToolsSuiteModuleCatalogEntry {
	name: string;
	defaultEnabled: boolean;
	description: string;
	cleanPiOnly?: boolean;
}

/**
 * Authoritative ordered module registry metadata shared by runtime loading,
 * configuration defaults, and Desktop Settings. Runtime entrypoints are derived
 * from each name via the src/<module-name>/index.ts convention.
 */
export const PI_TOOLS_SUITE_MODULE_CATALOG: readonly PiToolsSuiteModuleCatalogEntry[] = [
	{ name: "coding-discipline", defaultEnabled: true, description: "Injects model-specific coding discipline and lookup guidance into supported main-session prompts." },
	{ name: "ast-grep", defaultEnabled: true, description: "Adds structural AST search and apply tools for syntax-aware code inspection and edits." },
	{ name: "async-subagents", defaultEnabled: true, description: "Runs project and bundled subagents, orchestration workflows, retries, and persistent subagent status/results." },
	{ name: "brainstorm", defaultEnabled: true, description: "Ships the brainstorm skill and /brainstorm shortcut: a five-round multi-model council on persistent research sub-agents with a deterministic protocol helper." },
	{ name: "lsp", defaultEnabled: true, description: "Enriches code mutations with Language Server diagnostics and manages shared LSP lifecycles." },
	{ name: "comment-checker", defaultEnabled: true, description: "Detects low-value generated comments in code changes and nudges the agent to remove them." },
	{ name: "session", defaultEnabled: true, description: "Provides session naming and bounded history recovery through one action-based tool." },
	{ name: "project-search", defaultEnabled: true, description: "Searches project history and native Code/Knowledge, with globally configured embeddings; no second LLM." },
	{ name: "project-tasks", defaultEnabled: true, description: "Lists, reads and explicitly requested creates/updates saved project tasks with validated atomic persistence." },
	{ name: "antigravity-auth", defaultEnabled: true, description: "Adds Google Antigravity authentication, account rotation, model registration, and provider streaming support." },
	{ name: "claude-code-provider", defaultEnabled: true, description: "Provides Claude Code subscription models through the maintained local adapter." },
	{ name: "opencode-import", defaultEnabled: true, description: "Imports supported OpenCode provider credentials into Pi without overwriting existing entries by default." },
	{ name: "question", defaultEnabled: true, description: "Registers the native clean-Pi questionnaire tool; Pix skips its runtime UI because Pix owns question rendering.", cleanPiOnly: true },
	{ name: "todo", defaultEnabled: true, description: "Adds session todo planning with hierarchy, blockers, persistence, import/export, and plan commands." },
	// Before model-tools: Bash/bash/shell run_in_background delegates to this module's manager.
	{ name: "background-shell", defaultEnabled: true, description: "Runs agent shell commands in the background with shell_output/shell_kill/shell_jobs, per-session cleanup and orphan detection." },
	{ name: "model-tools", defaultEnabled: true, description: "Registers model-specific aliases and gated variants for common file, shell, search, and patch tools." },
	{ name: "codemode", defaultEnabled: true, description: "Enables SDK QuickJS scripts alongside direct tools. Changes apply after extension reload or session restart." },
	{ name: "usage", defaultEnabled: true, description: "Adds read-only quota and usage reporting for supported model providers." },
	{ name: "web-search", defaultEnabled: true, description: "Adds web_search and web_fetch with local/cloud Ollama and Tavily fallback plus credential management." },
	{ name: "truncation-metadata-normalizer", defaultEnabled: true, description: "Removes redundant truncation metadata text when it duplicates content already visible in the tool result." },
	{ name: "dcp", defaultEnabled: true, description: "Provides Dynamic Context Pruning, manual/automatic compression, context statistics, and recoverable summaries." },
	// After dcp, so DCP accounting sees the full transcript; before credential-firewall.
	{ name: "historical-thinking-prune", defaultEnabled: true, description: "Experimental, off until pruneHistoricalThinking is set: omits thinking from earlier turns in model requests for every provider." },
	{ name: "prompt-commands", defaultEnabled: true, description: "Lets users create and manage saved prompt-backed slash commands from pi-tools-suite config." },
	// Secret firewall is intentionally opt-in. Keep it after payload-shaping modules.
	{ name: "credential-firewall", defaultEnabled: false, description: "Redacts high-confidence secrets from outbound payloads and optionally from persisted session content." },
	// Keep this last within the suite, after its other payload modifiers. Other
	// extensions may register later handlers; this is not a global ordering guarantee.
	{ name: "codex-reasoning-fix", defaultEnabled: true, description: "Strips legacy null or empty reasoning content fields before OpenAI Responses/Codex provider requests." },
];

export const PI_TOOLS_SUITE_MODULE_NAMES = PI_TOOLS_SUITE_MODULE_CATALOG.map((entry) => entry.name);
