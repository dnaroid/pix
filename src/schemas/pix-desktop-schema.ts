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

const SessionTitleConfig = Type.Object(
	{
		modelRef: Type.Optional(Type.String({ description: "Model used to generate compact session titles." })),
		fallbackModels: Type.Optional(Type.Array(Type.String(), { description: "Ordered session-title fallback models." })),
	},
	{ description: "Automatic Desktop session-title generation." },
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
		externalEditor: Type.Optional(Type.String({
			description: "External editor used by the Project explorer. Aliases include zed, code/vscode, cursor, subl/sublime, idea/intellij, and webstorm; an executable path/name is also accepted.",
		})),
		git: Type.Optional(Type.Object(
			{
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
		ignoreContextFiles: Type.Optional(Type.Boolean({
			description: "Disable AGENTS.md / CLAUDE.md discovery for Desktop sessions. A project .pi/pix-desktop.jsonc value overrides the user default.",
		})),
		defaultModel: Type.Optional(DefaultModelConfig),
		visibleModels: Type.Optional(Type.Array(Type.String({ description: "Provider/model identifier shown in the Desktop model picker." }), {
			description: "Desktop-only user model-picker whitelist. Omit to show every available model.",
		})),
		thinkingByModel: Type.Optional(Type.Record(Type.String(), ThinkingLevel, {
			description: "Desktop-only last-applied thinking level per provider/model.",
		})),
		promptEnhancer: Type.Optional(PromptEnhancerConfig),
		autocomplete: Type.Optional(AutocompleteConfig),
		sessionTitle: Type.Optional(SessionTitleConfig),
		dictation: Type.Optional(DictationConfig),
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
