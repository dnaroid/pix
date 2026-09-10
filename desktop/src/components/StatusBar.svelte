<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ListChevronsUpDown from "@lucide/svelte/icons/list-chevrons-up-down";
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import { modelDisplayToneClass, thinkingLevelTone } from "../lib/model-display";
  import { modelThinkingConfigState } from "../lib/model-thinking";

  type ConnectionStatus = "starting" | "ready" | "error" | "stopped";
  type ConfigValue = { value: string; name: string; group?: string };

  let {
    status,
    configOptions,
    changingConfig,
    promptRunning,
    canConfigure,
    modelThinkingOpen,
    canNavigateMessages,
    messageNavigationOpen,
    onSetConfig,
    onOpenModelThinking,
    onNavigateMessages,
  }: {
    status: ConnectionStatus;
    configOptions: SessionConfigOption[];
    changingConfig: string | null;
    promptRunning: boolean;
    canConfigure: boolean;
    modelThinkingOpen: boolean;
    canNavigateMessages: boolean;
    messageNavigationOpen: boolean;
    onSetConfig: (option: SessionConfigOption, value: string | boolean) => void;
    onOpenModelThinking: () => void;
    onNavigateMessages: () => void;
  } = $props();

  const modelThinking = $derived(modelThinkingConfigState(configOptions));

  function connectionLabel(value: ConnectionStatus): string {
    if (value === "ready") return "ACP";
    if (value === "starting") return "starting…";
    return value;
  }

  function configValues(option: SessionConfigOption): ConfigValue[] {
    if (option.type !== "select") return [];
    const values: ConfigValue[] = [];
    for (const entry of option.options) {
      if ("options" in entry) {
        values.push(...entry.options.map((item) => ({ ...item, group: entry.name })));
      } else {
        values.push({ value: entry.value, name: entry.name });
      }
    }
    return values;
  }

</script>

<footer class="flex min-w-0 items-center gap-3 border-t border-border bg-window-titlebar px-[22px] text-[11px] text-muted-foreground max-[760px]:px-3">
  <div class={[
    "flex items-center gap-2",
    status === "error" && "text-destructive",
  ]}>
    <span class={[
      "h-1.5 w-1.5 rounded-full bg-status",
      status === "error" && "bg-destructive",
    ]}></span>
    <span class="max-[760px]:hidden">{connectionLabel(status)}</span>
  </div>

  <div class="flex min-w-0 items-center gap-3">
    {#if modelThinking.currentModel}
      <button
        class={[
          "flex h-6 min-w-0 cursor-pointer items-center gap-1.5 rounded-sm bg-transparent px-1 transition-colors hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40",
          modelThinkingOpen && "bg-chrome-hover",
        ]}
        type="button"
        aria-label="Select model and thinking level"
        aria-haspopup="dialog"
        aria-expanded={modelThinkingOpen}
        disabled={!canConfigure || changingConfig !== null || promptRunning}
        onclick={onOpenModelThinking}
      >
        <span class="text-muted-foreground/70 max-[760px]:hidden">Model</span>
        <span class={[
          "max-w-[220px] truncate font-medium",
          modelDisplayToneClass(modelThinking.currentModel.tone),
        ]}>{modelThinking.currentModel.name}</span>
        <span class="text-muted-foreground/50">·</span>
        <span class={[
          "font-medium",
          modelDisplayToneClass(thinkingLevelTone(modelThinking.currentThinking, modelThinking.currentModel.thinkingLevels)),
        ]}>{modelThinking.currentThinking}</span>
        <ChevronDown class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    {/if}
    {#each configOptions as option (option.id)}
      {#if option.id === "model" || option.id === "thought_level"}
        <!-- Model + thinking are presented as one staged control above. -->
      {:else if option.type === "select"}
        <label class="flex min-w-0 items-center gap-1.5">
          <span class="text-muted-foreground/70 max-[760px]:hidden">{option.name}</span>
          <span class="relative min-w-0">
            <select
              class="h-6 max-w-[220px] appearance-none overflow-hidden rounded-sm border-0 bg-transparent py-0 pr-5 pl-1 text-primary transition-colors outline-none enabled:hover:bg-chrome-hover enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-40"
              aria-label={option.name}
              value={option.currentValue}
              disabled={!canConfigure || changingConfig !== null || promptRunning}
              onchange={(event) => onSetConfig(option, event.currentTarget.value)}
            >
              {#each configValues(option) as value (value.value)}
                <option value={value.value}>{value.group ? `${value.group} · ` : ""}{value.name}</option>
              {/each}
            </select>
            <ChevronDown class="pointer-events-none absolute top-1/2 right-1 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          </span>
        </label>
      {:else}
        <label class="flex items-center gap-1.5">
          <input
            class="accent-primary transition-shadow enabled:hover:ring-2 enabled:hover:ring-ring/30 disabled:cursor-default disabled:opacity-40"
            type="checkbox"
            checked={option.currentValue}
            disabled={!canConfigure || changingConfig !== null || promptRunning}
            onchange={(event) => onSetConfig(option, event.currentTarget.checked)}
          />
          <span>{option.name}</span>
        </label>
      {/if}
    {/each}
  </div>

  <span class="flex-1"></span>
  <div class="flex shrink-0 items-center gap-0.5" aria-label="Status bar actions">
    <button
      class={[
        "grid h-6 w-6 cursor-pointer place-items-center rounded-sm bg-transparent text-muted-foreground transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40",
        messageNavigationOpen && "bg-chrome-hover text-foreground",
      ]}
      type="button"
      title="Jump to user message"
      aria-label="Jump to user message"
      aria-haspopup="dialog"
      aria-expanded={messageNavigationOpen}
      onclick={onNavigateMessages}
      disabled={!canNavigateMessages}
    ><ListChevronsUpDown class="h-3.5 w-3.5" aria-hidden="true" /></button>
  </div>
</footer>
