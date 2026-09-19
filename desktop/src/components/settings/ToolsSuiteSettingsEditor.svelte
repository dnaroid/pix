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
  import SettingsJsonValue from "./SettingsJsonValue.svelte";
  import SettingsModelList from "./SettingsModelList.svelte";
  import SettingsModelSelect from "./SettingsModelSelect.svelte";
  import SettingsNumberInput from "./SettingsNumberInput.svelte";
  import SettingsSelect from "./SettingsSelect.svelte";
  import SettingsStringList from "./SettingsStringList.svelte";
  import SettingsSwitch from "./SettingsSwitch.svelte";
  import SettingsTextInput from "./SettingsTextInput.svelte";

  export type ToolsSuiteSettingsSection = "general" | "automation" | "dcp" | "context" | "integrations";

  const THINKING_STRICTNESS = [
    { value: "conservative", label: "Conservative" },
    { value: "balanced", label: "Balanced" },
    { value: "aggressive", label: "Aggressive" },
  ];
  const NUDGE_FORCE = [
    { value: "soft", label: "Soft" },
    { value: "strong", label: "Strong" },
  ];
  const CONTEXT_GATEWAY_MODE = [
    { value: "off", label: "Off" },
    { value: "observe", label: "Observe" },
    { value: "enforce", label: "Enforce" },
  ];
  const REPO_DISCOVERY_PROFILE = [
    { value: "baseline", label: "Baseline" },
    { value: "native-compact", label: "Native compact" },
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
    section: ToolsSuiteSettingsSection;
    onChange: (source: string) => void;
  } = $props();

  const parsed = $derived(parseSettingsSource(source).value);

  function has(path: readonly string[]): boolean {
    return settingsHasValue(parsed, path);
  }

  function effective(path: readonly string[]): unknown {
    if (has(path)) return settingsValue(parsed, path);
    return settingsDefaultValue("pi-tools-suite", schema, path).value;
  }

  function defaultLabel(path: readonly string[]): string {
    const fallback = settingsDefaultValue("pi-tools-suite", schema, path);
    return fallback.exists ? `Default · ${formatSettingsDefaultValue(fallback.value)}` : "Unset when omitted";
  }

  function set(path: readonly string[], value: unknown): void {
    onChange(updateSettingsSource(source, path, value));
  }

  function reset(path: readonly string[]): void {
    onChange(removeSettingsValue(source, path));
  }

  function resetMany(paths: readonly (readonly string[])[]): void {
    let next = source;
    for (const path of paths) next = removeSettingsValue(next, path);
    onChange(next);
  }

  function text(path: readonly string[]): string {
    const value = effective(path);
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
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

  function json(path: readonly string[]): unknown {
    return effective(path);
  }

  function updateNumber(path: readonly string[], value: number | undefined): void {
    if (value === undefined) reset(path);
    else set(path, value);
  }

  function updateJson(path: readonly string[], value: unknown): void {
    if (value === undefined) reset(path);
    else set(path, value);
  }

  function updateLooseScalar(path: readonly string[], raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) {
      reset(path);
      return;
    }
    if (/^-?(?:\d+\.?\d*|\.\d+)$/u.test(trimmed)) set(path, Number(trimmed));
    else set(path, raw);
  }

  function updateChatId(raw: string): void {
    const trimmed = raw.trim();
    if (!trimmed) {
      reset(["telegramConnector", "chatId"]);
      return;
    }
    set(["telegramConnector", "chatId"], /^-?\d+$/u.test(trimmed) ? Number(trimmed) : raw);
  }
</script>

{#if section === "general"}
  <div class="px-2.5 py-2.5">
    <h2 class="text-sm font-semibold text-foreground">General</h2>
    <p class="mt-0.5 text-xs leading-4 text-muted-foreground">Suite-wide module switches and safety helpers.</p>
  </div>
  <div class="border-y border-sidebar-border/70 bg-panel">
    <SettingsFieldRow label="Tools Suite" description="Enable or disable the complete pi-tools-suite extension." explicit={has(["enabled"])} defaultLabel={defaultLabel(["enabled"])} onReset={() => reset(["enabled"])}>
      <SettingsSwitch value={bool(["enabled"])} onChange={(value) => set(["enabled"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Enabled modules" description="Modules explicitly enabled even when their normal default is off." explicit={has(["enabledModules"])} defaultLabel={defaultLabel(["enabledModules"])} onReset={() => reset(["enabledModules"])}>
      <SettingsStringList value={list(["enabledModules"])} placeholder="module-name" addLabel="Add module" onChange={(value) => set(["enabledModules"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Disabled modules" description="Modules explicitly disabled for this user profile." explicit={has(["disabledModules"])} defaultLabel={defaultLabel(["disabledModules"])} onReset={() => reset(["disabledModules"])}>
      <SettingsStringList value={list(["disabledModules"])} placeholder="module-name" addLabel="Add module" onChange={(value) => set(["disabledModules"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Module overrides" description="Per-module enable/disable map for modules with explicit local policy." explicit={has(["modules"])} defaultLabel={defaultLabel(["modules"])} onReset={() => reset(["modules"])}>
      <SettingsJsonValue value={json(["modules"])} rows={5} placeholder={'{\n  "credential-firewall": true\n}'} onChange={(value) => updateJson(["modules"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Comment checker" description="Warn when newly added comments look like low-value generated commentary." explicit={has(["commentChecker", "enabled"])} defaultLabel={defaultLabel(["commentChecker", "enabled"])} onReset={() => reset(["commentChecker", "enabled"])}>
      <SettingsSwitch value={bool(["commentChecker", "enabled"])} onChange={(value) => set(["commentChecker", "enabled"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Comment strictness" explicit={has(["commentChecker", "strictness"])} defaultLabel={defaultLabel(["commentChecker", "strictness"])} onReset={() => reset(["commentChecker", "strictness"])}>
      <SettingsSelect value={text(["commentChecker", "strictness"])} options={THINKING_STRICTNESS} onChange={(value) => set(["commentChecker", "strictness"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Secret session hygiene" description="Redact detected secret material before it remains in session history." explicit={has(["secretFirewall", "sessionHygiene"])} defaultLabel={defaultLabel(["secretFirewall", "sessionHygiene"])} onReset={() => reset(["secretFirewall", "sessionHygiene"])}>
      <SettingsSwitch value={bool(["secretFirewall", "sessionHygiene"])} onChange={(value) => set(["secretFirewall", "sessionHygiene"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Secret redaction notifications" description="Show a warning when secret material is redacted." explicit={has(["secretFirewall", "notify"])} defaultLabel={defaultLabel(["secretFirewall", "notify"])} onReset={() => reset(["secretFirewall", "notify"])}>
      <SettingsSwitch value={bool(["secretFirewall", "notify"])} onChange={(value) => set(["secretFirewall", "notify"], value)} />
    </SettingsFieldRow>
  </div>
{:else if section === "automation"}
  <div class="px-2.5 py-2.5">
    <h2 class="text-sm font-semibold text-foreground">Automation</h2>
    <p class="mt-0.5 text-xs leading-4 text-muted-foreground">Todo thinking and helper-model behavior used by coding workflows.</p>
  </div>
  <div class="border-y border-sidebar-border/70 bg-panel">
    <SettingsFieldRow label="Todo thinking" description="Allow todo items to switch and restore model thinking levels as work moves in progress." explicit={has(["todoThinking"])} defaultLabel={defaultLabel(["todoThinking"])} onReset={() => reset(["todoThinking"])}>
      <SettingsSwitch value={bool(["todoThinking"])} onChange={(value) => set(["todoThinking"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Todo thinking overrides" description="Per-model thinking policy. Keys can be provider/model names or wildcard patterns; null removes an inherited override." explicit={has(["todoThinkingOverrides"])} defaultLabel={defaultLabel(["todoThinkingOverrides"])} onReset={() => reset(["todoThinkingOverrides"])}>
      <SettingsJsonValue value={json(["todoThinkingOverrides"])} rows={6} placeholder={'{\n  "provider/model": "high"\n}'} onChange={(value) => updateJson(["todoThinkingOverrides"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Lookup model" description="Vision-capable helper model used by image lookup. Use Disable to store null explicitly." explicit={has(["lookupModel"])} defaultLabel={defaultLabel(["lookupModel"])} onReset={() => reset(["lookupModel"])}>
      <SettingsModelSelect value={text(["lookupModel"])} {models} emptyLabel="Disabled" onChange={(value) => value ? set(["lookupModel"], value) : set(["lookupModel"], null)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Lookup fallbacks" explicit={has(["lookupFallbackModels"])} defaultLabel={defaultLabel(["lookupFallbackModels"])} onReset={() => reset(["lookupFallbackModels"])}>
      <SettingsModelList value={list(["lookupFallbackModels"])} {models} addLabel="Add fallback" onChange={(value) => set(["lookupFallbackModels"], value)} />
    </SettingsFieldRow>
  </div>
{:else if section === "dcp"}
  <div class="px-2.5 py-2.5">
    <h2 class="text-sm font-semibold text-foreground">Dynamic Context Pruning</h2>
    <p class="mt-0.5 text-xs leading-4 text-muted-foreground">Compression thresholds, automatic summaries, emergency cleanup, and model-specific policy.</p>
  </div>
  <div class="border-y border-sidebar-border/70 bg-panel">
    <SettingsFieldRow label="DCP" description="Enable Dynamic Context Pruning." explicit={has(["dcp", "enabled"])} defaultLabel={defaultLabel(["dcp", "enabled"])} onReset={() => reset(["dcp", "enabled"])}>
      <SettingsSwitch value={bool(["dcp", "enabled"])} onChange={(value) => set(["dcp", "enabled"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Debug logging" description="Write DCP context/prune/compress events to the rotating JSONL debug log." explicit={has(["dcp", "debug"])} defaultLabel={defaultLabel(["dcp", "debug"])} onReset={() => reset(["dcp", "debug"])}>
      <SettingsSwitch value={bool(["dcp", "debug"])} onChange={(value) => set(["dcp", "debug"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Debug log max bytes" explicit={has(["dcp", "debugLog", "maxBytes"])} defaultLabel={defaultLabel(["dcp", "debugLog", "maxBytes"])} onReset={() => reset(["dcp", "debugLog", "maxBytes"])}>
      <SettingsNumberInput value={number(["dcp", "debugLog", "maxBytes"])} min={1024} step={1} onChange={(value) => updateNumber(["dcp", "debugLog", "maxBytes"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Debug log backups" explicit={has(["dcp", "debugLog", "maxBackups"])} defaultLabel={defaultLabel(["dcp", "debugLog", "maxBackups"])} onReset={() => reset(["dcp", "debugLog", "maxBackups"])}>
      <SettingsNumberInput value={number(["dcp", "debugLog", "maxBackups"])} min={1} step={1} onChange={(value) => updateNumber(["dcp", "debugLog", "maxBackups"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Manual mode" description="Enable explicit/manual DCP mode." explicit={has(["dcp", "manualMode", "enabled"])} defaultLabel={defaultLabel(["dcp", "manualMode", "enabled"])} onReset={() => reset(["dcp", "manualMode", "enabled"])}>
      <SettingsSwitch value={bool(["dcp", "manualMode", "enabled"])} onChange={(value) => set(["dcp", "manualMode", "enabled"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Minimum context" description="Target context after compression. Accepts a fraction, token count, or percent string such as 20%." explicit={has(["dcp", "compress", "minContextPercent"])} defaultLabel={defaultLabel(["dcp", "compress", "minContextPercent"])} onReset={() => reset(["dcp", "compress", "minContextPercent"])}>
      <SettingsTextInput value={text(["dcp", "compress", "minContextPercent"])} placeholder="20%" onChange={(value) => updateLooseScalar(["dcp", "compress", "minContextPercent"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Maximum context" description="Context pressure threshold before compression is considered. Accepts a fraction, token count, or percent string." explicit={has(["dcp", "compress", "maxContextPercent"])} defaultLabel={defaultLabel(["dcp", "compress", "maxContextPercent"])} onReset={() => reset(["dcp", "compress", "maxContextPercent"])}>
      <SettingsTextInput value={text(["dcp", "compress", "maxContextPercent"])} placeholder="55%" onChange={(value) => updateLooseScalar(["dcp", "compress", "maxContextPercent"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Absolute minimum context" description="Optional absolute target context token limit; compact strings such as 80k are accepted." explicit={has(["dcp", "compress", "minContextLimit"])} defaultLabel={defaultLabel(["dcp", "compress", "minContextLimit"])} onReset={() => reset(["dcp", "compress", "minContextLimit"])}>
      <SettingsTextInput value={text(["dcp", "compress", "minContextLimit"])} placeholder="80k" onChange={(value) => updateLooseScalar(["dcp", "compress", "minContextLimit"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Absolute maximum context" description="Optional absolute context pressure limit; compact strings such as 200k are accepted." explicit={has(["dcp", "compress", "maxContextLimit"])} defaultLabel={defaultLabel(["dcp", "compress", "maxContextLimit"])} onReset={() => reset(["dcp", "compress", "maxContextLimit"])}>
      <SettingsTextInput value={text(["dcp", "compress", "maxContextLimit"])} placeholder="200k" onChange={(value) => updateLooseScalar(["dcp", "compress", "maxContextLimit"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Per-model context percentages" description="Optional per-model minimum/maximum context overrides. Keys are model refs; values accept the same numeric or percent formats as the global thresholds." explicit={has(["dcp", "compress", "modelMinContextPercent"]) || has(["dcp", "compress", "modelMaxContextPercent"])} defaultLabel="Unset when omitted" onReset={() => resetMany([["dcp", "compress", "modelMinContextPercent"], ["dcp", "compress", "modelMaxContextPercent"]])}>
      <div class="space-y-2">
        <div>
          <div class="mb-1 text-xs font-medium text-muted-foreground">Minimum by model</div>
          <SettingsJsonValue value={json(["dcp", "compress", "modelMinContextPercent"])} rows={5} placeholder={'{\n  "provider/model": "20%"\n}'} onChange={(value) => updateJson(["dcp", "compress", "modelMinContextPercent"], value)} />
        </div>
        <div>
          <div class="mb-1 text-xs font-medium text-muted-foreground">Maximum by model</div>
          <SettingsJsonValue value={json(["dcp", "compress", "modelMaxContextPercent"])} rows={5} placeholder={'{\n  "provider/model": "55%"\n}'} onChange={(value) => updateJson(["dcp", "compress", "modelMaxContextPercent"], value)} />
        </div>
      </div>
    </SettingsFieldRow>
    <SettingsFieldRow label="Per-model context limits" description="Optional absolute token limits by model." explicit={has(["dcp", "compress", "modelMinContextLimits"]) || has(["dcp", "compress", "modelMaxContextLimits"])} defaultLabel="Unset when omitted" onReset={() => resetMany([["dcp", "compress", "modelMinContextLimits"], ["dcp", "compress", "modelMaxContextLimits"]])}>
      <div class="space-y-2">
        <div>
          <div class="mb-1 text-xs font-medium text-muted-foreground">Minimum limits by model</div>
          <SettingsJsonValue value={json(["dcp", "compress", "modelMinContextLimits"])} rows={5} placeholder={'{\n  "provider/model": "80k"\n}'} onChange={(value) => updateJson(["dcp", "compress", "modelMinContextLimits"], value)} />
        </div>
        <div>
          <div class="mb-1 text-xs font-medium text-muted-foreground">Maximum limits by model</div>
          <SettingsJsonValue value={json(["dcp", "compress", "modelMaxContextLimits"])} rows={5} placeholder={'{\n  "provider/model": "200k"\n}'} onChange={(value) => updateJson(["dcp", "compress", "modelMaxContextLimits"], value)} />
        </div>
      </div>
    </SettingsFieldRow>
    <SettingsFieldRow label="Summary buffer" explicit={has(["dcp", "compress", "summaryBuffer"])} defaultLabel={defaultLabel(["dcp", "compress", "summaryBuffer"])} onReset={() => reset(["dcp", "compress", "summaryBuffer"])}>
      <SettingsSwitch value={bool(["dcp", "compress", "summaryBuffer"])} onChange={(value) => set(["dcp", "compress", "summaryBuffer"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Nudge frequency" description="Inject a compression nudge every N context events." explicit={has(["dcp", "compress", "nudgeFrequency"])} defaultLabel={defaultLabel(["dcp", "compress", "nudgeFrequency"])} onReset={() => reset(["dcp", "compress", "nudgeFrequency"])}>
      <SettingsNumberInput value={number(["dcp", "compress", "nudgeFrequency"])} min={1} step={1} onChange={(value) => updateNumber(["dcp", "compress", "nudgeFrequency"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Iteration nudge threshold" description="Tool calls since the last user message before nudging." explicit={has(["dcp", "compress", "iterationNudgeThreshold"])} defaultLabel={defaultLabel(["dcp", "compress", "iterationNudgeThreshold"])} onReset={() => reset(["dcp", "compress", "iterationNudgeThreshold"])}>
      <SettingsNumberInput value={number(["dcp", "compress", "iterationNudgeThreshold"])} min={1} step={1} onChange={(value) => updateNumber(["dcp", "compress", "iterationNudgeThreshold"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Nudge force" explicit={has(["dcp", "compress", "nudgeForce"])} defaultLabel={defaultLabel(["dcp", "compress", "nudgeForce"])} onReset={() => reset(["dcp", "compress", "nudgeForce"])}>
      <SettingsSelect value={text(["dcp", "compress", "nudgeForce"])} options={NUDGE_FORCE} onChange={(value) => set(["dcp", "compress", "nudgeForce"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Protected tools" description="Tool outputs protected from DCP compression/pruning." explicit={has(["dcp", "compress", "protectedTools"])} defaultLabel={defaultLabel(["dcp", "compress", "protectedTools"])} onReset={() => reset(["dcp", "compress", "protectedTools"])}>
      <SettingsStringList value={list(["dcp", "compress", "protectedTools"])} placeholder="tool-name" addLabel="Protect tool" onChange={(value) => set(["dcp", "compress", "protectedTools"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Protect tagged content" explicit={has(["dcp", "compress", "protectTags"])} defaultLabel={defaultLabel(["dcp", "compress", "protectTags"])} onReset={() => reset(["dcp", "compress", "protectTags"])}>
      <SettingsSwitch value={bool(["dcp", "compress", "protectTags"])} onChange={(value) => set(["dcp", "compress", "protectTags"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Protect user messages" explicit={has(["dcp", "compress", "protectUserMessages"])} defaultLabel={defaultLabel(["dcp", "compress", "protectUserMessages"])} onReset={() => reset(["dcp", "compress", "protectUserMessages"])}>
      <SettingsSwitch value={bool(["dcp", "compress", "protectUserMessages"])} onChange={(value) => set(["dcp", "compress", "protectUserMessages"], value)} />
    </SettingsFieldRow>

    <SettingsFieldRow label="Auto candidates" description="Enable automatic compression-candidate selection." explicit={has(["dcp", "compress", "autoCandidates", "enabled"])} defaultLabel={defaultLabel(["dcp", "compress", "autoCandidates", "enabled"])} onReset={() => reset(["dcp", "compress", "autoCandidates", "enabled"])}>
      <SettingsSwitch value={bool(["dcp", "compress", "autoCandidates", "enabled"])} onChange={(value) => set(["dcp", "compress", "autoCandidates", "enabled"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Auto-candidate context threshold" explicit={has(["dcp", "compress", "autoCandidates", "minContextPercent"])} defaultLabel={defaultLabel(["dcp", "compress", "autoCandidates", "minContextPercent"])} onReset={() => reset(["dcp", "compress", "autoCandidates", "minContextPercent"])}>
      <SettingsNumberInput value={number(["dcp", "compress", "autoCandidates", "minContextPercent"])} min={0} max={1} step={0.01} onChange={(value) => updateNumber(["dcp", "compress", "autoCandidates", "minContextPercent"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Auto-candidate recent turns" explicit={has(["dcp", "compress", "autoCandidates", "keepRecentTurns"])} defaultLabel={defaultLabel(["dcp", "compress", "autoCandidates", "keepRecentTurns"])} onReset={() => reset(["dcp", "compress", "autoCandidates", "keepRecentTurns"])}>
      <SettingsNumberInput value={number(["dcp", "compress", "autoCandidates", "keepRecentTurns"])} min={0} step={1} onChange={(value) => updateNumber(["dcp", "compress", "autoCandidates", "keepRecentTurns"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Auto-candidate minimum messages" explicit={has(["dcp", "compress", "autoCandidates", "minMessages"])} defaultLabel={defaultLabel(["dcp", "compress", "autoCandidates", "minMessages"])} onReset={() => reset(["dcp", "compress", "autoCandidates", "minMessages"])}>
      <SettingsNumberInput value={number(["dcp", "compress", "autoCandidates", "minMessages"])} min={0} step={1} onChange={(value) => updateNumber(["dcp", "compress", "autoCandidates", "minMessages"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Auto-candidate minimum tokens" explicit={has(["dcp", "compress", "autoCandidates", "minTokens"])} defaultLabel={defaultLabel(["dcp", "compress", "autoCandidates", "minTokens"])} onReset={() => reset(["dcp", "compress", "autoCandidates", "minTokens"])}>
      <SettingsNumberInput value={number(["dcp", "compress", "autoCandidates", "minTokens"])} min={0} step={1} onChange={(value) => updateNumber(["dcp", "compress", "autoCandidates", "minTokens"], value)} />
    </SettingsFieldRow>

    <SettingsFieldRow label="Message mode" description="Enable message-mode compression suggestions." explicit={has(["dcp", "compress", "messageMode", "enabled"])} defaultLabel={defaultLabel(["dcp", "compress", "messageMode", "enabled"])} onReset={() => reset(["dcp", "compress", "messageMode", "enabled"])}>
      <SettingsSwitch value={bool(["dcp", "compress", "messageMode", "enabled"])} onChange={(value) => set(["dcp", "compress", "messageMode", "enabled"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Message-mode context threshold" explicit={has(["dcp", "compress", "messageMode", "minContextPercent"])} defaultLabel={defaultLabel(["dcp", "compress", "messageMode", "minContextPercent"])} onReset={() => reset(["dcp", "compress", "messageMode", "minContextPercent"])}>
      <SettingsNumberInput value={number(["dcp", "compress", "messageMode", "minContextPercent"])} min={0} max={1} step={0.01} onChange={(value) => updateNumber(["dcp", "compress", "messageMode", "minContextPercent"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Message-mode recent turns" explicit={has(["dcp", "compress", "messageMode", "keepRecentTurns"])} defaultLabel={defaultLabel(["dcp", "compress", "messageMode", "keepRecentTurns"])} onReset={() => reset(["dcp", "compress", "messageMode", "keepRecentTurns"])}>
      <SettingsNumberInput value={number(["dcp", "compress", "messageMode", "keepRecentTurns"])} min={0} step={1} onChange={(value) => updateNumber(["dcp", "compress", "messageMode", "keepRecentTurns"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Message-mode medium tokens" explicit={has(["dcp", "compress", "messageMode", "mediumTokens"])} defaultLabel={defaultLabel(["dcp", "compress", "messageMode", "mediumTokens"])} onReset={() => reset(["dcp", "compress", "messageMode", "mediumTokens"])}>
      <SettingsNumberInput value={number(["dcp", "compress", "messageMode", "mediumTokens"])} min={0} step={1} onChange={(value) => updateNumber(["dcp", "compress", "messageMode", "mediumTokens"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Message-mode high tokens" explicit={has(["dcp", "compress", "messageMode", "highTokens"])} defaultLabel={defaultLabel(["dcp", "compress", "messageMode", "highTokens"])} onReset={() => reset(["dcp", "compress", "messageMode", "highTokens"])}>
      <SettingsNumberInput value={number(["dcp", "compress", "messageMode", "highTokens"])} min={0} step={1} onChange={(value) => updateNumber(["dcp", "compress", "messageMode", "highTokens"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Message-mode suggestions" explicit={has(["dcp", "compress", "messageMode", "maxSuggestions"])} defaultLabel={defaultLabel(["dcp", "compress", "messageMode", "maxSuggestions"])} onReset={() => reset(["dcp", "compress", "messageMode", "maxSuggestions"])}>
      <SettingsNumberInput value={number(["dcp", "compress", "messageMode", "maxSuggestions"])} min={0} step={1} onChange={(value) => updateNumber(["dcp", "compress", "messageMode", "maxSuggestions"], value)} />
    </SettingsFieldRow>

    <SettingsFieldRow label="Automatic compression" description="Allow autonomous compression after pressure/opportunity gates." explicit={has(["dcp", "compress", "autoCompress", "enabled"])} defaultLabel={defaultLabel(["dcp", "compress", "autoCompress", "enabled"])} onReset={() => reset(["dcp", "compress", "autoCompress", "enabled"])}>
      <SettingsSwitch value={bool(["dcp", "compress", "autoCompress", "enabled"])} onChange={(value) => set(["dcp", "compress", "autoCompress", "enabled"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Auto-compress patience" explicit={has(["dcp", "compress", "autoCompress", "patience"])} defaultLabel={defaultLabel(["dcp", "compress", "autoCompress", "patience"])} onReset={() => reset(["dcp", "compress", "autoCompress", "patience"])}>
      <SettingsNumberInput value={number(["dcp", "compress", "autoCompress", "patience"])} min={0} step={1} onChange={(value) => updateNumber(["dcp", "compress", "autoCompress", "patience"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Summarizer models" description="Ordered models used for generated compression summaries." explicit={has(["dcp", "compress", "autoCompress", "summarizerModel"])} defaultLabel={defaultLabel(["dcp", "compress", "autoCompress", "summarizerModel"])} onReset={() => reset(["dcp", "compress", "autoCompress", "summarizerModel"])}>
      <SettingsModelList value={list(["dcp", "compress", "autoCompress", "summarizerModel"])} {models} addLabel="Add summarizer" onChange={(value) => set(["dcp", "compress", "autoCompress", "summarizerModel"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Summarizer fallbacks" explicit={has(["dcp", "compress", "autoCompress", "summarizerFallbackModels"])} defaultLabel={defaultLabel(["dcp", "compress", "autoCompress", "summarizerFallbackModels"])} onReset={() => reset(["dcp", "compress", "autoCompress", "summarizerFallbackModels"])}>
      <SettingsModelList value={list(["dcp", "compress", "autoCompress", "summarizerFallbackModels"])} {models} addLabel="Add fallback" onChange={(value) => set(["dcp", "compress", "autoCompress", "summarizerFallbackModels"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Summarizer timeout" description="Per-summarizer deadline in milliseconds." explicit={has(["dcp", "compress", "autoCompress", "timeoutMs"])} defaultLabel={defaultLabel(["dcp", "compress", "autoCompress", "timeoutMs"])} onReset={() => reset(["dcp", "compress", "autoCompress", "timeoutMs"])}>
      <SettingsNumberInput value={number(["dcp", "compress", "autoCompress", "timeoutMs"])} min={1} step={1} onChange={(value) => updateNumber(["dcp", "compress", "autoCompress", "timeoutMs"], value)} />
    </SettingsFieldRow>

    <SettingsFieldRow label="Emergency current-turn pruning" description="Enable bounded same-turn emergency candidates and last-resort output pruning." explicit={has(["dcp", "strategies", "emergencyCurrentTurnPruning", "enabled"])} defaultLabel={defaultLabel(["dcp", "strategies", "emergencyCurrentTurnPruning", "enabled"])} onReset={() => reset(["dcp", "strategies", "emergencyCurrentTurnPruning", "enabled"])}>
      <SettingsSwitch value={bool(["dcp", "strategies", "emergencyCurrentTurnPruning", "enabled"])} onChange={(value) => set(["dcp", "strategies", "emergencyCurrentTurnPruning", "enabled"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Emergency hard context" explicit={has(["dcp", "strategies", "emergencyCurrentTurnPruning", "hardContextPercent"])} defaultLabel={defaultLabel(["dcp", "strategies", "emergencyCurrentTurnPruning", "hardContextPercent"])} onReset={() => reset(["dcp", "strategies", "emergencyCurrentTurnPruning", "hardContextPercent"])}>
      <SettingsNumberInput value={number(["dcp", "strategies", "emergencyCurrentTurnPruning", "hardContextPercent"])} min={0} max={1} step={0.01} onChange={(value) => updateNumber(["dcp", "strategies", "emergencyCurrentTurnPruning", "hardContextPercent"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Emergency target context" explicit={has(["dcp", "strategies", "emergencyCurrentTurnPruning", "targetContextPercent"])} defaultLabel={defaultLabel(["dcp", "strategies", "emergencyCurrentTurnPruning", "targetContextPercent"])} onReset={() => reset(["dcp", "strategies", "emergencyCurrentTurnPruning", "targetContextPercent"])}>
      <SettingsNumberInput value={number(["dcp", "strategies", "emergencyCurrentTurnPruning", "targetContextPercent"])} min={0} max={1} step={0.01} onChange={(value) => updateNumber(["dcp", "strategies", "emergencyCurrentTurnPruning", "targetContextPercent"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Emergency patience" explicit={has(["dcp", "strategies", "emergencyCurrentTurnPruning", "patience"])} defaultLabel={defaultLabel(["dcp", "strategies", "emergencyCurrentTurnPruning", "patience"])} onReset={() => reset(["dcp", "strategies", "emergencyCurrentTurnPruning", "patience"])}>
      <SettingsNumberInput value={number(["dcp", "strategies", "emergencyCurrentTurnPruning", "patience"])} min={0} step={1} onChange={(value) => updateNumber(["dcp", "strategies", "emergencyCurrentTurnPruning", "patience"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Emergency recent tool pairs" explicit={has(["dcp", "strategies", "emergencyCurrentTurnPruning", "keepRecentToolPairs"])} defaultLabel={defaultLabel(["dcp", "strategies", "emergencyCurrentTurnPruning", "keepRecentToolPairs"])} onReset={() => reset(["dcp", "strategies", "emergencyCurrentTurnPruning", "keepRecentToolPairs"])}>
      <SettingsNumberInput value={number(["dcp", "strategies", "emergencyCurrentTurnPruning", "keepRecentToolPairs"])} min={0} step={1} onChange={(value) => updateNumber(["dcp", "strategies", "emergencyCurrentTurnPruning", "keepRecentToolPairs"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Emergency minimum output tokens" explicit={has(["dcp", "strategies", "emergencyCurrentTurnPruning", "minOutputTokens"])} defaultLabel={defaultLabel(["dcp", "strategies", "emergencyCurrentTurnPruning", "minOutputTokens"])} onReset={() => reset(["dcp", "strategies", "emergencyCurrentTurnPruning", "minOutputTokens"])}>
      <SettingsNumberInput value={number(["dcp", "strategies", "emergencyCurrentTurnPruning", "minOutputTokens"])} min={0} step={1} onChange={(value) => updateNumber(["dcp", "strategies", "emergencyCurrentTurnPruning", "minOutputTokens"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Emergency max suggestions" explicit={has(["dcp", "strategies", "emergencyCurrentTurnPruning", "maxSuggestions"])} defaultLabel={defaultLabel(["dcp", "strategies", "emergencyCurrentTurnPruning", "maxSuggestions"])} onReset={() => reset(["dcp", "strategies", "emergencyCurrentTurnPruning", "maxSuggestions"])}>
      <SettingsNumberInput value={number(["dcp", "strategies", "emergencyCurrentTurnPruning", "maxSuggestions"])} min={0} step={1} onChange={(value) => updateNumber(["dcp", "strategies", "emergencyCurrentTurnPruning", "maxSuggestions"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Emergency protected tools" explicit={has(["dcp", "strategies", "emergencyCurrentTurnPruning", "protectedTools"])} defaultLabel={defaultLabel(["dcp", "strategies", "emergencyCurrentTurnPruning", "protectedTools"])} onReset={() => reset(["dcp", "strategies", "emergencyCurrentTurnPruning", "protectedTools"])}>
      <SettingsStringList value={list(["dcp", "strategies", "emergencyCurrentTurnPruning", "protectedTools"])} placeholder="tool-name" addLabel="Protect tool" onChange={(value) => set(["dcp", "strategies", "emergencyCurrentTurnPruning", "protectedTools"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Protected file patterns" description="File path globs whose content is protected from pruning." explicit={has(["dcp", "protectedFilePatterns"])} defaultLabel={defaultLabel(["dcp", "protectedFilePatterns"])} onReset={() => reset(["dcp", "protectedFilePatterns"])}>
      <SettingsStringList value={list(["dcp", "protectedFilePatterns"])} placeholder="**/important/**" addLabel="Add pattern" onChange={(value) => set(["dcp", "protectedFilePatterns"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Per-model DCP overrides" description="Wildcard-aware model policy overrides. This is intentionally a structured editor because override values are nested partial DCP configurations." explicit={has(["dcp", "modelOverrides"])} defaultLabel={defaultLabel(["dcp", "modelOverrides"])} onReset={() => reset(["dcp", "modelOverrides"])}>
      <SettingsJsonValue value={json(["dcp", "modelOverrides"])} rows={12} placeholder={'{}'} onChange={(value) => updateJson(["dcp", "modelOverrides"], value)} />
    </SettingsFieldRow>
  </div>
{:else if section === "context"}
  <div class="px-2.5 py-2.5">
    <h2 class="text-sm font-semibold text-foreground">Context & repository</h2>
    <p class="mt-0.5 text-xs leading-4 text-muted-foreground">Observation budgets, repository discovery policy, and reusable resource registry.</p>
  </div>
  <div class="border-y border-sidebar-border/70 bg-panel">
    <SettingsFieldRow label="Context Gateway mode" description="Observe is passive telemetry; enforce compacts only supported recoverable result shapes." explicit={has(["contextGateway", "mode"])} defaultLabel={defaultLabel(["contextGateway", "mode"])} onReset={() => reset(["contextGateway", "mode"])}>
      <SettingsSelect value={text(["contextGateway", "mode"])} options={CONTEXT_GATEWAY_MODE} onChange={(value) => set(["contextGateway", "mode"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Maximum inline bytes" explicit={has(["contextGateway", "budgets", "maxInlineBytes"])} defaultLabel={defaultLabel(["contextGateway", "budgets", "maxInlineBytes"])} onReset={() => reset(["contextGateway", "budgets", "maxInlineBytes"])}>
      <SettingsNumberInput value={number(["contextGateway", "budgets", "maxInlineBytes"])} min={1} max={67108864} step={1} onChange={(value) => updateNumber(["contextGateway", "budgets", "maxInlineBytes"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Maximum result bytes" explicit={has(["contextGateway", "budgets", "maxResultBytes"])} defaultLabel={defaultLabel(["contextGateway", "budgets", "maxResultBytes"])} onReset={() => reset(["contextGateway", "budgets", "maxResultBytes"])}>
      <SettingsNumberInput value={number(["contextGateway", "budgets", "maxResultBytes"])} min={1} max={67108864} step={1} onChange={(value) => updateNumber(["contextGateway", "budgets", "maxResultBytes"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Maximum exact-read bytes" explicit={has(["contextGateway", "budgets", "maxExactReadBytes"])} defaultLabel={defaultLabel(["contextGateway", "budgets", "maxExactReadBytes"])} onReset={() => reset(["contextGateway", "budgets", "maxExactReadBytes"])}>
      <SettingsNumberInput value={number(["contextGateway", "budgets", "maxExactReadBytes"])} min={1} max={67108864} step={1} onChange={(value) => updateNumber(["contextGateway", "budgets", "maxExactReadBytes"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Maximum search bytes" explicit={has(["contextGateway", "budgets", "maxSearchBytes"])} defaultLabel={defaultLabel(["contextGateway", "budgets", "maxSearchBytes"])} onReset={() => reset(["contextGateway", "budgets", "maxSearchBytes"])}>
      <SettingsNumberInput value={number(["contextGateway", "budgets", "maxSearchBytes"])} min={1} max={67108864} step={1} onChange={(value) => updateNumber(["contextGateway", "budgets", "maxSearchBytes"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Maximum search matches" explicit={has(["contextGateway", "budgets", "maxSearchMatches"])} defaultLabel={defaultLabel(["contextGateway", "budgets", "maxSearchMatches"])} onReset={() => reset(["contextGateway", "budgets", "maxSearchMatches"])}>
      <SettingsNumberInput value={number(["contextGateway", "budgets", "maxSearchMatches"])} min={1} max={1000} step={1} onChange={(value) => updateNumber(["contextGateway", "budgets", "maxSearchMatches"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Repository discovery profile" description="Baseline keeps historical behavior; Native compact enables bounded native flags/cursors/output." explicit={has(["repoDiscovery", "profile"])} defaultLabel={defaultLabel(["repoDiscovery", "profile"])} onReset={() => reset(["repoDiscovery", "profile"])}>
      <SettingsSelect value={text(["repoDiscovery", "profile"])} options={REPO_DISCOVERY_PROFILE} onChange={(value) => set(["repoDiscovery", "profile"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Registry remote" description="Private Git remote for reusable skills, agents, and project-scoped state." explicit={has(["resourceRegistry", "remote"])} defaultLabel={defaultLabel(["resourceRegistry", "remote"])} onReset={() => reset(["resourceRegistry", "remote"])}>
      <SettingsTextInput value={text(["resourceRegistry", "remote"])} placeholder="git@github.com:you/pix-resources.git" onChange={(value) => set(["resourceRegistry", "remote"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Registry branch" explicit={has(["resourceRegistry", "branch"])} defaultLabel={defaultLabel(["resourceRegistry", "branch"])} onReset={() => reset(["resourceRegistry", "branch"])}>
      <SettingsTextInput value={text(["resourceRegistry", "branch"])} placeholder="main" onChange={(value) => set(["resourceRegistry", "branch"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Registry project key" description="Optional explicit projects/&lt;key&gt; override; normally derived from Git origin." explicit={has(["resourceRegistry", "projectKey"])} defaultLabel={defaultLabel(["resourceRegistry", "projectKey"])} onReset={() => reset(["resourceRegistry", "projectKey"])}>
      <SettingsTextInput value={text(["resourceRegistry", "projectKey"])} placeholder="derived from Git origin" onChange={(value) => set(["resourceRegistry", "projectKey"], value)} />
    </SettingsFieldRow>
  </div>
{:else if section === "integrations"}
  <div class="px-2.5 py-2.5">
    <h2 class="text-sm font-semibold text-foreground">Integrations</h2>
    <p class="mt-0.5 text-xs leading-4 text-muted-foreground">Notifications, Telegram, prompt commands, tool rendering, and language servers.</p>
  </div>
  <div class="border-y border-sidebar-border/70 bg-panel">
    <SettingsFieldRow label="Terminal bell" description="Play the terminal bell sound on completion/error." explicit={has(["terminalBell", "sound"])} defaultLabel={defaultLabel(["terminalBell", "sound"])} onReset={() => reset(["terminalBell", "sound"])}>
      <SettingsSwitch value={bool(["terminalBell", "sound"])} onChange={(value) => set(["terminalBell", "sound"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Telegram connector" description="Enable Telegram task/control integration. It can also auto-enable when token and chat id are configured." explicit={has(["telegramConnector", "enabled"])} defaultLabel={defaultLabel(["telegramConnector", "enabled"])} onReset={() => reset(["telegramConnector", "enabled"])}>
      <SettingsSwitch value={bool(["telegramConnector", "enabled"])} onChange={(value) => set(["telegramConnector", "enabled"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Telegram bot token" explicit={has(["telegramConnector", "botToken"])} defaultLabel={defaultLabel(["telegramConnector", "botToken"])} onReset={() => reset(["telegramConnector", "botToken"])}>
      <SettingsTextInput type="password" sensitive value={text(["telegramConnector", "botToken"])} placeholder="123456:ABC…" onChange={(value) => set(["telegramConnector", "botToken"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Telegram chat id" description="Private chat id allowed to control Pix. Numeric and string ids are supported." explicit={has(["telegramConnector", "chatId"])} defaultLabel={defaultLabel(["telegramConnector", "chatId"])} onReset={() => reset(["telegramConnector", "chatId"])}>
      <SettingsTextInput value={text(["telegramConnector", "chatId"])} placeholder="-1001234567890" onChange={updateChatId} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Prompt commands" description="Slash-command definitions keyed by command name." explicit={has(["promptCommands", "commands"])} defaultLabel={defaultLabel(["promptCommands", "commands"])} onReset={() => reset(["promptCommands", "commands"])}>
      <SettingsJsonValue value={json(["promptCommands", "commands"])} rows={8} placeholder={'{\n  "commit": { "prompt": "Commit all changes" }\n}'} onChange={(value) => updateJson(["promptCommands", "commands"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Tool rendering" description="Default and per-tool rendering rules. Tool-specific keys may be names or glob patterns." explicit={has(["toolRenderer"])} defaultLabel={defaultLabel(["toolRenderer"])} onReset={() => reset(["toolRenderer"])}>
      <SettingsJsonValue value={json(["toolRenderer"])} rows={8} placeholder={'{}'} onChange={(value) => updateJson(["toolRenderer"], value)} />
    </SettingsFieldRow>
    <SettingsFieldRow label="Language servers" description="LSP server definitions including include/exclude globs, binaries, arguments, environment, and language ids." explicit={has(["lsp", "servers"])} defaultLabel={defaultLabel(["lsp", "servers"])} onReset={() => reset(["lsp", "servers"])}>
      <SettingsJsonValue value={json(["lsp", "servers"])} rows={14} placeholder="[]" onChange={(value) => updateJson(["lsp", "servers"], value)} />
    </SettingsFieldRow>
  </div>
{/if}
