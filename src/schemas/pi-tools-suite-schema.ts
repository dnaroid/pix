/**
 * TypeBox JSON Schema definitions for pi-tools-suite.jsonc (~/.config/pi/pi-tools-suite.jsonc).
 *
 * All fields are optional because the runtime applies generous defaults.
 * The generated JSON Schema includes `"additionalProperties": true`.
 */
import { Type, Static } from "typebox";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tool renderer (same shape as pix)
// ---------------------------------------------------------------------------

const ToolRendererRule = Type.Object(
	{
		previewLines: Type.Optional(Type.Number({ minimum: 0, description: "Lines to show in the tool preview." })),
		direction: Type.Optional(Type.Union([Type.Literal("head"), Type.Literal("tail")], { description: "Preview direction." })),
		color: Type.Optional(Type.String({ description: "Theme color name or hex color." })),
		defaultExpanded: Type.Optional(Type.Boolean({ description: "Expand tool output by default." })),
		compactHidden: Type.Optional(Type.Boolean({ description: "Compact hidden placeholder." })),
		hidden: Type.Optional(Type.Boolean({ description: "Hide tool output completely." })),
	},
	{ description: "Per-tool rendering rule." },
);

const ToolRendererConfig = Type.Object(
	{
		default: Type.Optional(ToolRendererRule),
		tools: Type.Optional(Type.Record(Type.String(), ToolRendererRule, { description: "Tool-specific rendering rules keyed by tool name or glob pattern, e.g. 'bash' or 'repo_*'." })),
	},
	{ description: "Per-tool rendering configuration." },
);

// ---------------------------------------------------------------------------
// Terminal bell
// ---------------------------------------------------------------------------

const TerminalBellConfig = Type.Object(
	{
		sound: Type.Optional(Type.Boolean({ description: "Play terminal bell sound on completion/error." })),
	},
	{ description: "Terminal bell configuration." },
);

const TelegramConnectorConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Enable the Telegram task connector. Defaults to enabled when botToken and chatId are present." })),
		botToken: Type.Optional(Type.String({ description: "Telegram Bot API token from @BotFather." })),
		chatId: Type.Optional(Type.Union([
			Type.String(),
			Type.Integer(),
		], { description: "Private Telegram chat id allowed to control Pix." })),
	},
	{ description: "Receive completion/question notifications and send follow-up or new-session tasks from Telegram." },
);

// ---------------------------------------------------------------------------
// DCP (Dynamic Context Pruning)
// ---------------------------------------------------------------------------

const DcpManualModeConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Enable manual DCP mode." })),
		automaticStrategies: Type.Optional(Type.Never({ description: "Removed legacy key. Manual mode now has only the explicit enabled flag." })),
	},
	{ description: "Manual mode configuration." },
);

const DcpAutoCandidatesConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Enable auto candidate selection for compression." })),
		minContextPercent: Type.Optional(Type.Number({ description: "Minimum context usage to trigger auto-candidates.", minimum: 0, maximum: 1 })),
		keepRecentTurns: Type.Optional(Type.Number({ description: "Number of recent turns to keep.", minimum: 0 })),
		minMessages: Type.Optional(Type.Number({ description: "Minimum messages before auto-candidate selection.", minimum: 0 })),
		minTokens: Type.Optional(Type.Number({ description: "Minimum tokens for auto-candidate selection.", minimum: 0 })),
	},
	{ description: "Auto-candidate selection for compression." },
);

const DcpMessageModeConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Enable message-mode compression suggestions." })),
		minContextPercent: Type.Optional(Type.Number({ description: "Minimum context usage to trigger message mode.", minimum: 0, maximum: 1 })),
		keepRecentTurns: Type.Optional(Type.Number({ description: "Recent turns to keep.", minimum: 0 })),
		mediumTokens: Type.Optional(Type.Number({ description: "Token threshold for medium-quality summary.", minimum: 0 })),
		highTokens: Type.Optional(Type.Number({ description: "Token threshold for high-quality summary.", minimum: 0 })),
		maxSuggestions: Type.Optional(Type.Number({ description: "Maximum compression suggestions.", minimum: 0 })),
	},
	{ description: "Message-mode compression configuration." },
);

const DcpAutoCompressConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Allow autonomous compression after pressure/opportunity gates. Explicit compress calls can still use summarizerModel when summary is omitted." })),
		patience: Type.Optional(Type.Number({ description: "Completed actionable opportunities allowed before automatic compression.", minimum: 0 })),
		summarizerModel: Type.Optional(Type.Array(Type.String(), { description: "Ordered model refs used by auto-compress and explicit compress when summary is omitted; empty uses the deterministic extractive summary." })),
		summarizerFallbackModels: Type.Optional(Type.Array(Type.String(), { description: "Ordered fallback model refs tried after summarizerModel." })),
		timeoutMs: Type.Optional(Type.Number({ description: "Per-summarizer deadline in milliseconds for automatic and explicit generated summaries.", minimum: 1 })),
	},
	{ description: "Bounded automatic compression fallback." },
);

const DcpCompressConfig = Type.Object(
	{
		maxContextPercent: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Maximum context percent (0–1 or '80%') before compression triggers." })),
		minContextPercent: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Target context percent after compression." })),
		modelMaxContextPercent: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()]), { description: "Per-model max context overrides using the same fraction/token/percent formats." })),
		modelMinContextPercent: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()]), { description: "Per-model min context overrides using the same fraction/token/percent formats." })),
		maxContextLimit: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Absolute max context tokens or '200k'." })),
		minContextLimit: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Absolute min context tokens." })),
		modelMaxContextLimits: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()]), { description: "Per-model max context limit overrides." })),
		modelMinContextLimits: Type.Optional(Type.Record(Type.String(), Type.Union([Type.Number(), Type.String()]), { description: "Per-model min context limit overrides." })),
		summaryBuffer: Type.Optional(Type.Boolean({ description: "Buffer summary output." })),
		nudgeFrequency: Type.Optional(Type.Number({ description: "Inject nudge every N context events.", minimum: 1 })),
		iterationNudgeThreshold: Type.Optional(Type.Number({ description: "Nudge after N tool calls since last user message.", minimum: 1 })),
		nudgeForce: Type.Optional(Type.Union([Type.Literal("strong"), Type.Literal("soft")], { description: "Nudge intensity." })),
		protectedTools: Type.Optional(Type.Array(Type.String(), { description: "Tool outputs protected from pruning." })),
		protectTags: Type.Optional(Type.Boolean({ description: "Protect XML-like tags from pruning." })),
		protectUserMessages: Type.Optional(Type.Boolean({ description: "Protect user messages from pruning." })),
		autoCandidates: Type.Optional(DcpAutoCandidatesConfig),
		messageMode: Type.Optional(DcpMessageModeConfig),
		autoCompress: Type.Optional(DcpAutoCompressConfig),
	},
	{ description: "Compression trigger and behavior configuration." },
);

const DcpEmergencyCurrentTurnPruningConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Enable bounded same-turn emergency planning and last-resort output pruning." })),
		hardContextPercent: Type.Optional(Type.Number({ description: "Context fraction that activates hard emergency pressure.", minimum: 0, maximum: 1 })),
		targetContextPercent: Type.Optional(Type.Number({ description: "Context fraction the emergency path attempts to recover toward.", minimum: 0, maximum: 1 })),
		patience: Type.Optional(Type.Number({ description: "Completed emergency opportunities allowed before last-resort pruning.", minimum: 0 })),
		keepRecentToolPairs: Type.Optional(Type.Number({ description: "Newest complete tool-call/result pairs never selected by emergency cleanup.", minimum: 0 })),
		minOutputTokens: Type.Optional(Type.Number({ description: "Minimum tool-result size eligible for emergency pruning.", minimum: 0 })),
		maxSuggestions: Type.Optional(Type.Number({ description: "Maximum emergency message candidates shown in a reminder.", minimum: 0 })),
		protectedTools: Type.Optional(Type.Array(Type.String(), { description: "Additional tools protected from emergency pruning and manual sweep." })),
	},
	{ description: "Single bounded emergency cleanup strategy." },
);

const DcpStrategiesConfig = Type.Object(
	{
		emergencyCurrentTurnPruning: Type.Optional(DcpEmergencyCurrentTurnPruningConfig),
		deduplication: Type.Optional(Type.Never({ description: "Removed legacy key; no automatic replacement policy maps to it." })),
		purgeErrors: Type.Optional(Type.Never({ description: "Removed legacy key; no automatic replacement policy maps to it." })),
		autoToolPruning: Type.Optional(Type.Never({ description: "Removed legacy key. Use explicit /dcp sweep or DCP compression/emergency policies instead." })),
	},
	{ description: "Bounded DCP emergency strategy." },
);

const DcpConfigOverride = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean()),
		debug: Type.Optional(Type.Boolean()),
		debugLog: Type.Optional(Type.Object({
			maxBytes: Type.Optional(Type.Number({ minimum: 1024 })),
			maxBackups: Type.Optional(Type.Number({ minimum: 1 })),
		})),
		manualMode: Type.Optional(DcpManualModeConfig),
		compress: Type.Optional(DcpCompressConfig),
		strategies: Type.Optional(DcpStrategiesConfig),
		protectedFilePatterns: Type.Optional(Type.Array(Type.String())),
		pruneNotification: Type.Optional(Type.Never({ description: "Removed legacy key; pruning notifications are no longer configurable." })),
	},
	{ description: "Partial DCP override applied to a matching provider/model or bare-model key. Keys support * and ? wildcards." },
);

const DcpConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Enable DCP (Dynamic Context Pruning)." })),
		debug: Type.Optional(Type.Boolean({ description: "Enable DCP debug logging." })),
		debugLog: Type.Optional(Type.Object(
			{
				maxBytes: Type.Optional(Type.Number({ description: "Maximum size in bytes of the active debug log before it is rotated. Default 5242880 (5 MB).", minimum: 1024 })),
				maxBackups: Type.Optional(Type.Number({ description: "Number of rotated backups to keep (.1 .. .N). Default 3, minimum 1.", minimum: 1 })),
			},
			{ description: "Debug log rotation. The JSONL log is written to ~/.pi/agent/dcp-debug.jsonl." },
		)),
		manualMode: Type.Optional(DcpManualModeConfig),
		compress: Type.Optional(DcpCompressConfig),
		strategies: Type.Optional(DcpStrategiesConfig),
		protectedFilePatterns: Type.Optional(Type.Array(Type.String(), { description: "File path glob patterns whose content is protected from pruning." })),
		modelOverrides: Type.Optional(Type.Record(Type.String(), DcpConfigOverride, { description: "Per-model partial DCP overrides. Exact keys take precedence over matching wildcards." })),
		pruneNotification: Type.Optional(Type.Never({ description: "Removed legacy key; pruning notifications are no longer configurable." })),
	},
	{ description: "DCP (Dynamic Context Pruning) configuration." },
);

// ---------------------------------------------------------------------------
// Prompt commands
// ---------------------------------------------------------------------------

const PromptCommand = Type.Object(
	{
		description: Type.Optional(Type.String({ description: "Short description shown in command menu." })),
		prompt: Type.String({ description: "The prompt text to send. Supports {cwd} template variable." }),
	},
	{ description: "A saved slash command." },
);

const PromptCommandsConfig = Type.Object(
	{
		commands: Type.Optional(Type.Record(Type.String(), PromptCommand, { description: "Command definitions keyed by slash command name." })),
	},
	{ description: "User-defined slash commands." },
);

const SecretFirewallConfig = Type.Object(
	{
		sessionHygiene: Type.Optional(Type.Boolean({ description: "Redact detected secret material from tool results and completed messages before it remains in session history." })),
		notify: Type.Optional(Type.Boolean({ description: "Show a warning when one or more secrets are redacted. Secret values are never included in notifications." })),
	},
	{ description: "Settings for the opt-in credential-firewall module." },
);

const CommentCheckerConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Enable or disable comment-checker without disabling the whole module." })),
		strictness: Type.Optional(Type.Union(
			[Type.Literal("conservative"), Type.Literal("balanced"), Type.Literal("aggressive")],
			{ description: "Comment classification strictness. Defaults to balanced." },
		)),
	},
	{ description: "Settings for the comment-checker module." },
);

const ContextGatewayBudgetsConfig = Type.Object(
	{
		maxInlineBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 67108864, description: "Maximum inline size for a proven compact representation. Default 8192." })),
		maxResultBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 67108864, description: "Budget for shell/other result classes. Selective enforce currently compacts only recognised complete simple test/build output. Default 8192." })),
		maxExactReadBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 67108864, description: "Read-class observation budget. Reads remain passthrough because snapshot-safe recovery is not available. Default 32768." })),
		maxSearchBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 67108864, description: "Repo-search/AST/structure observation budget. Gateway does not post-hoc truncate producer output. Default 8192." })),
		maxSearchMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Reserved search-match policy budget. Default 12." })),
	},
	{ description: "Context Gateway class-specific observation and selective-enforcement budgets." },
);

const ContextGatewayConfig = Type.Object(
	{
		mode: Type.Optional(Type.Union(
			[Type.Literal("off"), Type.Literal("observe"), Type.Literal("enforce")],
			{ description: "Context Gateway mode. observe is passive; enforce only compacts proven complete simple test/build output and otherwise passes results through." },
		)),
		budgets: Type.Optional(ContextGatewayBudgetsConfig),
	},
	{ description: "Context Gateway configuration. Default mode is off." },
);

const RepoDiscoveryConfig = Type.Object(
	{
		profile: Type.Optional(Type.Union(
			[Type.Literal("baseline"), Type.Literal("native-compact")],
			{ description: "repo_* runtime profile. baseline preserves historical argv/defaults; native-compact enables bounded native flags, cursors, validation, and an explicit per-call full override." },
		)),
	},
	{ description: "Repository discovery runtime policy. Default profile is baseline." },
);

const ResourceRegistryConfig = Type.Object(
	{
		remote: Type.Optional(Type.String({ description: "Git remote URL for the private registry. The repository contains reusable top-level skills/ and agents/ plus project-scoped state under projects/." })),
		branch: Type.Optional(Type.String({ description: "Registry branch used for install/update/push/pull. Defaults to main." })),
		projectKey: Type.Optional(Type.String({ description: "Optional explicit key for this project's projects/<key>/tasks.jsonc, plans/, and TODO.md state. Normally derived from the current Git origin." })),
	},
	{ description: "Private Git-backed registry for reusable skills/agents and project-scoped tasks/plans state." },
);

// ---------------------------------------------------------------------------
// LSP
// ---------------------------------------------------------------------------

const LspServerConfig = Type.Object(
	{
		id: Type.String({ description: "Unique server identifier." }),
		enabled: Type.Optional(Type.Boolean({ description: "Enable/disable this server." })),
		include: Type.Optional(Type.Array(Type.String(), { description: "File glob patterns to include." })),
		exclude: Type.Optional(Type.Array(Type.String(), { description: "File glob patterns to exclude." })),
		rootMarkers: Type.Optional(Type.Array(Type.String(), { description: "Files that indicate a project root (e.g. ['package.json', '.git'])." })),
		maxFileSizeBytes: Type.Optional(Type.Number({ description: "Max file size to send to the server.", minimum: 0 })),
		bin: Type.String({ description: "Path to the language server binary." }),
		args: Type.Optional(Type.Array(Type.String(), { description: "Command-line arguments." })),
		cwd: Type.Optional(Type.String({ description: "Working directory for the server process." })),
		env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Environment variables." })),
		config: Type.Optional(Type.String({ description: "Path to server configuration file." })),
		languageIdByExtension: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "File extension → language ID mapping, e.g. {'.ts': 'typescript'}." })),
		startupTimeoutMs: Type.Optional(Type.Number({ description: "Server startup timeout in ms.", minimum: 1000 })),
		diagnosticsWaitMs: Type.Optional(Type.Number({ description: "Wait time for diagnostics after file change.", minimum: 0 })),
		pullDiagnostics: Type.Optional(Type.Boolean({ description: "When false, skip textDocument/diagnostic pull requests and rely on published diagnostics. Useful for servers where pull diagnostics is slow or incomplete." })),
		waitForPublishDiagnostics: Type.Optional(Type.Boolean({ description: "When false, do not wait for a fresh textDocument/publishDiagnostics notification after file change. diagnosticsWaitMs still bounds the wait when enabled." })),
		initializationOptions: Type.Optional(Type.Unknown({ description: "LSP initialization options passed to the server." })),
		settings: Type.Optional(Type.Unknown({ description: "LSP workspace/settings passed to the server." })),
	},
	{ description: "LSP server configuration." },
);

const LspConfig = Type.Object(
	{
		servers: Type.Optional(Type.Array(LspServerConfig, { description: "LSP server definitions." })),
	},
	{ description: "Language Server Protocol configuration." },
);

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

export const PiToolsSuiteConfigSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String({ description: "JSON Schema URL used by editors for validation and autocomplete." })),
		enabled: Type.Optional(Type.Boolean({ description: "Enable or disable the entire pi-tools-suite extension." })),
		disabledModules: Type.Optional(Type.Array(Type.String(), { description: "List of disabled module names (e.g. ['lsp', 'prompt-commands'])." })),
		enabledModules: Type.Optional(Type.Array(Type.String(), { description: "List of module names to explicitly enable, including modules that are disabled by default." })),
		modules: Type.Optional(Type.Record(Type.String(), Type.Boolean(), { description: "Per-module enable/disable map. credential-firewall is disabled by default and can be enabled here." })),
		todoThinking: Type.Optional(Type.Boolean({ description: "Enable per-todo thinking levels and automatic thinking switch/restore when tasks become in-progress/completed." })),
		todoThinkingOverrides: Type.Optional(Type.Record(
			Type.String(),
			Type.Union([
				Type.Literal("off"),
				Type.Literal("minimal"),
				Type.Literal("low"),
				Type.Literal("medium"),
				Type.Literal("high"),
				Type.Literal("xhigh"),
				Type.Literal("max"),
				Type.Null(),
			]),
			{ description: "Force per-todo thinking for matching provider/model or bare-model keys. Keys support * and ? wildcards; null removes an inherited override." },
		)),
		lookupModel: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Vision-capable provider/model used by GLM's lookup tool; unset or null disables lookup." })),
		lookupFallbackModels: Type.Optional(Type.Array(Type.String(), { description: "Ordered lookup model fallbacks tried after lookupModel." })),
		terminalBell: Type.Optional(TerminalBellConfig),
		telegramConnector: Type.Optional(TelegramConnectorConfig),
		commentChecker: Type.Optional(CommentCheckerConfig),
		dcp: Type.Optional(DcpConfig),
		toolRenderer: Type.Optional(ToolRendererConfig),
		promptCommands: Type.Optional(PromptCommandsConfig),
		secretFirewall: Type.Optional(SecretFirewallConfig),
		contextGateway: Type.Optional(ContextGatewayConfig),
		repoDiscovery: Type.Optional(RepoDiscoveryConfig),
		resourceRegistry: Type.Optional(ResourceRegistryConfig),
		lsp: Type.Optional(LspConfig),
		asyncSubagents: Type.Optional(Type.Never({ description: "Removed legacy key. Configure sub-agents in .pi/agents/*.md and model pools in .pi/agents/presets.jsonc." })),
	},
	{
		$id: "https://unpkg.com/pi-ui-extend/schemas/pi-tools-suite.json",
		$schema: "https://json-schema.org/draft-07/schema#",
		title: "Pi Tools Suite Configuration",
		description: "Configuration for the pi-tools-suite extension (~/.config/pi/pi-tools-suite.jsonc).",
		additionalProperties: true,
	},
);

export type PiToolsSuiteConfigSchemaType = Static<typeof PiToolsSuiteConfigSchema>;
