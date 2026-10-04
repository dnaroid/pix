<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import { formatSettingsDefaultValue, parseSettingsSource, removeSettingsValue, settingsDefaultValue, settingsHasValue, settingsValue, updateSettingsSource, type SettingsSchema } from "../../lib/settings";
  import type { ModelThinkingModel } from "../../lib/model-thinking";
  import SettingsFieldRow from "./SettingsFieldRow.svelte";
  import SettingsModelSelect from "./SettingsModelSelect.svelte";
  import SettingsNumberInput from "./SettingsNumberInput.svelte";
  import SettingsSwitch from "./SettingsSwitch.svelte";

  let {
    source,
    schema,
    models,
    onChange,
  }: {
    source: string;
    schema: SettingsSchema;
    models: readonly ModelThinkingModel[];
    onChange: (source: string) => void;
  } = $props();

  let advancedOpen = $state(false);
  const parsed = $derived(parseSettingsSource(source).value);

  function has(path: readonly string[]): boolean {
    return settingsHasValue(parsed, path);
  }

  function effective(path: readonly string[]): unknown {
    if (has(path)) return settingsValue(parsed, path);
    return settingsDefaultValue("desktop", schema, path).value;
  }

  function defaultLabel(path: readonly string[]): string {
    const fallback = settingsDefaultValue("desktop", schema, path);
    if (typeof fallback.value === "number" && ["minIntervalMs", "timeoutMs", "noticeTtlMs"].includes(path.at(-1) ?? "")) return `Default · ${fallback.value / 1000} seconds`;
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

  function bool(path: readonly string[]): boolean {
    return effective(path) === true;
  }

  function number(path: readonly string[]): number | undefined {
    const value = effective(path);
    return typeof value === "number" ? value : undefined;
  }

  function updateNumber(path: readonly string[], value: number | undefined): void {
    if (value === undefined) reset(path);
    else set(path, value);
  }

  function seconds(path: readonly string[], divisor: number): number | undefined {
    const value = number(path);
    return value === undefined ? undefined : value / divisor;
  }

  function updateSeconds(path: readonly string[], divisor: number, value: number | undefined): void {
    updateNumber(path, value === undefined ? undefined : Math.round(value * divisor));
  }
</script>

<div class="px-2.5 py-2.5">
  <h2 class="text-sm font-semibold text-foreground">Observer</h2>
  <p class="mt-0.5 text-xs leading-4 text-muted-foreground">Checks for consequential, overlooked tradeoffs. Conversation excerpts are sent to the selected provider; checks consume tokens. Saved Desktop defaults apply to new or reloaded sessions, not active session toggles. Trusted project settings can override them. TUI settings are independent.</p>
</div>
<div class="border-y border-sidebar-border/70 bg-panel">
  <SettingsFieldRow
    label="Enable in new sessions"
    description="Start the observer when a new Desktop session is created. Existing sessions are unchanged until reloaded."
    explicit={has(["headsUp", "enabled"])}
    defaultLabel={defaultLabel(["headsUp", "enabled"])}
    onReset={() => reset(["headsUp", "enabled"])}
  >
    <SettingsSwitch ariaLabel="Enable Observer in new Desktop sessions" value={bool(["headsUp", "enabled"])} onChange={(value) => set(["headsUp", "enabled"], value)} />
  </SettingsFieldRow>
  <SettingsFieldRow
    label="Observer model"
    description="Provider/model used for checks. Configured and custom provider/model references are accepted."
    explicit={has(["headsUp", "model"])}
    defaultLabel={defaultLabel(["headsUp", "model"])}
    onReset={() => reset(["headsUp", "model"])}
  >
    <SettingsModelSelect value={text(["headsUp", "model"])} {models} allowCustom ariaLabel="Observer model" onChange={(value) => set(["headsUp", "model"], value)} />
  </SettingsFieldRow>
  <SettingsFieldRow
    label="Turns between checks"
    description="Minimum completed turns before an automatic observer check."
    explicit={has(["headsUp", "minTurns"])}
    defaultLabel={defaultLabel(["headsUp", "minTurns"])}
    onReset={() => reset(["headsUp", "minTurns"])}
  >
    <SettingsNumberInput ariaLabel="Turns between observer checks" value={number(["headsUp", "minTurns"])} min={1} max={100} step={1} onChange={(value) => updateNumber(["headsUp", "minTurns"], value)} />
  </SettingsFieldRow>
  <SettingsFieldRow
    label="Minimum interval"
    description="Minimum time between automatic checks, shown in seconds and saved as milliseconds."
    explicit={has(["headsUp", "minIntervalMs"])}
    defaultLabel={defaultLabel(["headsUp", "minIntervalMs"])}
    onReset={() => reset(["headsUp", "minIntervalMs"])}
  >
    <SettingsNumberInput ariaLabel="Observer minimum interval in seconds" value={seconds(["headsUp", "minIntervalMs"], 1000)} min={0} max={86400} step={1} onChange={(value) => updateSeconds(["headsUp", "minIntervalMs"], 1000, value)} />
  </SettingsFieldRow>
</div>

<details bind:open={advancedOpen} class="border-b border-sidebar-border/70 bg-panel">
  <summary
    class="flex min-h-9 w-full items-center gap-2 px-2.5 text-left text-xs font-medium text-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring"
  >
    <ChevronDown class={["h-3.5 w-3.5 text-muted-foreground transition-transform", advancedOpen && "rotate-180"]} aria-hidden="true" />
    <span>Advanced budgets and timing</span>
  </summary>
    <div class="border-t border-sidebar-border/50">
      <SettingsFieldRow
        label="Checks per hour"
        description="Maximum automatic and manual observer checks in a rolling hour."
        explicit={has(["headsUp", "maxChecksPerHour"])}
        defaultLabel={defaultLabel(["headsUp", "maxChecksPerHour"])}
        onReset={() => reset(["headsUp", "maxChecksPerHour"])}
      >
        <SettingsNumberInput ariaLabel="Observer checks per rolling hour" value={number(["headsUp", "maxChecksPerHour"])} min={1} max={100} step={1} onChange={(value) => updateNumber(["headsUp", "maxChecksPerHour"], value)} />
      </SettingsFieldRow>
      <SettingsFieldRow
        label="Input characters per check"
        description="Maximum context characters sent in one observer check."
        explicit={has(["headsUp", "maxInputChars"])}
        defaultLabel={defaultLabel(["headsUp", "maxInputChars"])}
        onReset={() => reset(["headsUp", "maxInputChars"])}
      >
        <SettingsNumberInput ariaLabel="Observer input characters per check" value={number(["headsUp", "maxInputChars"])} min={2000} max={50000} step={100} onChange={(value) => updateNumber(["headsUp", "maxInputChars"], value)} />
      </SettingsFieldRow>
      <SettingsFieldRow
        label="Input characters per hour"
        description="Maximum observer input characters in a rolling hour."
        explicit={has(["headsUp", "maxInputCharsPerHour"])}
        defaultLabel={defaultLabel(["headsUp", "maxInputCharsPerHour"])}
        onReset={() => reset(["headsUp", "maxInputCharsPerHour"])}
      >
        <SettingsNumberInput ariaLabel="Observer input characters per rolling hour" value={number(["headsUp", "maxInputCharsPerHour"])} min={2000} max={1000000} step={1000} onChange={(value) => updateNumber(["headsUp", "maxInputCharsPerHour"], value)} />
      </SettingsFieldRow>
      <SettingsFieldRow
        label="Output token budget"
        description="Maximum output tokens requested for one observer check."
        explicit={has(["headsUp", "maxTokens"])}
        defaultLabel={defaultLabel(["headsUp", "maxTokens"])}
        onReset={() => reset(["headsUp", "maxTokens"])}
      >
        <SettingsNumberInput ariaLabel="Observer output token budget" value={number(["headsUp", "maxTokens"])} min={256} max={2000} step={1} onChange={(value) => updateNumber(["headsUp", "maxTokens"], value)} />
      </SettingsFieldRow>
      <SettingsFieldRow
        label="Request timeout"
        description="Maximum time for an observer request, shown in seconds and saved as milliseconds."
        explicit={has(["headsUp", "timeoutMs"])}
        defaultLabel={defaultLabel(["headsUp", "timeoutMs"])}
        onReset={() => reset(["headsUp", "timeoutMs"])}
      >
        <SettingsNumberInput ariaLabel="Observer request timeout in seconds" value={seconds(["headsUp", "timeoutMs"], 1000)} min={1} max={120} step={1} onChange={(value) => updateSeconds(["headsUp", "timeoutMs"], 1000, value)} />
      </SettingsFieldRow>
      <SettingsFieldRow
        label="Notice lifetime"
        description="How long a notice remains visible, shown in seconds and saved as milliseconds."
        explicit={has(["headsUp", "noticeTtlMs"])}
        defaultLabel={defaultLabel(["headsUp", "noticeTtlMs"])}
        onReset={() => reset(["headsUp", "noticeTtlMs"])}
      >
        <SettingsNumberInput ariaLabel="Observer notice lifetime in seconds" value={seconds(["headsUp", "noticeTtlMs"], 1000)} min={30} max={3600} step={1} onChange={(value) => updateSeconds(["headsUp", "noticeTtlMs"], 1000, value)} />
      </SettingsFieldRow>
    </div>
</details>
