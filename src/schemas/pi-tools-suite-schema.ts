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

// ---------------------------------------------------------------------------
// DCP (Dynamic Context Pruning)
// ---------------------------------------------------------------------------

const DcpManualModeConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Enable manual DCP mode." })),
		automaticStrategies: Type.Optional(Type.Boolean({ description: "Run dedup/purge even in manual mode." })),
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
	},
	{ description: "Compression trigger and behavior configuration." },
);

const DcpDeduplicationConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Enable duplicate content deduplication." })),
		protectedTools: Type.Optional(Type.Array(Type.String(), { description: "Tool outputs protected from dedup." })),
	},
	{ description: "Deduplication strategy configuration." },
);

const DcpPurgeErrorsConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Enable error input purging." })),
		turns: Type.Optional(Type.Number({ description: "Prune error inputs after N user turns.", minimum: 1 })),
		protectedTools: Type.Optional(Type.Array(Type.String(), { description: "Tool outputs protected from error purge." })),
	},
	{ description: "Error purging strategy configuration." },
);

const DcpAutoToolPruningConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Enable automatic tool output pruning." })),
		maxOutputTokens: Type.Optional(Type.Number({ description: "Maximum output tokens before truncation.", minimum: 0 })),
		keepRecentTurns: Type.Optional(Type.Number({ description: "Recent turns to keep.", minimum: 0 })),
		readLikeTools: Type.Optional(Type.Array(Type.String(), { description: "Tools treated as read-like (aggressively pruned)." })),
		readLikeTurns: Type.Optional(Type.Number({ description: "Turns threshold for read-like tool pruning.", minimum: 0 })),
		protectedTools: Type.Optional(Type.Array(Type.String(), { description: "Tool outputs protected from auto-pruning." })),
	},
	{ description: "Auto tool pruning strategy configuration." },
);

const DcpStrategiesConfig = Type.Object(
	{
		deduplication: Type.Optional(DcpDeduplicationConfig),
		purgeErrors: Type.Optional(DcpPurgeErrorsConfig),
		autoToolPruning: Type.Optional(DcpAutoToolPruningConfig),
	},
	{ description: "DCP pruning strategies." },
);

const DcpConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Enable DCP (Dynamic Context Pruning)." })),
		debug: Type.Optional(Type.Boolean({ description: "Enable DCP debug logging." })),
		manualMode: Type.Optional(DcpManualModeConfig),
		compress: Type.Optional(DcpCompressConfig),
		strategies: Type.Optional(DcpStrategiesConfig),
		protectedFilePatterns: Type.Optional(Type.Array(Type.String(), { description: "File path glob patterns whose content is protected from pruning." })),
		pruneNotification: Type.Optional(Type.Union(
			[Type.Literal("off"), Type.Literal("minimal"), Type.Literal("detailed")],
			{ description: "Notification level when pruning occurs." },
		)),
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
		enabled: Type.Optional(Type.Boolean({ description: "Enable LLM-based automatic role routing." })),
		model: Type.Optional(Type.String({ description: "Router model in provider/model form." })),
		maxTaskChars: Type.Optional(Type.Number({ description: "Max task/scope characters sent to router.", minimum: 100 })),
		maxTokens: Type.Optional(Type.Number({ description: "Max router response tokens.", minimum: 8 })),
		maxRetries: Type.Optional(Type.Number({ description: "Router request retries.", minimum: 0 })),
		timeoutMs: Type.Optional(Type.Number({ description: "Router request timeout in ms.", minimum: 1000 })),
		debug: Type.Optional(Type.Boolean({ description: "Show routing debug warnings." })),
	},
	{ description: "LLM-based role routing configuration." },
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
		model: Type.Optional(Type.String({ description: "Default model for this preset." })),
		fallbackModels: Type.Optional(Type.Array(Type.String(), { description: "Global fallback models for this preset." })),
		thinking: Type.Optional(Type.String({ description: "Default thinking level." })),
		extraArgs: Type.Optional(Type.Array(Type.String(), { description: "Extra CLI arguments." })),
		timeoutMs: Type.Optional(Type.Number({ description: "Per-agent wall-clock timeout in ms.", minimum: 1 })),
		types: Type.Optional(Type.Record(Type.String(), SubagentPresetTypeOverride, { description: "Per-type overrides." })),
	},
	{ description: "Named spawn preset." },
);

const SubagentTypeConfig = Type.Object(
	{
		description: Type.Optional(Type.String({ description: "Role description for routing." })),
		model: Type.Optional(Type.String({ description: "Model for this sub-agent type." })),
		fallbackModels: Type.Optional(Type.Array(Type.String(), { description: "Ordered model fallbacks." })),
		thinking: Type.Optional(Type.String({ description: "Thinking level." })),
		tools: Type.Optional(Type.Array(Type.String(), { description: "Enabled tools for this type." })),
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
		defaultType: Type.Optional(Type.String({ description: "Default sub-agent type when not specified." })),
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
		todoThinking: Type.Optional(Type.Boolean({ description: "Enable per-todo thinking levels and automatic thinking switch/restore when tasks become in-progress/completed." })),
		lookupModel: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Vision-capable provider/model used by GLM's lookup tool; unset or null disables lookup." })),
		terminalBell: Type.Optional(TerminalBellConfig),
		dcp: Type.Optional(DcpConfig),
		asyncSubagents: Type.Optional(AsyncSubagentsConfig),
		toolRenderer: Type.Optional(ToolRendererConfig),
		promptCommands: Type.Optional(PromptCommandsConfig),
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
