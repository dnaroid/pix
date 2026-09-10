/**
 * TypeBox JSON Schema definitions for pix.jsonc (~/.config/pi/pix.jsonc or <cwd>/.pi/pix.jsonc).
 *
 * These schemas describe the _user-facing_ config shape — all fields are optional
 * because the runtime applies generous defaults.  The generated JSON Schema files
 * include `"additionalProperties": true` so that future fields are not rejected.
 */
import { Type, Static } from "typebox";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

const DefaultThinkingSelection = Type.Union(
	["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((v) => Type.Literal(v)),
	{ description: "Default model thinking budget level." },
);

// ---------------------------------------------------------------------------
// Tool renderer
// ---------------------------------------------------------------------------

const ToolRendererRule = Type.Object(
	{
		previewLines: Type.Optional(Type.Number({ description: "Lines to show in the tool preview.", minimum: 0 })),
		direction: Type.Optional(Type.Union([Type.Literal("head"), Type.Literal("tail")], { description: "Show preview from head or tail of output." })),
		color: Type.Optional(Type.String({ description: "Theme color name (e.g. 'warning', 'success', 'muted') or hex color." })),
		defaultExpanded: Type.Optional(Type.Boolean({ description: "Whether the tool output is expanded by default." })),
		compactHidden: Type.Optional(Type.Boolean({ description: "Hide tool output but keep a compact one-line placeholder." })),
		hidden: Type.Optional(Type.Boolean({ description: "Completely hide the tool output." })),
	},
	{ description: "Rendering rule for a specific tool or glob pattern." },
);

const ToolRendererConfig = Type.Object(
	{
		default: Type.Optional(ToolRendererRule),
		tools: Type.Optional(Type.Record(Type.String(), ToolRendererRule, { description: "Tool-specific rendering rules keyed by tool name or glob pattern, e.g. 'bash' or 'repo_*'." })),
	},
	{ description: "Per-tool rendering configuration. Keys in 'tools' support glob patterns like 'repo_*'." },
);

// ---------------------------------------------------------------------------
// Other sections
// ---------------------------------------------------------------------------

const OutputFiltersConfig = Type.Object(
	{
		patterns: Type.Optional(Type.Array(Type.String(), { description: "Glob or /regex/ patterns to strip from tool output." })),
	},
	{ description: "Output filter patterns." },
);

const DefaultModelConfig = Type.Object(
	{
		modelRef: Type.Optional(Type.String({ description: "Provider/model identifier, e.g. 'openai-codex/gpt-5.4'." })),
		fallbackModels: Type.Optional(Type.Array(Type.String({ description: "Fallback provider/model identifier." }), { description: "Ordered default-model fallbacks tried after modelRef." })),
		thinking: Type.Optional(DefaultThinkingSelection),
	},
	{ description: "Default model selection for new sessions." },
);

const PromptEnhancerConfig = Type.Object(
	{
		modelRef: Type.Optional(Type.String({ description: "Model used for prompt enhancement." })),
		fallbackModels: Type.Optional(Type.Array(Type.String({ description: "Fallback provider/model identifier." }), { description: "Ordered prompt-enhancer fallbacks tried after modelRef." })),
	},
	{ description: "Prompt enhancer configuration." },
);

const SessionTitleConfig = Type.Object(
	{
		modelRef: Type.Optional(Type.String({ description: "Model used to generate compact session titles." })),
		fallbackModels: Type.Optional(Type.Array(Type.String({ description: "Fallback provider/model identifiers to try after the primary title model exhausts its retries." }))),
	},
	{ description: "Automatic session title generation configuration." },
);

const AutocompleteConfig = Type.Object(
	{
		modelRef: Type.Optional(Type.String({ description: "Model for inline autocomplete. Empty string disables LLM autocomplete." })),
		fallbackModels: Type.Optional(Type.Array(Type.String({ description: "Fallback provider/model identifier." }), { description: "Ordered autocomplete fallbacks tried after modelRef." })),
		debounceMs: Type.Optional(Type.Number({ description: "Delay after typing before requesting completion.", minimum: 100, maximum: 2000 })),
		timeoutMs: Type.Optional(Type.Number({ description: "Hard timeout for completion request.", minimum: 250, maximum: 10000 })),
		maxTokens: Type.Optional(Type.Number({ description: "Maximum output tokens.", minimum: 8, maximum: 256 })),
		maxPromptTokens: Type.Optional(Type.Number({ description: "Maximum input prompt tokens.", minimum: 256, maximum: 16000 })),
		includeRecentMessages: Type.Optional(Type.Number({ description: "Recent messages to include as context.", minimum: 0, maximum: 20 })),
	},
	{ description: "Inline autocomplete configuration." },
);

const ModelColorRulesConfig = Type.Record(
	Type.String(),
	Type.String({ description: "Theme color name for matching model references, e.g. 'success', 'warning', or 'modelOpenAI'." }),
	{ description: "Model reference glob pattern → theme color name mapping, e.g. 'zai/*': 'success'." },
);

const ModelColorsConfig = Type.Union(
	[
		ModelColorRulesConfig,
		Type.Object(
			{
				rules: Type.Optional(ModelColorRulesConfig),
			},
			{ description: "Alternative nested form for model color rules." },
		),
	],
	{ description: "Model color rules. Keys are glob patterns matching model refs; values are pix theme color names." },
);

const IconThemeConfig = Type.Object(
	{
		name: Type.Optional(Type.String({ description: "Icon theme name, e.g. 'nerdFont' or 'fallback'." })),
	},
	{ description: "Icon theme configuration." },
);

const DictationLanguageModelConfig = Type.Object(
	{
		label: Type.String({ description: "Human-readable language label." }),
		deepgramLanguage: Type.Optional(Type.String({ description: "Deepgram language code. Defaults to the language map key." })),
		dirName: Type.Optional(Type.String({ description: "Deprecated legacy Vosk model directory name; ignored by Deepgram dictation." })),
		url: Type.Optional(Type.String({ description: "Deprecated legacy Vosk model URL; ignored by Deepgram dictation." })),
	},
	{ description: "Deepgram voice dictation language definition." },
);

const DictationConfig = Type.Object(
	{
		language: Type.Optional(Type.String({ description: "Selected language code, e.g. 'en' or 'ru'." })),
		model: Type.Optional(Type.String({ description: "Deepgram speech-to-text model. Defaults to 'nova-3'." })),
		languages: Type.Optional(Type.Record(Type.String(), DictationLanguageModelConfig, { description: "Available dictation languages keyed by local language code." })),
	},
	{ description: "Voice dictation (Deepgram) configuration. Requires DEEPGRAM_API_KEY in the process environment." },
);

const DesktopConfig = Type.Object(
	{
		externalEditor: Type.Optional(Type.String({
			description: "External editor used by Pix Desktop project explorer. Known aliases include zed, code/vscode, cursor, subl/sublime, idea/intellij, and webstorm; an executable path/name is also accepted.",
		})),
		git: Type.Optional(Type.Object(
			{
				reviewModelRef: Type.Optional(Type.String({
					description: "Model reference used by Pix Desktop for LLM review of Git diffs, optionally with a :thinking suffix.",
				})),
				reviewFallbackModels: Type.Optional(Type.Array(Type.String(), {
					description: "Ordered fallback model references used for Git diff review.",
				})),
				commitMessageModelRef: Type.Optional(Type.String({
					description: "Model reference used by Pix Desktop to generate Git commit messages, optionally with a :thinking suffix.",
				})),
				commitMessageFallbackModels: Type.Optional(Type.Array(Type.String(), {
					description: "Ordered fallback model references used for Git commit-message generation.",
				})),
			},
			{ description: "Pix Desktop Git/Source Control LLM preferences." },
		)),
	},
	{ description: "Pix Desktop-specific preferences." },
);

// ---------------------------------------------------------------------------
// Top-level schema
// ---------------------------------------------------------------------------

export const PixConfigSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String({ description: "JSON Schema URL used by editors for validation and autocomplete." })),
		ignoreContextFiles: Type.Optional(Type.Boolean({ description: "Disable AGENTS.md / CLAUDE.md discovery for sessions started in this project, equivalent to pi --no-context-files." })),
		maxProjectSessions: Type.Optional(Type.Number({ description: "Maximum number of pi session JSONL files to retain per project. Set to 0 to disable automatic session deletion.", minimum: 0 })),
		defaultModel: Type.Optional(DefaultModelConfig),
		toolRenderer: Type.Optional(ToolRendererConfig),
		outputFilters: Type.Optional(OutputFiltersConfig),
		promptEnhancer: Type.Optional(PromptEnhancerConfig),
		autocomplete: Type.Optional(AutocompleteConfig),
		sessionTitle: Type.Optional(SessionTitleConfig),
		modelColors: Type.Optional(ModelColorsConfig),
		iconTheme: Type.Optional(IconThemeConfig),
		dictation: Type.Optional(DictationConfig),
		desktop: Type.Optional(DesktopConfig),
	},
	{
		$id: "https://unpkg.com/pi-ui-extend/schemas/pix.json",
		$schema: "https://json-schema.org/draft-07/schema#",
		title: "Pix Configuration",
		description: "Configuration for the pix terminal renderer (~/.config/pi/pix.jsonc, with project overrides in <cwd>/.pi/pix.jsonc).",
		additionalProperties: true,
	},
);

export type PixConfigSchemaType = Static<typeof PixConfigSchema>;
