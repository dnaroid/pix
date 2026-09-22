<script lang="ts">
  import {
    formatSettingsDefaultValue,
    parseSettingsSource,
    removeSettingsValue,
    settingsDefaultValue,
    settingsHasValue,
    settingsValue,
    updateSettingsSource,
    type SettingsSchema,
  } from "../../lib/settings";
  import type { ModelThinkingModel } from "../../lib/model-thinking";
  import SettingsFieldRow from "./SettingsFieldRow.svelte";
  import SettingsModelList from "./SettingsModelList.svelte";
  import SettingsModelRoutingTiers, { type ModelRoutingTierDraft } from "./SettingsModelRoutingTiers.svelte";
  import SettingsModelSelect from "./SettingsModelSelect.svelte";
  import SettingsModelVisibility from "./SettingsModelVisibility.svelte";
  import SettingsNumberInput from "./SettingsNumberInput.svelte";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SettingsSwitch from "./SettingsSwitch.svelte";
  import SettingsTextInput from "./SettingsTextInput.svelte";

  export type DesktopSettingsSection = "general" | "models" | "assistant" | "voice" | "editor" | "source-control";

  const THINKING_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    .map((value) => ({ value, label: value === "xhigh" ? "Extra high" : value[0]!.toUpperCase() + value.slice(1) }));
  const LANGUAGE_OPTIONS = [
    ["en", "English"],
    ["ru", "Russian"],
    ["uk", "Ukrainian"],
    ["pl", "Polish"],
    ["de", "German"],
    ["fr", "French"],
    ["es", "Spanish"],
    ["it", "Italian"],
    ["pt", "Portuguese"],
    ["nl", "Dutch"],
    ["ja", "Japanese"],
    ["ko", "Korean"],
    ["zh", "Chinese"],
  ].map(([value, label]) => ({ value: value!, label: `${label} · ${value}` }));
  const SPEECH_MODEL_OPTIONS = [
    { value: "nova-3", label: "Nova-3" },
    { value: "nova-2", label: "Nova-2" },
    { value: "nova", label: "Nova" },
  ];
  const EDITOR_OPTIONS = [
    { value: "zed", label: "Zed" },
    { value: "code", label: "Visual Studio Code" },
    { value: "cursor", label: "Cursor" },
    { value: "subl", label: "Sublime Text" },
    { value: "idea", label: "IntelliJ IDEA" },
    { value: "webstorm", label: "WebStorm" },
  ];

  let {
    source,
    schema,
    models,
    section,
    onChange,
  }: {
    source: string;
    schema: SettingsSchema;
    models: readonly ModelThinkingModel[];
    section: DesktopSettingsSection;
    onChange: (source: string) => void;
  } = $props();

  const parsed = $derived(parseSettingsSource(source).value);
  const gitModelOptions = $derived.by(() => models.flatMap((model) => [
    {
      value: model.ref,
      label: `${model.name} · Default thinking`,
      description: model.ref,
      aliases: [model.ref, model.modelId, model.provider, "default thinking"],
      keywords: [model.name, `${model.provider} ${model.modelId}`],
    },
    ...model.thinkingLevels
      .filter((level) => level !== "off")
      .map((level) => ({
        value: `${model.ref}:${level}`,
        label: `${model.name} · ${level === "xhigh" ? "Extra high" : level}`,
        description: `${model.ref}:${level}`,
        aliases: [model.ref, model.modelId, model.provider, level, level === "xhigh" ? "extra high" : level],
        keywords: [model.name, `${model.provider} ${model.modelId}`, level],
      })),
  ]));
  const routingTiers = $derived.by<ModelRoutingTierDraft[]>(() => {
    const value = effective(["modelRouting", "tiers"]);
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry): ModelRoutingTierDraft[] => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const tier = entry as Record<string, unknown>;
      if (
        typeof tier.id !== "string"
        || typeof tier.description !== "string"
        || typeof tier.modelRef !== "string"
        || typeof tier.thinking !== "string"
      ) return [];
      return [{
        id: tier.id,
        description: tier.description,
        modelRef: tier.modelRef,
        thinking: tier.thinking,
      }];
    });
  });
  const routingTierOptions = $derived(routingTiers.map((tier) => ({
    value: tier.id,
    label: tier.id,
  })));

  function has(path: readonly string[]): boolean {
    return settingsHasValue(parsed, path);
  }

  function effective(path: readonly string[]): unknown {
    if (has(path)) return settingsValue(parsed, path);
    return settingsDefaultValue("desktop", schema, path).value;
  }

  function defaultLabel(path: readonly string[]): string {
    const fallback = settingsDefaultValue("desktop", schema, path);
    return fallback.exists ? `Default · ${formatSettingsDefaultValue(fallback.value)}` : "Unset when omitted";
  }

  function set(path: readonly string[], value: unknown): void {
    onChange(updateSettingsSource(source, path, value));
  }

  function reset(path: readonly string[]): void {
    onChange(removeSettingsValue(source, path));
  }

  function text(path: readonly string[]): string {
    const value = effective(path);
    return typeof value === "string" ? value : "";
  }

  function number(path: readonly string[]): number | undefined {
    const value = effective(path);
    return typeof value === "number" ? value : undefined;
  }

  function bool(path: readonly string[]): boolean {
    return effective(path) === true;
  }

  function list(path: readonly string[]): string[] {
    const value = effective(path);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  }

  function updateNumber(path: readonly string[], value: number | undefined): void {
    if (value === undefined) reset(path);
    else set(path, value);
  }

  function setVisibleModels(value: string[] | undefined): void {
    if (value === undefined) reset(["visibleModels"]);
    else set(["visibleModels"], value);
  }
</script>

{#if section === "general"}
  <div class="px-2.5 py-2.5">
    <h2 class="text-sm font-semibold text-foreground">General</h2>
    <p class="mt-0.5 text-xs leading-4 text-muted-foreground">Desktop session behavior that applies before model-specific features.</p>
  </div>
  <div class="border-y border-sidebar-border/70 bg-panel">
    <SettingsFieldRow
      label="Ignore context files"
      description="Do not discover AGENTS.md or CLAUDE.md for Desktop sessions. Project Desktop config can override this value."
      explicit={has(["ignoreContextFiles"])}
      defaultLabel={defaultLabel(["ignoreContextFiles"])}
      onReset={() => reset(["ignoreContextFiles"])}
    >
      <SettingsSwitch value={bool(["ignoreContextFiles"])} onChange={(value) => set(["ignoreContextFiles"], value)} />
    </SettingsFieldRow>
  </div>
{:else if section === "models"}
  <div class="px-2.5 py-2.5">
    <h2 class="text-sm font-semibold text-foreground">Models</h2>
    <p class="mt-0.5 text-xs leading-4 text-muted-foreground">Defaults for new sessions plus the model list exposed by Desktop.</p>
  </div>
  <div class="border-y border-sidebar-border/70 bg-panel">
    <SettingsFieldRow
      label="Default model"
      description="Provider/model identifier used for new Desktop sessions."
      explicit={has(["defaultModel", "modelRef"])}
      defaultLabel={defaultLabel(["defaultModel", "modelRef"])}
      onReset={() => reset(["defaultModel", "modelRef"])}
    >
      <SettingsModelSelect value={text(["defaultModel", "modelRef"])} {models} onChange={(value) => set(["defaultModel", "modelRef"], value)} />
    </SettingsFieldRow>

    <SettingsFieldRow
      label="Default thinking"
      description="Thinking budget applied when a new session starts."
      explicit={has(["defaultModel", "thinking"])}
      defaultLabel={defaultLabel(["defaultModel", "thinking"])}
      onReset={() => reset(["defaultModel", "thinking"])}
    >
      <SettingsSelect value={text(["defaultModel", "thinking"])} options={THINKING_OPTIONS} onChange={(value) => set(["defaultModel", "thinking"], value)} />
    </SettingsFieldRow>

    <SettingsFieldRow
      label="Default fallbacks"
      description="Ordered models tried after the default model."
      explicit={has(["defaultModel", "fallbackModels"])}
      defaultLabel={defaultLabel(["defaultModel", "fallbackModels"])}
      onReset={() => reset(["defaultModel", "fallbackModels"])}
    >
      <SettingsModelList value={list(["defaultModel", "fallbackModels"])} {models} addLabel="Add fallback" onChange={(value) => set(["defaultModel", "fallbackModels"], value)} />
    </SettingsFieldRow>

    <SettingsFieldRow
      label="Automatic model routing"
      description="Expose Auto for new drafts and route the first real prompt to a semantic task tier before the session is created."
      explicit={has(["modelRouting", "enabled"])}
      defaultLabel={defaultLabel(["modelRouting", "enabled"])}
      onReset={() => reset(["modelRouting", "enabled"])}
    >
      <SettingsSwitch value={bool(["modelRouting", "enabled"])} onChange={(value) => set(["modelRouting", "enabled"], value)} />
    </SettingsFieldRow>

    <SettingsFieldRow
      label="Auto by default"
      description="Start each new conversation draft in Auto. An explicit model selection still overrides it."
      explicit={has(["modelRouting", "default"])}
      defaultLabel={defaultLabel(["modelRouting", "default"])}
      onReset={() => reset(["modelRouting", "default"])}
    >
      <SettingsSwitch value={bool(["modelRouting", "default"])} onChange={(value) => set(["modelRouting", "default"], value)} />
    </SettingsFieldRow>

    <SettingsFieldRow
      label="Router model"
      description="Short classification call used only by Auto. The default is OpenRouter Jev Latest."
      explicit={has(["modelRouting", "modelRef"])}
      defaultLabel={defaultLabel(["modelRouting", "modelRef"])}
      onReset={() => reset(["modelRouting", "modelRef"])}
    >
      <SettingsModelSelect
        value={text(["modelRouting", "modelRef"])}
        {models}
        ariaLabel="Router model"
        onChange={(value) => set(["modelRouting", "modelRef"], value)}
      />
    </SettingsFieldRow>

    <SettingsFieldRow
      label="Router fallbacks"
      description="Ordered models tried when the primary router is unavailable or returns no valid tier."
      explicit={has(["modelRouting", "fallbackModels"])}
      defaultLabel={defaultLabel(["modelRouting", "fallbackModels"])}
      onReset={() => reset(["modelRouting", "fallbackModels"])}
    >
      <SettingsModelList
        value={list(["modelRouting", "fallbackModels"])}
        {models}
        addLabel="Add router fallback"
        onChange={(value) => set(["modelRouting", "fallbackModels"], value)}
      />
    </SettingsFieldRow>

    <SettingsFieldRow
      label="Routing fallback tier"
      description="Deterministic tier used if every router model fails or returns an invalid choice."
      explicit={has(["modelRouting", "defaultTier"])}
      defaultLabel={defaultLabel(["modelRouting", "defaultTier"])}
      onReset={() => reset(["modelRouting", "defaultTier"])}
    >
      <SettingsSelect
        value={text(["modelRouting", "defaultTier"])}
        options={routingTierOptions}
        onChange={(value) => set(["modelRouting", "defaultTier"], value)}
      />
    </SettingsFieldRow>

    <SettingsFieldRow
      label="Routing tiers"
      description="Semantic task classes available to the router. Each tier owns its target model and thinking level."
      explicit={has(["modelRouting", "tiers"])}
      defaultLabel={defaultLabel(["modelRouting", "tiers"])}
      onReset={() => reset(["modelRouting", "tiers"])}
    >
      <SettingsModelRoutingTiers
        value={routingTiers}
        {models}
        onChange={(value) => set(["modelRouting", "tiers"], value)}
      />
    </SettingsFieldRow>

    <SettingsFieldRow
      label="Visible models"
      description="Choose which models appear in the Desktop model picker."
      explicit={has(["visibleModels"])}
      defaultLabel={defaultLabel(["visibleModels"])}
      onReset={() => reset(["visibleModels"])}
    >
      <SettingsModelVisibility explicit={has(["visibleModels"])} value={list(["visibleModels"])} {models} onChange={setVisibleModels} />
    </SettingsFieldRow>
  </div>
{:else if section === "assistant"}
  <div class="px-2.5 py-2.5">
    <h2 class="text-sm font-semibold text-foreground">Assistant features</h2>
    <p class="mt-0.5 text-xs leading-4 text-muted-foreground">Models and limits used by prompt enhancement, autocomplete, and automatic session titles.</p>
  </div>
  <div class="border-y border-sidebar-border/70 bg-panel">
    <SettingsFieldRow
      label="Prompt enhancer model"
      description="Model used when Desktop improves a draft prompt."
      explicit={has(["promptEnhancer", "modelRef"])}
      defaultLabel={defaultLabel(["promptEnhancer", "modelRef"])}
      onReset={() => reset(["promptEnhancer", "modelRef"])}
    >
      <SettingsModelSelect value={text(["promptEnhancer", "modelRef"])} {models} onChange={(value) => set(["promptEnhancer", "modelRef"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Prompt enhancer fallbacks"
      explicit={has(["promptEnhancer", "fallbackModels"])}
      defaultLabel={defaultLabel(["promptEnhancer", "fallbackModels"])}
      onReset={() => reset(["promptEnhancer", "fallbackModels"])}
    >
      <SettingsModelList value={list(["promptEnhancer", "fallbackModels"])} {models} addLabel="Add fallback" onChange={(value) => set(["promptEnhancer", "fallbackModels"], value)} />
    </SettingsFieldRow>

    <SettingsFieldRow
      label="Autocomplete model"
      description="Model used for inline prompt completions. Set an explicit empty string to disable LLM autocomplete."
      explicit={has(["autocomplete", "modelRef"])}
      defaultLabel={defaultLabel(["autocomplete", "modelRef"])}
      onReset={() => reset(["autocomplete", "modelRef"])}
    >
      <SettingsModelSelect value={text(["autocomplete", "modelRef"])} {models} emptyLabel="Disabled" onChange={(value) => set(["autocomplete", "modelRef"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Autocomplete fallbacks"
      explicit={has(["autocomplete", "fallbackModels"])}
      defaultLabel={defaultLabel(["autocomplete", "fallbackModels"])}
      onReset={() => reset(["autocomplete", "fallbackModels"])}
    >
      <SettingsModelList value={list(["autocomplete", "fallbackModels"])} {models} addLabel="Add fallback" onChange={(value) => set(["autocomplete", "fallbackModels"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Typing debounce"
      description="Milliseconds to wait after typing before requesting a completion."
      explicit={has(["autocomplete", "debounceMs"])}
      defaultLabel={defaultLabel(["autocomplete", "debounceMs"])}
      onReset={() => reset(["autocomplete", "debounceMs"])}
    >
      <SettingsNumberInput value={number(["autocomplete", "debounceMs"])} min={100} max={2000} step={1} onChange={(value) => updateNumber(["autocomplete", "debounceMs"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Request timeout"
      description="Hard timeout in milliseconds for a completion request."
      explicit={has(["autocomplete", "timeoutMs"])}
      defaultLabel={defaultLabel(["autocomplete", "timeoutMs"])}
      onReset={() => reset(["autocomplete", "timeoutMs"])}
    >
      <SettingsNumberInput value={number(["autocomplete", "timeoutMs"])} min={250} max={10000} step={1} onChange={(value) => updateNumber(["autocomplete", "timeoutMs"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Completion tokens"
      description="Maximum output tokens for autocomplete."
      explicit={has(["autocomplete", "maxTokens"])}
      defaultLabel={defaultLabel(["autocomplete", "maxTokens"])}
      onReset={() => reset(["autocomplete", "maxTokens"])}
    >
      <SettingsNumberInput value={number(["autocomplete", "maxTokens"])} min={8} max={256} step={1} onChange={(value) => updateNumber(["autocomplete", "maxTokens"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Prompt token budget"
      description="Maximum input prompt tokens sent to autocomplete."
      explicit={has(["autocomplete", "maxPromptTokens"])}
      defaultLabel={defaultLabel(["autocomplete", "maxPromptTokens"])}
      onReset={() => reset(["autocomplete", "maxPromptTokens"])}
    >
      <SettingsNumberInput value={number(["autocomplete", "maxPromptTokens"])} min={256} max={16000} step={1} onChange={(value) => updateNumber(["autocomplete", "maxPromptTokens"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Recent messages"
      description="Conversation messages included as autocomplete context."
      explicit={has(["autocomplete", "includeRecentMessages"])}
      defaultLabel={defaultLabel(["autocomplete", "includeRecentMessages"])}
      onReset={() => reset(["autocomplete", "includeRecentMessages"])}
    >
      <SettingsNumberInput value={number(["autocomplete", "includeRecentMessages"])} min={0} max={20} step={1} onChange={(value) => updateNumber(["autocomplete", "includeRecentMessages"], value)} />
    </SettingsFieldRow>

    <SettingsFieldRow
      label="Session title model"
      description="Model used to generate compact session titles."
      explicit={has(["sessionTitle", "modelRef"])}
      defaultLabel={defaultLabel(["sessionTitle", "modelRef"])}
      onReset={() => reset(["sessionTitle", "modelRef"])}
    >
      <SettingsModelSelect value={text(["sessionTitle", "modelRef"])} {models} onChange={(value) => set(["sessionTitle", "modelRef"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Session title fallbacks"
      explicit={has(["sessionTitle", "fallbackModels"])}
      defaultLabel={defaultLabel(["sessionTitle", "fallbackModels"])}
      onReset={() => reset(["sessionTitle", "fallbackModels"])}
    >
      <SettingsModelList value={list(["sessionTitle", "fallbackModels"])} {models} addLabel="Add fallback" onChange={(value) => set(["sessionTitle", "fallbackModels"], value)} />
    </SettingsFieldRow>
  </div>
{:else if section === "voice"}
  <div class="px-2.5 py-2.5">
    <h2 class="text-sm font-semibold text-foreground">Voice</h2>
    <p class="mt-0.5 text-xs leading-4 text-muted-foreground">Deepgram credentials, language code, and speech model for Desktop dictation.</p>
  </div>
  <div class="border-y border-sidebar-border/70 bg-panel">
    <SettingsFieldRow
      label="Deepgram API key"
      description="Stored only in the Desktop user profile. Desktop exchanges this key for a short-lived browser token, so Deepgram requires Member or higher permission for /v1/auth/grant. DEEPGRAM_API_KEY remains an environment fallback."
      explicit={has(["dictation", "apiKey"])}
      defaultLabel={defaultLabel(["dictation", "apiKey"])}
      onReset={() => reset(["dictation", "apiKey"])}
    >
      <SettingsTextInput type="password" sensitive value={text(["dictation", "apiKey"])} placeholder="dg_…" onChange={(value) => set(["dictation", "apiKey"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Language"
      description="Deepgram language code sent directly to speech recognition, for example en, ru, uk, or de."
      explicit={has(["dictation", "language"])}
      defaultLabel={defaultLabel(["dictation", "language"])}
      onReset={() => reset(["dictation", "language"])}
    >
      <SettingsSelect value={text(["dictation", "language"])} options={LANGUAGE_OPTIONS} onChange={(value) => set(["dictation", "language"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Speech model"
      description="Deepgram speech-to-text model."
      explicit={has(["dictation", "model"])}
      defaultLabel={defaultLabel(["dictation", "model"])}
      onReset={() => reset(["dictation", "model"])}
    >
      <SettingsSelect value={text(["dictation", "model"])} options={SPEECH_MODEL_OPTIONS} onChange={(value) => set(["dictation", "model"], value)} />
    </SettingsFieldRow>
  </div>
{:else if section === "editor"}
  <div class="px-2.5 py-2.5">
    <h2 class="text-sm font-semibold text-foreground">Editor</h2>
    <p class="mt-0.5 text-xs leading-4 text-muted-foreground">External tools launched from the Desktop project explorer.</p>
  </div>
  <div class="border-y border-sidebar-border/70 bg-panel">
    <SettingsFieldRow
      label="External editor"
      description="Application used by Open in External Editor. Custom executable names remain available in Advanced JSONC."
      explicit={has(["desktop", "externalEditor"])}
      defaultLabel={defaultLabel(["desktop", "externalEditor"])}
      onReset={() => reset(["desktop", "externalEditor"])}
    >
      <SettingsSelect value={text(["desktop", "externalEditor"])} options={EDITOR_OPTIONS} onChange={(value) => set(["desktop", "externalEditor"], value)} />
    </SettingsFieldRow>
  </div>
{:else if section === "source-control"}
  <div class="px-2.5 py-2.5">
    <h2 class="text-sm font-semibold text-foreground">Source Control</h2>
    <p class="mt-0.5 text-xs leading-4 text-muted-foreground">LLM preferences used by Desktop Git review and commit-message actions.</p>
  </div>
  <div class="border-y border-sidebar-border/70 bg-panel">
    <SettingsFieldRow
      label="Review model"
      description="Model and thinking level used for Source Control diff review."
      explicit={has(["desktop", "git", "reviewModelRef"])}
      defaultLabel={defaultLabel(["desktop", "git", "reviewModelRef"])}
      onReset={() => reset(["desktop", "git", "reviewModelRef"])}
    >
      <SettingsModelSelect value={text(["desktop", "git", "reviewModelRef"])} options={gitModelOptions} ariaLabel="Review model" onChange={(value) => set(["desktop", "git", "reviewModelRef"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Review fallbacks"
      explicit={has(["desktop", "git", "reviewFallbackModels"])}
      defaultLabel={defaultLabel(["desktop", "git", "reviewFallbackModels"])}
      onReset={() => reset(["desktop", "git", "reviewFallbackModels"])}
    >
      <SettingsModelList value={list(["desktop", "git", "reviewFallbackModels"])} {models} addLabel="Add fallback" onChange={(value) => set(["desktop", "git", "reviewFallbackModels"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Commit message model"
      description="Model and thinking level used to generate Git commit messages."
      explicit={has(["desktop", "git", "commitMessageModelRef"])}
      defaultLabel={defaultLabel(["desktop", "git", "commitMessageModelRef"])}
      onReset={() => reset(["desktop", "git", "commitMessageModelRef"])}
    >
      <SettingsModelSelect value={text(["desktop", "git", "commitMessageModelRef"])} options={gitModelOptions} ariaLabel="Commit message model" onChange={(value) => set(["desktop", "git", "commitMessageModelRef"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Commit message fallbacks"
      explicit={has(["desktop", "git", "commitMessageFallbackModels"])}
      defaultLabel={defaultLabel(["desktop", "git", "commitMessageFallbackModels"])}
      onReset={() => reset(["desktop", "git", "commitMessageFallbackModels"])}
    >
      <SettingsModelList value={list(["desktop", "git", "commitMessageFallbackModels"])} {models} addLabel="Add fallback" onChange={(value) => set(["desktop", "git", "commitMessageFallbackModels"], value)} />
    </SettingsFieldRow>
  </div>
{/if}
