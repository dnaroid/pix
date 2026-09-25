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
	{ name: "lsp", defaultEnabled: true, description: "Enriches code mutations with Language Server diagnostics and manages shared LSP lifecycles." },
	{ name: "comment-checker", defaultEnabled: true, description: "Detects low-value generated comments in code changes and nudges the agent to remove them." },
	{ name: "session-name", defaultEnabled: true, description: "Provides a tool for reading or setting the current session title." },
	{ name: "session-recovery", defaultEnabled: true, description: "Provides bounded search and recovery tools over branch- and compaction-aware session history." },
	{ name: "repo-discovery", defaultEnabled: true, description: "Adds idx-backed repository context, search, audit, structure, architecture, and setup commands when available." },
	{ name: "antigravity-auth", defaultEnabled: true, description: "Adds Google Antigravity authentication, account rotation, model registration, and provider streaming support." },
	{ name: "opencode-import", defaultEnabled: true, description: "Imports supported OpenCode provider credentials into Pi without overwriting existing entries by default." },
	{ name: "question", defaultEnabled: true, description: "Registers the native clean-Pi questionnaire tool; Pix skips its runtime UI because Pix owns question rendering.", cleanPiOnly: true },
	{ name: "todo", defaultEnabled: true, description: "Adds session todo planning with hierarchy, blockers, persistence, import/export, and plan commands." },
	{ name: "model-tools", defaultEnabled: true, description: "Registers model-specific aliases and gated variants for common file, shell, search, and patch tools." },
	{ name: "usage", defaultEnabled: true, description: "Adds read-only quota and usage reporting for supported model providers." },
	{ name: "web-search", defaultEnabled: true, description: "Adds web_search and web_fetch with local/cloud Ollama and Tavily fallback plus credential management." },
	// Observe-only Context Gateway currently runs after result enrichers. P01-R
	// keeps this independent result chain; a coordinator is conditional future
	// enforce work only if a concrete ordering conflict is proven.
	{ name: "context-gateway", defaultEnabled: true, description: "Observes or enforces bounded result shaping and records privacy-safe context-efficiency telemetry." },
	// Explicit opt-in, non-store cleanup. Keep after Gateway observe so passive
	// telemetry measures the original boundary, and before downstream result
	// observers. This ordering does not depend on any particular DCP persistence
	// design; DCP is scheduled for a separate redesign.
	{ name: "truncation-metadata-normalizer", defaultEnabled: false, description: "Removes redundant truncation metadata text when it duplicates content already visible in the tool result." },
	{ name: "dcp", defaultEnabled: true, description: "Provides Dynamic Context Pruning, manual/automatic compression, context statistics, and recoverable summaries." },
	{ name: "prompt-commands", defaultEnabled: true, description: "Lets users create and manage saved prompt-backed slash commands from pi-tools-suite config." },
	{ name: "resource-registry", defaultEnabled: true, description: "Synchronizes reusable skills, agents, tasks, plans, and TODO state through a private Git registry." },
	// Secret firewall is intentionally opt-in. Keep it after payload-shaping modules.
	{ name: "credential-firewall", defaultEnabled: false, description: "Redacts high-confidence secrets from outbound payloads and optionally from persisted session content." },
	// Keep this last within the suite, after its other payload modifiers. Other
	// extensions may register later handlers; this is not a global ordering guarantee.
	{ name: "codex-reasoning-fix", defaultEnabled: true, description: "Strips legacy null or empty reasoning content fields before OpenAI Responses/Codex provider requests." },
];

export const PI_TOOLS_SUITE_MODULE_NAMES = PI_TOOLS_SUITE_MODULE_CATALOG.map((entry) => entry.name);
