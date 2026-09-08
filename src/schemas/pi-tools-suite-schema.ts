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

const TerminalBellTelegramConfig = Type.Object(
	{
		botToken: Type.Optional(Type.String({ description: "Telegram bot token (from @BotFather) used to send completion/error/question notifications." })),
		chatId: Type.Optional(Type.String({ description: "Telegram chat id that receives the notifications. Message @userinfobot to look yours up." })),
	},
	{ description: "Forward terminal-bell notifications to a Telegram chat. Independent of the bundled desktop sound gate." },
);

const TerminalBellConfig = Type.Object(
	{
		sound: Type.Optional(Type.Boolean({ description: "Play terminal bell sound on completion/error." })),
		telegram: Type.Optional(TerminalBellTelegramConfig),
	},
	{ description: "Terminal bell configuration." },
);

// ---------------------------------------------------------------------------
// DCP (Dynamic Context Pruning)
// ---------------------------------------------------------------------------

const DcpManualModeConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Enable manual DCP mode." })),
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
		enabled: Type.Optional(Type.Boolean({ description: "Allow bounded automatic summary creation after pressure/opportunity gates." })),
		patience: Type.Optional(Type.Number({ description: "Completed actionable opportunities allowed before automatic compression.", minimum: 0 })),
		summarizerModel: Type.Optional(Type.Array(Type.String(), { description: "Ordered summarizer model refs; empty uses the deterministic extractive summary." })),
		timeoutMs: Type.Optional(Type.Number({ description: "Per-summarizer deadline in milliseconds.", minimum: 1 })),
	},
	{ description: "Bounded automatic compression fallback." },
);

const DcpCompressConfig = Type.Object(
	{
		maxContextPercent: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Maximum context percent (0–1 or '80%') before compression triggers." })),
		minContextPercent: Type.Optional(Type.Union([Type.Number(), Type.String()], { description: "Target context percent after compression." })),
		modelMaxContextPercent: Type.Optional(Type.Record(Type.String(), Type.Number(), { description: "Per-model max context percent overrides." })),
		modelMinContextPercent: Type.Optional(Type.Record(Type.String(), Type.Number(), { description: "Per-model min context percent overrides." })),
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
	},
	{ description: "Bounded DCP emergency strategy." },
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
	},
	{ description: "DCP (Dynamic Context Pruning) configuration." },
);

// ---------------------------------------------------------------------------
// Async subagents
// ---------------------------------------------------------------------------

const RetryConfig = Type.Object(
	{
		maxRetries: Type.Optional(Type.Number({ description: "Maximum retry attempts.", minimum: 0 })),
		backoffMs: Type.Optional(Type.Number({ description: "Base delay in ms before first retry.", minimum: 0 })),
		retryableExitCodes: Type.Optional(Type.Array(Type.Number(), { description: "Exit codes eligible for retry. Empty array disables retry." })),
	},
	{ description: "Retry configuration for sub-agents." },
);

const SubagentRoutingConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Enable fallback LLM selection for omitted subagentType values. Explicit valid types bypass the router; when disabled, every spawn task must specify a valid type." })),
		model: Type.Optional(Type.String({ description: "Router model in provider/model form." })),
		fallbackModels: Type.Optional(Type.Array(Type.String(), { uniqueItems: true, description: "Ordered router model fallbacks tried when the primary routing model is unavailable or fails. The current parent model is always tried last." })),
		maxTaskChars: Type.Optional(Type.Number({ description: "Max task/scope characters sent to router.", minimum: 100 })),
		maxTokens: Type.Optional(Type.Number({ description: "Max router response tokens.", minimum: 8 })),
		maxRetries: Type.Optional(Type.Number({ description: "Router request retries.", minimum: 0 })),
		timeoutMs: Type.Optional(Type.Number({ description: "Router request timeout in ms.", minimum: 1000 })),
		debug: Type.Optional(Type.Boolean({ description: "Show routing debug warnings." })),
	},
	{ description: "Fallback role routing for omitted types. Unknown explicit types or failed/incomplete routing reject the entire batch before any agents launch." },
);

const SubagentVisionConfig = Type.Object(
	{
		blindModelPatterns: Type.Optional(Type.Array(Type.String(), { description: "Glob-like model refs treated as unable to inspect images." })),
	},
	{ description: "Vision capability overrides." },
);

const SubagentPresetTypeOverride = Type.Object(
	{
		model: Type.Optional(Type.String({ description: "Model override for this type within the preset." })),
		fallbackModels: Type.Optional(Type.Array(Type.String(), { description: "Per-role fallback models." })),
		thinking: Type.Optional(Type.String({ description: "Thinking level override." })),
		extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Extra CLI arguments." })),
		timeoutMs: Type.Optional(Type.Number({ description: "Per-agent wall-clock timeout in ms.", minimum: 1 })),
	},
	{ description: "Per-type override within a preset." },
);

const SubagentPreset = Type.Object(
	{
		description: Type.Optional(Type.String({ description: "Preset description." })),
		models: Type.Optional(Type.Array(Type.String({ pattern: "^[^\\s/*]+/[^\\s*]+$" }), { uniqueItems: true, description: "Available model pool. Filter the agent's ordered models by membership; pool order is ignored. Empty intersection rejects spawn. Oracle also respects this pool." })),
		model: Type.Optional(Type.String({ description: "Legacy default model. Ignored when models is set.", deprecated: true })),
		fallbackModels: Type.Optional(Type.Array(Type.String(), { description: "Legacy fallback list. Ignored when models is set.", deprecated: true })),
		thinking: Type.Optional(Type.String({ description: "Default thinking level." })),
		extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Extra CLI arguments." })),
		timeoutMs: Type.Optional(Type.Number({ description: "Per-agent wall-clock timeout in ms.", minimum: 1 })),
		types: Type.Optional(Type.Record(Type.String(), SubagentPresetTypeOverride, { description: "Per-type overrides." })),
	},
	{ description: "Named available-model pool. Legacy model/types overrides remain supported; prefer models for new presets." },
);

const SubagentTypeConfig = Type.Object(
	{
		description: Type.Optional(Type.String({ description: "Role description for routing." })),
		icon: Type.Optional(Type.String({ description: "Agent icon name rendered by UIs (pix TUI icon themes and Pix Desktop lucide icons): agent, search, code, flask, globe, sparkles, brain, wrench, terminal, bug, book, eye, zap, rocket. Unknown names render as the neutral agent icon." })),
		models: Type.Optional(Type.Array(Type.String({ pattern: "^[^\\s/*]+/[^\\s*]+$" }), { uniqueItems: true, description: "Ordered model candidates. First usable member of the preset pool runs; only remaining compatible members can be used on quota failure. Replaces legacy model/fallbackModels/modelByParent selection." })),
		model: Type.Optional(Type.String({ description: "Legacy primary model; use models for new profiles.", deprecated: true })),
		fallbackModels: Type.Optional(Type.Array(Type.String(), { description: "Legacy candidates after model; use models for a complete ranked list.", deprecated: true })),
		thinking: Type.Optional(Type.String({ description: "Thinking level." })),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Enabled tools for this type." })),
		isolatedSkills: Type.Optional(Type.Array(Type.String(), { description: "Explicit skill files loaded after disabling normal skill discovery for this type." })),
		extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Extra CLI arguments." })),
		promptAppend: Type.Optional(Type.String({ description: "Extra prompt text appended after generated prompt." })),
		promptOverride: Type.Optional(Type.String({ description: "Full prompt replacement." })),
		retry: Type.Optional(RetryConfig),
		maxResultBytes: Type.Optional(Type.Number({ description: "Max bytes in result summary.", minimum: 0 })),
		timeoutMs: Type.Optional(Type.Number({ description: "Per-agent wall-clock timeout in ms.", minimum: 1 })),
	},
	{ description: "Configuration for a sub-agent type/role." },
);

const AsyncSubagentsConfig = Type.Object(
	{
		defaultType: Type.Optional(Type.String({ description: "Preferred role for genuinely ambiguous router tasks and legacy resolver default. Not used as a spawn fallback for missing/invalid routes." })),
		routing: Type.Optional(SubagentRoutingConfig),
		vision: Type.Optional(SubagentVisionConfig),
		presets: Type.Optional(Type.Record(Type.String(), SubagentPreset, { description: "Named spawn presets." })),
		types: Type.Optional(Type.Record(Type.String(), SubagentTypeConfig, { description: "Sub-agent type definitions." })),
		maxConcurrent: Type.Optional(Type.Number({ description: "Max concurrent agents per spawn batch (0 = unlimited).", minimum: 0 })),
		retry: Type.Optional(RetryConfig),
		maxResultBytes: Type.Optional(Type.Number({ description: "Global max bytes in result summary.", minimum: 0 })),
		timeoutMs: Type.Optional(Type.Number({ description: "Global per-agent wall-clock timeout in ms.", minimum: 1 })),
	},
	{ description: "Async sub-agent configuration." },
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

const ContextGatewayBudgetsConfig = Type.Object(
	{
		maxInlineBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 67108864, description: "Initial inline byte budget used by Context Gateway policy experiments. Default 8192." })),
		maxResultBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 67108864, description: "Experimental delivered-result byte budget. P01 observe measures the available tool-result content boundary; later shaping must account for the final provider-visible serialization. Default 8192." })),
		maxExactReadBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 67108864, description: "Future exact-read byte budget. Default 32768." })),
		maxSearchBytes: Type.Optional(Type.Integer({ minimum: 1, maximum: 67108864, description: "Future search-delivery byte budget. Default 8192." })),
		maxSearchMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Future search match budget. Default 12." })),
	},
	{ description: "Context Gateway delivery budgets. In P01 only maxResultBytes is used for passive observe accounting." },
);

const ContextGatewayConfig = Type.Object(
	{
		mode: Type.Optional(Type.Union(
			[Type.Literal("off"), Type.Literal("observe"), Type.Literal("enforce")],
			{ description: "Context Gateway mode. P01 implements off/observe; enforce is parsed but explicitly refused until later integration gates." },
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
		terminalBell: Type.Optional(TerminalBellConfig),
		dcp: Type.Optional(DcpConfig),
		asyncSubagents: Type.Optional(AsyncSubagentsConfig),
		toolRenderer: Type.Optional(ToolRendererConfig),
		promptCommands: Type.Optional(PromptCommandsConfig),
		secretFirewall: Type.Optional(SecretFirewallConfig),
		contextGateway: Type.Optional(ContextGatewayConfig),
		repoDiscovery: Type.Optional(RepoDiscoveryConfig),
		lsp: Type.Optional(LspConfig),
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
