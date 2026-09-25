export interface PiToolsSuiteModuleCatalogEntry {
	name: string;
	defaultEnabled: boolean;
}

/** Lightweight module metadata shared with configuration and Desktop settings. */
export const PI_TOOLS_SUITE_MODULE_CATALOG: readonly PiToolsSuiteModuleCatalogEntry[] = [
	{ name: "coding-discipline", defaultEnabled: true },
	{ name: "ast-grep", defaultEnabled: true },
	{ name: "async-subagents", defaultEnabled: true },
	{ name: "lsp", defaultEnabled: true },
	{ name: "comment-checker", defaultEnabled: true },
	{ name: "session-name", defaultEnabled: true },
	{ name: "session-recovery", defaultEnabled: true },
	{ name: "repo-discovery", defaultEnabled: true },
	{ name: "antigravity-auth", defaultEnabled: true },
	{ name: "opencode-import", defaultEnabled: true },
	{ name: "question", defaultEnabled: true },
	{ name: "todo", defaultEnabled: true },
	{ name: "model-tools", defaultEnabled: true },
	{ name: "usage", defaultEnabled: true },
	{ name: "web-search", defaultEnabled: true },
	{ name: "context-gateway", defaultEnabled: true },
	{ name: "truncation-metadata-normalizer", defaultEnabled: false },
	{ name: "dcp", defaultEnabled: true },
	{ name: "prompt-commands", defaultEnabled: true },
	{ name: "resource-registry", defaultEnabled: true },
	{ name: "credential-firewall", defaultEnabled: false },
	{ name: "codex-reasoning-fix", defaultEnabled: true },
];

export const PI_TOOLS_SUITE_MODULE_NAMES = PI_TOOLS_SUITE_MODULE_CATALOG.map((entry) => entry.name);
