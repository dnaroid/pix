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
  import { EXTERNAL_EDITOR_OPTIONS } from "../../lib/desktop-config";
  import type { ModelThinkingModel } from "../../lib/model-thinking";
  import SettingsFieldRow from "./SettingsFieldRow.svelte";
  import SettingsKnowledgeJudge from "./SettingsKnowledgeJudge.svelte";
  import SettingsModelSummary from "./SettingsModelSummary.svelte";
  import SettingsModelRoutingTiers, { type ModelRoutingTierDraft } from "./SettingsModelRoutingTiers.svelte";
  import SettingsModelVisibility from "./SettingsModelVisibility.svelte";
  import SettingsNumberInput from "./SettingsNumberInput.svelte";
  import SettingsObserver from "./SettingsObserver.svelte";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SettingsSwitch from "./SettingsSwitch.svelte";
  import SettingsTextInput from "./SettingsTextInput.svelte";

  export type DesktopSettingsSection = "general" | "models" | "assistant" | "observer" | "voice" | "editor" | "source-control";

  const THINKING_OPTIONS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
    .map((value) => ({ value, label: value === "xhigh" ? "Extra high" : value[0]!.toUpperCase() + value.slice(1) }));
  const THEME_OPTIONS = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
  const WIZARD_TIERS = ["simple", "standard", "complex", "expert"];
  const REPORT_LANGUAGE_OPTIONS = [
    { value: "", label: "Use Tools Suite setting" },
    { value: "en", label: "English (en)" },
    { value: "ru", label: "Русский (ru)" },
  ];
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
    { value: "", label: "Choose an editor…" },
    ...EXTERNAL_EDITOR_OPTIONS,
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
      label="Theme"
      description="Follow the macOS appearance or force a light or dark theme for all Pix windows. Applies after saving."
      explicit={has(["desktop", "theme"])}
      defaultLabel={defaultLabel(["desktop", "theme"])}
      onReset={() => reset(["desktop", "theme"])}
    >
      <SettingsSelect
        value={text(["desktop", "theme"]) || "system"}
        options={THEME_OPTIONS}
        ariaLabel="Theme"
        onChange={(value) => set(["desktop", "theme"], value)}
      />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Logs panel"
      description="Show Logs in the sidebar to browse and monitor shared diagnostics. Off by default; does not change log collection. Applies after saving."
      explicit={has(["desktop", "logPanelEnabled"])}
      defaultLabel={defaultLabel(["desktop", "logPanelEnabled"])}
      onReset={() => reset(["desktop", "logPanelEnabled"])}
    >
      <SettingsSwitch value={bool(["desktop", "logPanelEnabled"])} onChange={(value) => set(["desktop", "logPanelEnabled"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Show menu bar icon"
      description="Add the Pix icon to the macOS menu bar while keeping the Dock icon and application menus. Left-click to show all windows; right-click for the window list. Applies to all windows after restarting Pix."
      explicit={has(["desktop", "trayOnly"])}
      defaultLabel={defaultLabel(["desktop", "trayOnly"])}
      onReset={() => reset(["desktop", "trayOnly"])}
    >
      <SettingsSwitch value={bool(["desktop", "trayOnly"])} onChange={(value) => set(["desktop", "trayOnly"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Ignore context files"
      description="Do not discover AGENTS.md or CLAUDE.md for Desktop sessions. Project Desktop config can override this value."
      explicit={has(["ignoreContextFiles"])}
      defaultLabel={defaultLabel(["ignoreContextFiles"])}
      onReset={() => reset(["ignoreContextFiles"])}
    >
      <SettingsSwitch value={bool(["ignoreContextFiles"])} onChange={(value) => set(["ignoreContextFiles"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Notifications"
      description="Notify about completed work, questions, pauses, and errors in the background. Project Desktop config can override this value."
      explicit={has(["desktop", "notifications", "enabled"])}
      defaultLabel={defaultLabel(["desktop", "notifications", "enabled"])}
      onReset={() => reset(["desktop", "notifications", "enabled"])}
    >
      <SettingsSwitch
        value={bool(["desktop", "notifications", "enabled"])}
        onChange={(value) => set(["desktop", "notifications", "enabled"], value)}
      />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Sound only (no popups)"
      description="Play a short sound instead of showing in-app alerts or macOS notifications. Works when Pix is in the background. Applies after saving."
      explicit={has(["desktop", "notifications", "usePix"])}
      defaultLabel={defaultLabel(["desktop", "notifications", "usePix"])}
      onReset={() => reset(["desktop", "notifications", "usePix"])}
    >
      <SettingsSwitch
        value={bool(["desktop", "notifications", "usePix"])}
        onChange={(value) => set(["desktop", "notifications", "usePix"], value)}
      />
    </SettingsFieldRow>
  </div>
{:else if section === "models"}
  <div class="px-2.5 py-2.5">
    <h2 class="text-sm font-semibold text-foreground">Models</h2>
    <p class="mt-0.5 text-xs leading-4 text-muted-foreground">Defaults for new sessions plus the model list exposed by Desktop.</p>
  </div>
  <div class="border-y border-sidebar-border/70 bg-panel">
    <SettingsFieldRow
      label="Default & router models"
      description="Default model for new sessions and the Auto router. Managed by the model setup wizard."
    >
      <SettingsModelSummary {models} rows={[
        { label: "Default", ref: text(["defaultModel", "modelRef"]), thinking: text(["defaultModel", "thinking"]), fallbacks: list(["defaultModel", "fallbackModels"]) },
        { label: "Router", ref: text(["modelRouting", "modelRef"]), fallbacks: list(["modelRouting", "fallbackModels"]) },
      ]} />
    </SettingsFieldRow>

    <SettingsFieldRow
      label="Automatic model routing"
      description="Expose Auto in draft and live-session pickers; a live selection opens a new draft, whose first real prompt routes to a semantic task tier before session creation."
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
      description="Semantic task classes available to the router. The simple, standard, complex and expert tiers take their model and thinking level from the model setup wizard; custom tiers are edited here."
      explicit={has(["modelRouting", "tiers"])}
      defaultLabel={defaultLabel(["modelRouting", "tiers"])}
      onReset={() => reset(["modelRouting", "tiers"])}
    >
      <SettingsModelRoutingTiers
        value={routingTiers}
        {models}
        managedIds={WIZARD_TIERS}
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
    <p class="mt-0.5 text-xs leading-4 text-muted-foreground">Models and limits used by knowledge review, prompt enhancement, autocomplete, explain/translate, and automatic session titles.</p>
  </div>
  <div class="border-y border-sidebar-border/70 bg-panel">
    <SettingsFieldRow
      label="Feature models"
      description="Models used by search answers, prompt enhancement, autocomplete, session titles and the search/task classifier. Managed by the model setup wizard."
    >
      <SettingsModelSummary {models} rows={[
        { label: "Search answers (RAG)", ref: text(["search", "ragModelRef"]), emptyLabel: "Default Desktop model" },
        { label: "Prompt enhancer", ref: text(["promptEnhancer", "modelRef"]), fallbacks: list(["promptEnhancer", "fallbackModels"]) },
        { label: "Autocomplete", ref: text(["autocomplete", "modelRef"]), fallbacks: list(["autocomplete", "fallbackModels"]), emptyLabel: "Disabled" },
        { label: "Explain & translate", ref: text(["selectionAssist", "modelRef"]), fallbacks: list(["selectionAssist", "fallbackModels"]), emptyLabel: "Autocomplete model" },
        { label: "Session titles", ref: text(["sessionTitle", "modelRef"]), fallbacks: list(["sessionTitle", "fallbackModels"]) },
        { label: "Search & task classifier", ref: text(["search", "intentModelRef"]), emptyLabel: "Built-in default" },
      ]} />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="Explain & translate language"
      description="Language for Explain Code answers in Preview and the target of Translate in chat, for example ru or en."
      explicit={has(["selectionAssist", "language"])}
      defaultLabel={defaultLabel(["selectionAssist", "language"])}
      onReset={() => reset(["selectionAssist", "language"])}
    >
      <SettingsTextInput value={text(["selectionAssist", "language"])} placeholder="ru" onChange={(value) => set(["selectionAssist", "language"], value)} />
    </SettingsFieldRow>
    <SettingsKnowledgeJudge {source} {models} desktop />
    <SettingsFieldRow
      label="Contradiction report language"
      description="Language for Wiki contradiction reports. Inherit the Tools Suite setting or choose an override. Source quotations remain unchanged."
      explicit={has(["knowledgeCheck", "reportLanguage"])}
      defaultLabel="Tools Suite setting (English when unset)"
      onReset={() => reset(["knowledgeCheck", "reportLanguage"])}
    >
      <SettingsSelect
        value={text(["knowledgeCheck", "reportLanguage"])}
        options={REPORT_LANGUAGE_OPTIONS}
        ariaLabel="Contradiction report language"
        onChange={(value) => set(["knowledgeCheck", "reportLanguage"], value)}
      />
    </SettingsFieldRow>
    <SettingsFieldRow
      label="RAG thinking effort"
      description="Reasoning budget for RAG answer generation. Choose a level supported by the selected model; Off disables explicit reasoning."
      explicit={has(["search", "ragThinking"])}
      defaultLabel="Medium"
      onReset={() => reset(["search", "ragThinking"])}
    >
      <SettingsSelect
        value={text(["search", "ragThinking"]) || "medium"}
        options={models.find(model => model.ref === text(["search", "ragModelRef"]))
          ? THINKING_OPTIONS.filter(option => models.find(model => model.ref === text(["search", "ragModelRef"]))!.thinkingLevels.includes(option.value))
          : THINKING_OPTIONS}
        ariaLabel="RAG thinking effort"
        onChange={(value) => set(["search", "ragThinking"], value)}
      />
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

  </div>
{:else if section === "observer"}
  <SettingsObserver {source} {schema} {models} onChange={onChange} />
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
      label="File editor"
      description="Application used by Project and Preview “Open in External Editor” actions. Custom executable names remain available in Advanced JSONC."
      explicit={has(["desktop", "externalEditor"])}
      defaultLabel="No editor selected"
      onReset={() => reset(["desktop", "externalEditor"])}
    >
      <SettingsSelect
        value={text(["desktop", "externalEditor"])}
        options={EDITOR_OPTIONS}
        onChange={(value) => value ? set(["desktop", "externalEditor"], value) : reset(["desktop", "externalEditor"])}
      />
    </SettingsFieldRow>
  </div>
{:else if section === "source-control"}
  <div class="px-2.5 py-2.5">
    <h2 class="text-sm font-semibold text-foreground">Source Control</h2>
    <p class="mt-0.5 text-xs leading-4 text-muted-foreground">LLM preferences used by Desktop Git review, commit-message, and CI repair actions.</p>
  </div>
  <div class="border-y border-sidebar-border/70 bg-panel">
    <SettingsFieldRow
      label="Git models"
      description="Models used by Fix with AI, diff review and commit messages. Managed by the model setup wizard."
    >
      <SettingsModelSummary {models} rows={[
        { label: "CI fix", ref: text(["desktop", "git", "ciFixModelRef"]), emptyLabel: "Default model" },
        { label: "Review", ref: text(["desktop", "git", "reviewModelRef"]), fallbacks: list(["desktop", "git", "reviewFallbackModels"]) },
        { label: "Commit messages", ref: text(["desktop", "git", "commitMessageModelRef"]), fallbacks: list(["desktop", "git", "commitMessageFallbackModels"]) },
      ]} />
    </SettingsFieldRow>
  </div>
{/if}
