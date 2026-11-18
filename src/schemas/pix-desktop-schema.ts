/**
 * User-facing Pix Desktop configuration schema.
 *
 * Desktop owns a separate profile from the terminal UI:
 *   ~/.config/pi/pix-desktop.jsonc
 *   <cwd>/.pi/pix-desktop.jsonc
 *
 * Keep this schema limited to settings that Desktop or its ACP backend consumes.
 */
import { Type, Static } from "typebox";
import { DEFAULT_HEADS_UP_CONFIG, DEFAULT_HEADS_UP_MODEL } from "../bundled-extensions/heads-up/config.js";

const ThinkingLevel = Type.Union(
	["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => Type.Literal(value)),
	{ description: "Model thinking budget level." },
);

const DefaultModelConfig = Type.Object(
	{
		modelRef: Type.Optional(Type.String({ description: "Provider/model identifier used for new Desktop sessions." })),
		fallbackModels: Type.Optional(Type.Array(Type.String({ description: "Fallback provider/model identifier." }), {
			description: "Ordered default-model fallbacks tried after modelRef.",
		})),
		thinking: Type.Optional(ThinkingLevel),
	},
	{ description: "Default model selection for new Desktop sessions." },
);

const ModelRoutingTier = Type.Object(
	{
		id: Type.String({
			description: "Stable semantic tier id used by the router, e.g. simple, standard, complex, or expert.",
			pattern: "^[a-z][a-z0-9_-]*$",
		}),
		description: Type.String({ description: "Semantic description sent to the router when choosing this tier.", minLength: 1 }),
		modelRef: Type.String({ description: "Provider/model selected when the router chooses this tier.", minLength: 1 }),
		thinking: ThinkingLevel,
	},
	{ description: "One semantic automatic model-routing tier." },
);

const ModelRoutingConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ description: "Enable Auto in new-draft and live-session Desktop pickers. A live selection opens a new Auto-routed draft; only its first real prompt is routed before session creation." })),
		default: Type.Optional(Type.Boolean({ description: "Start new Desktop conversation drafts in Auto routing mode by default." })),
		modelRef: Type.Optional(Type.String({ description: "Primary router model. OpenRouter Jev Latest is available as openrouter/~typesafe/jev-latest." })),
		fallbackModels: Type.Optional(Type.Array(Type.String(), { description: "Ordered router-model fallbacks." })),
		defaultTier: Type.Optional(Type.String({ description: "Tier id used if every router model fails or returns an invalid choice." })),
		tiers: Type.Optional(Type.Array(ModelRoutingTier, { minItems: 1, description: "Semantic target tiers the router may select." })),
	},
	{ description: "Optional first-prompt automatic model routing. Disabled by default." },
);

const PromptEnhancerConfig = Type.Object(
	{
		modelRef: Type.Optional(Type.String({ description: "Model used for prompt enhancement." })),
		fallbackModels: Type.Optional(Type.Array(Type.String(), {
			description: "Ordered prompt-enhancer fallbacks tried after modelRef.",
		})),
	},
	{ description: "Prompt enhancer configuration." },
);

const AutocompleteConfig = Type.Object(
	{
		modelRef: Type.Optional(Type.String({ description: "Model for inline autocomplete. Empty string disables LLM autocomplete." })),
		fallbackModels: Type.Optional(Type.Array(Type.String(), { description: "Ordered autocomplete fallbacks tried after modelRef." })),
		debounceMs: Type.Optional(Type.Number({ description: "Delay after typing before requesting completion.", minimum: 100, maximum: 2000 })),
		timeoutMs: Type.Optional(Type.Number({ description: "Hard timeout for a completion request.", minimum: 250, maximum: 10000 })),
		maxTokens: Type.Optional(Type.Number({ description: "Maximum autocomplete output tokens.", minimum: 8, maximum: 256 })),
		maxPromptTokens: Type.Optional(Type.Number({ description: "Maximum autocomplete input prompt tokens.", minimum: 256, maximum: 16000 })),
		includeRecentMessages: Type.Optional(Type.Number({ description: "Recent conversation messages included as autocomplete context.", minimum: 0, maximum: 20 })),
	},
	{ description: "Desktop inline autocomplete configuration." },
);

const SelectionAssistConfig = Type.Object(
	{
		modelRef: Type.Optional(Type.String({ description: "Model used to explain selected preview code and translate selected chat text. Empty or omitted reuses the autocomplete model chain." })),
		fallbackModels: Type.Optional(Type.Array(Type.String(), { description: "Ordered selection-assistant fallbacks tried after modelRef." })),
		language: Type.Optional(Type.String({ default: "ru", description: "Language for code explanations and the translation target, e.g. 'ru' or 'en'." })),
	},
	{ description: "Desktop selection assistant: Explain Code in Preview and Translate in chat." },
);

const SessionTitleConfig = Type.Object(
	{
		modelRef: Type.Optional(Type.String({ description: "Model used to generate compact session titles." })),
		fallbackModels: Type.Optional(Type.Array(Type.String(), { description: "Ordered session-title fallback models." })),
	},
	{ description: "Automatic Desktop session-title generation." },
);

const HeadsUpConfig = Type.Object(
	{
		enabled: Type.Optional(Type.Boolean({ default: false, description: "Enable the passive observer in new Desktop sessions. Existing sessions are unchanged until reloaded." })),
		model: Type.Optional(Type.String({ default: DEFAULT_HEADS_UP_MODEL, minLength: 3, maxLength: 256, pattern: "^[^\\s/]+/[^\\s]+$", description: "Provider/model identifier used by the passive observer. No automatic fallback." })),
		minTurns: Type.Optional(Type.Integer({ default: DEFAULT_HEADS_UP_CONFIG.minTurns, minimum: 1, maximum: 100, description: "Completed turns between automatic observer checks." })),
		minIntervalMs: Type.Optional(Type.Integer({ default: DEFAULT_HEADS_UP_CONFIG.minIntervalMs, minimum: 0, maximum: 86400000, description: "Minimum interval between observer checks in milliseconds." })),
		maxChecksPerHour: Type.Optional(Type.Integer({ default: DEFAULT_HEADS_UP_CONFIG.maxChecksPerHour, minimum: 1, maximum: 100, description: "Maximum observer checks per hour." })),
		maxInputChars: Type.Optional(Type.Integer({ default: DEFAULT_HEADS_UP_CONFIG.maxInputChars, minimum: 2000, maximum: 50000, description: "Maximum context characters in one observer check." })),
		maxInputCharsPerHour: Type.Optional(Type.Integer({ default: DEFAULT_HEADS_UP_CONFIG.maxInputCharsPerHour, minimum: 2000, maximum: 1000000, description: "Maximum observer input characters per hour." })),
		maxTokens: Type.Optional(Type.Integer({ default: DEFAULT_HEADS_UP_CONFIG.maxTokens, minimum: 256, maximum: 2000, description: "Maximum output tokens requested for an observer check." })),
		timeoutMs: Type.Optional(Type.Integer({ default: DEFAULT_HEADS_UP_CONFIG.timeoutMs, minimum: 1000, maximum: 120000, description: "Observer request timeout in milliseconds." })),
		noticeTtlMs: Type.Optional(Type.Integer({ default: DEFAULT_HEADS_UP_CONFIG.noticeTtlMs, minimum: 30000, maximum: 3600000, description: "How long an observer notice remains visible in milliseconds." })),
	},
	{ description: "Desktop-only passive observer settings. Project values override user values when the project is trusted." },
);

const DictationConfig = Type.Object(
	{
		apiKey: Type.Optional(Type.String({
			description: "Deepgram API key for Desktop voice input. Stored only in ~/.config/pi/pix-desktop.jsonc; project config cannot override this secret. Desktop exchanges it through /v1/auth/grant, which requires Member or higher Deepgram permission.",
		})),
		language: Type.Optional(Type.String({ description: "Deepgram language code sent directly to speech recognition, e.g. 'en', 'ru', 'uk', or 'de'." })),
		model: Type.Optional(Type.String({ description: "Deepgram speech-to-text model. Defaults to 'nova-3'." })),
	},
	{ description: "Desktop voice dictation configuration. DEEPGRAM_API_KEY remains an environment fallback." },
);

const DesktopAppConfig = Type.Object(
	{
		theme: Type.Optional(Type.Union([Type.Literal("system"), Type.Literal("light"), Type.Literal("dark")], {
			default: "system",
			description: "Desktop color theme. 'system' follows the macOS appearance; 'light' or 'dark' override it for all Pix windows. Global user preference only.",
		})),
		logPanelEnabled: Type.Optional(Type.Boolean({
			default: false,
			description: "Show the diagnostic Logs view in the Desktop sidebar. Global user preference only; disabled by default. Does not change log collection.",
		})),
		trayOnly: Type.Optional(Type.Boolean({
			default: false,
			description: "macOS: add a Pix menu bar icon while keeping the Dock icon and application menus. The menu lists all open windows. Legacy key name; no longer hides the Dock. Global user preference only; takes effect after restarting Pix.",
		})),
		externalEditor: Type.Optional(Type.String({
			description: "External file editor used by Project and Preview open-in-editor actions. Common values include gram, zed, code/vscode, cursor, subl/sublime, idea/intellij, and webstorm; an executable path/name is also accepted. When omitted, Desktop asks the user to choose an editor instead of assuming one.",
		})),
		projectIcon: Type.Optional(Type.Object(
			{
				model: Type.Optional(Type.String({
					description: "OpenRouter image-generation model used for project logos. Defaults to google/gemini-2.5-flash-image.",
				})),
			},
			{ description: "AI project-logo generation preferences." },
		)),
		notifications: Type.Optional(Type.Object(
			{
				enabled: Type.Optional(Type.Boolean({
					default: true,
					description: "Enable background and inactive-session notifications using the selected Desktop delivery mode.",
				})),
				usePix: Type.Optional(Type.Boolean({
					default: false,
					description: "Play an audible sound without Pix popups or native macOS notifications. No OS notification permission is requested.",
				})),
			},
			{ description: "Desktop notification delivery preferences." },
		)),
		git: Type.Optional(Type.Object(
			{
				ciFixModelRef: Type.Optional(Type.String({ description: "Model used by Desktop Fix with AI CI-repair sessions, optionally with a :thinking suffix. Omit to use the normal default model." })),
				reviewModelRef: Type.Optional(Type.String({ description: "Model used for Source Control LLM diff review, optionally with a :thinking suffix." })),
				reviewFallbackModels: Type.Optional(Type.Array(Type.String(), { description: "Ordered fallback models for Git diff review." })),
				commitMessageModelRef: Type.Optional(Type.String({ description: "Model used to generate Git commit messages, optionally with a :thinking suffix." })),
				commitMessageFallbackModels: Type.Optional(Type.Array(Type.String(), { description: "Ordered fallback models for Git commit-message generation." })),
			},
			{ description: "Desktop Source Control LLM preferences." },
		)),
	},
	{ description: "Pix Desktop application preferences." },
);

export const PixDesktopConfigSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String({ description: "JSON Schema URL used by editors for validation and autocomplete." })),
		knowledgeCheck: Type.Optional(Type.Object({
			modelRef: Type.Optional(Type.String({ default: "", maxLength: 256, pattern: "^(?:[^\\s/:]+/[^\\s:]+)?$",
				description: "User-global Wiki contradiction judge, in provider/model format without a thinking suffix. Empty or omitted inherits Tools Suite knowledgeCheck.modelRef. Never uses the Search or session model; a judge must be configured explicitly." })),
			thinking: Type.Optional(Type.Union([Type.Literal(""), ThinkingLevel], { default: "",
				description: "Wiki contradiction judge reasoning override. Empty or omitted inherits Tools Suite knowledgeCheck.thinking (low when unset). Independent of Search RAG thinking." })),
			reportLanguage: Type.Optional(Type.Union([Type.Literal(""), Type.Literal("en"), Type.Literal("ru")], {
				default: "",
				description: "User-global language override for Wiki contradiction reports. Empty or omitted inherits the Tools Suite setting (English by default); source quotations are preserved.",
			})),
		}, { description: "Wiki contradiction judge and report preferences, read from the user-global configuration." })),
		ignoreContextFiles: Type.Optional(Type.Boolean({
			description: "Disable AGENTS.md / CLAUDE.md discovery for Desktop sessions. A project .pi/pix-desktop.jsonc value overrides the user default.",
		})),
		defaultModel: Type.Optional(DefaultModelConfig),
		modelRouting: Type.Optional(ModelRoutingConfig),
		visibleModels: Type.Optional(Type.Array(Type.String({ description: "Provider/model identifier shown in the Desktop model picker." }), {
			description: "Desktop-only user model-picker whitelist. Omit to show every available model.",
		})),
		thinkingByModel: Type.Optional(Type.Record(Type.String(), ThinkingLevel, {
			description: "Desktop-only last-applied thinking level per provider/model.",
		})),
		promptEnhancer: Type.Optional(PromptEnhancerConfig),
		autocomplete: Type.Optional(AutocompleteConfig),
		selectionAssist: Type.Optional(SelectionAssistConfig),
		sessionTitle: Type.Optional(SessionTitleConfig),
		search: Type.Optional(Type.Object(
			{
				ragModelRef: Type.Optional(Type.String({ default: "", description: "Answer-generation model for Universal Search RAG, in provider/model format. Empty uses the Desktop default model. This is independent of the Jev Auto classifier." })),
				ragThinking: Type.Optional(ThinkingLevel),
				intentModelRef: Type.Optional(Type.String({ default: "", description: "OpenRouter model (openrouter/<id>) for the Universal Search Auto intent and quick-task type classifiers. Empty uses OpenRouter Jev Latest." })),
			},
			{ description: "Desktop universal search: centralized semantic provider status and independent RAG generation preferences." },
		)),
		dictation: Type.Optional(DictationConfig),
		headsUp: Type.Optional(HeadsUpConfig),
		desktop: Type.Optional(DesktopAppConfig),
	},
	{
		$id: "https://unpkg.com/pi-ui-extend/schemas/pix-desktop.json",
		$schema: "https://json-schema.org/draft-07/schema#",
		title: "Pix Desktop Configuration",
		description: "Configuration used only by Pix Desktop (~/.config/pi/pix-desktop.jsonc, with project overrides in <cwd>/.pi/pix-desktop.jsonc). TUI pix.jsonc is not inherited.",
		additionalProperties: true,
	},
);

export type PixDesktopConfigSchemaType = Static<typeof PixDesktopConfigSchema>;
