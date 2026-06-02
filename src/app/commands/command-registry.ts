import type { CommandControllerHost } from "./command-host.js";
import { parsePathArgument } from "./command-runtime.js";
import type { SlashCommand } from "../types.js";

export type CommandRegistryActions = {
	runSettingsCommand(): Promise<void>;
	runModelSlashCommand(argumentsText: string): Promise<void>;
	runDefaultModelSlashCommand(argumentsText: string): Promise<void>;
	runAutocompleteSlashCommand(argumentsText: string): Promise<void>;
	runScopedModelsCommand(argumentsText: string): Promise<void>;
	runThinkingSlashCommand(argumentsText: string): Promise<void>;
	runDefaultThinkingSlashCommand(argumentsText: string): Promise<void>;
	runEnhanceCommand(): Promise<void>;
	runExportCommand(argumentsText: string): Promise<void>;
	runImportCommand(argumentsText: string): Promise<void>;
	runShareCommand(): Promise<void>;
	runCopyCommand(): Promise<void>;
	runNameCommand(argumentsText: string): Promise<void>;
	runSessionInfoCommand(): Promise<void>;
	runUsageCommand(): Promise<void>;
	runChangelogCommand(): Promise<void>;
	runUpdateCommand(argumentsText: string): Promise<void>;
	runHotkeysCommand(): Promise<void>;
	runForkCommand(argumentsText: string): Promise<void>;
	runCloneCommand(): Promise<void>;
	runTreeCommand(argumentsText: string): Promise<void>;
	runJumpCommand(argumentsText: string): Promise<void>;
	runSearchCommand(argumentsText: string): Promise<void>;
	runUnsupportedBuiltinCommand(commandName: string, message: string): Promise<void>;
	runReloadCommand(): Promise<void>;
	runResumePathCommand(sessionPath: string): Promise<void>;
	runResumeCommand(): Promise<void>;
	runNewSessionCommand(): Promise<void>;
	runNewTabCommand(): Promise<void>;
	runCompactCommand(customInstructions?: string): Promise<void>;
};

export function createSlashCommands(actions: CommandRegistryActions, host: CommandControllerHost): readonly SlashCommand[] {
	return [
		{
			name: "settings",
			description: "Show renderer and Pi settings summary",
			kind: "builtin",
			keywords: ["config", "preferences", "options"],
			run: () => actions.runSettingsCommand(),
		},
		{
			name: "model",
			description: "Select the active model",
			kind: "builtin",
			keywords: ["provider", "llm", "ai", "switch"],
			allowArguments: true,
			run: (argumentsText) => actions.runModelSlashCommand(argumentsText),
		},
		{
			name: "default-model",
			description: "Set the default model for new sessions",
			kind: "builtin",
			keywords: ["model", "provider", "startup", "config"],
			allowArguments: true,
			run: (argumentsText) => actions.runDefaultModelSlashCommand(argumentsText),
		},
		{
			name: "autocomplete",
			description: "Set inline autocomplete model, or empty to disable",
			kind: "builtin",
			keywords: ["complete", "ghost", "suggest", "llm", "model"],
			allowArguments: true,
			run: (argumentsText) => actions.runAutocompleteSlashCommand(argumentsText),
		},
		{
			name: "scoped-models",
			description: "Show or set models used by the model selector/cycling",
			kind: "builtin",
			keywords: ["models", "enabled", "favorite", "scope", "cycle"],
			allowArguments: true,
			run: (argumentsText) => actions.runScopedModelsCommand(argumentsText),
		},
		{
			name: "thinking",
			description: "Select the thinking level",
			kind: "builtin",
			keywords: ["reasoning", "effort", "level", "minimal", "medium", "high"],
			allowArguments: true,
			run: (argumentsText) => actions.runThinkingSlashCommand(argumentsText),
		},
		{
			name: "default-thinking",
			description: "Set the default thinking level for new sessions",
			kind: "builtin",
			keywords: ["thinking", "reasoning", "startup", "config"],
			allowArguments: true,
			run: (argumentsText) => actions.runDefaultThinkingSlashCommand(argumentsText),
		},
		{
			name: "enhance",
			description: "Improve the current prompt draft",
			kind: "builtin",
			keywords: ["prompt", "rewrite", "improve", "kilocode"],
			run: () => actions.runEnhanceCommand(),
		},
		{
			name: "export",
			description: "Export session (HTML default, or .jsonl path)",
			kind: "builtin",
			keywords: ["save", "html", "jsonl", "transcript"],
			allowArguments: true,
			run: (argumentsText) => actions.runExportCommand(argumentsText),
		},
		{
			name: "import",
			description: "Import and resume a session from a JSONL file",
			kind: "builtin",
			keywords: ["load", "jsonl", "resume", "session"],
			allowArguments: true,
			run: (argumentsText) => actions.runImportCommand(argumentsText),
		},
		{
			name: "share",
			description: "Share session as a secret GitHub gist",
			kind: "builtin",
			keywords: ["gist", "github", "publish", "url"],
			run: () => actions.runShareCommand(),
		},
		{
			name: "copy",
			description: "Copy last agent message to clipboard",
			kind: "builtin",
			keywords: ["clipboard", "assistant", "message"],
			run: () => actions.runCopyCommand(),
		},
		{
			name: "name",
			description: "Show or set the session display name",
			kind: "builtin",
			keywords: ["rename", "title", "session"],
			allowArguments: true,
			run: (argumentsText) => actions.runNameCommand(argumentsText),
		},
		{
			name: "session",
			description: "Show session info and stats",
			kind: "builtin",
			keywords: ["stats", "info", "tokens", "cost"],
			run: () => actions.runSessionInfoCommand(),
		},
		{
			name: "usage",
			description: "Show local account quota usage",
			kind: "builtin",
			keywords: ["quota", "limits", "tokens", "context"],
			suppressCommandEcho: true,
			run: () => actions.runUsageCommand(),
		},
		{
			name: "changelog",
			description: "Show Pi package changelog",
			kind: "builtin",
			keywords: ["release", "version", "whats new"],
			run: () => actions.runChangelogCommand(),
		},
		{
			name: "update",
			description: "Check for Pix package updates",
			kind: "builtin",
			keywords: ["upgrade", "version", "release", "external"],
			allowArguments: true,
			run: (argumentsText) => actions.runUpdateCommand(argumentsText),
		},
		{
			name: "hotkeys",
			description: "Show renderer keyboard shortcuts",
			kind: "builtin",
			keywords: ["keys", "shortcuts", "help"],
			run: () => actions.runHotkeysCommand(),
		},
		{
			name: "fork",
			description: "Fork from the latest or specified user-message entry",
			kind: "builtin",
			keywords: ["branch", "session", "previous"],
			allowArguments: true,
			run: (argumentsText) => actions.runForkCommand(argumentsText),
		},
		{
			name: "clone",
			description: "Duplicate the current session at the current position",
			kind: "builtin",
			keywords: ["fork", "duplicate", "branch"],
			run: () => actions.runCloneCommand(),
		},
		{
			name: "tree",
			description: "Show tree entries or navigate to an entry id",
			kind: "builtin",
			keywords: ["branch", "navigate", "history"],
			allowArguments: true,
			run: (argumentsText) => actions.runTreeCommand(argumentsText),
		},
		{
			name: "jump",
			description: "Jump to a previous user message",
			kind: "builtin",
			keywords: ["user", "message", "messages", "history", "scroll", "goto", "navigate"],
			allowArguments: true,
			run: (argumentsText) => actions.runJumpCommand(argumentsText),
		},
		{
			name: "search",
			description: "Search sessions and open a match in a new tab",
			kind: "builtin",
			keywords: ["session", "history", "find", "grep", "text", "scroll", "goto"],
			allowArguments: true,
			run: (argumentsText) => actions.runSearchCommand(argumentsText),
		},
		{
			name: "login",
			description: "Configure provider authentication (not yet in pix UI)",
			kind: "builtin",
			keywords: ["auth", "oauth", "api key"],
			run: () => actions.runUnsupportedBuiltinCommand("login", "Provider authentication dialogs are not implemented in pix yet. Use the stock `pi` TUI or configure API keys in settings, then run /reload."),
		},
		{
			name: "logout",
			description: "Remove provider authentication (not yet in pix UI)",
			kind: "builtin",
			keywords: ["auth", "oauth", "api key"],
			run: () => actions.runUnsupportedBuiltinCommand("logout", "Provider authentication dialogs are not implemented in pix yet. Use the stock `pi` TUI or edit auth storage outside pix, then run /reload."),
		},
		{
			name: "reload",
			description: "Reload keybindings, extensions, skills, prompts, and themes",
			kind: "builtin",
			keywords: ["restart", "refresh", "resources", "extensions", "skills", "prompts"],
			run: () => actions.runReloadCommand(),
		},
		{
			name: "resume",
			description: "Resume a different session",
			kind: "builtin",
			keywords: ["session", "history", "switch", "restore"],
			allowArguments: true,
			run: (argumentsText) => {
				const sessionPath = parsePathArgument(argumentsText);
				return sessionPath ? actions.runResumePathCommand(sessionPath) : actions.runResumeCommand();
			},
		},
		{
			name: "new",
			description: "Start a fresh session",
			kind: "builtin",
			keywords: ["session", "fresh", "clear"],
			run: () => actions.runNewSessionCommand(),
		},
		{
			name: "new_tab",
			description: "Open a fresh session in a new tab",
			kind: "builtin",
			keywords: ["tab", "session", "fresh", "new"],
			run: () => actions.runNewTabCommand(),
		},
		{
			name: "compact",
			description: "Manually compact the session context",
			kind: "builtin",
			keywords: ["context", "compress", "summary", "summarize"],
			allowArguments: true,
			run: (argumentsText) => actions.runCompactCommand(argumentsText.trim() || undefined),
		},
		{
			name: "quit",
			description: "Quit the renderer",
			kind: "builtin",
			keywords: ["exit", "close"],
			run: async () => { await host.stop(); },
		},
		{
			name: "exit",
			description: "Quit the renderer",
			kind: "builtin",
			keywords: ["quit", "close"],
			run: async () => { await host.stop(); },
		},
	];
}
