<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import type { RuntimeStatus, SessionUsageReport } from "../lib/acp-client";
  import { modelDisplayToneClass, thinkingLevelTone } from "../lib/model-display";
  import { AUTO_MODEL_REF, modelThinkingConfigState } from "../lib/model-thinking";
  import type { SessionActivitySummary } from "../lib/session-activity";
  import type { SessionSubagentSnapshot } from "../lib/session-subagents";
  import type { SessionTodoSnapshot } from "../lib/session-todos";
  import RuntimeStatusBarItems from "./RuntimeStatusBarItems.svelte";
  import SessionActivityStatusHud from "./SessionActivityStatusHud.svelte";

  type ConfigValue = { value: string; name: string; group?: string };

  let {
    showSkeletons = false,
    workspacePath,
    workspaceName,
    workspaceBranch,
    workspaceHue,
    workspaceColor,
    configOptions,
    changingConfig,
    promptRunning,
    canConfigure,
    modelThinkingOpen,
    runtimeStatus,
    sessionUsage,
    sessionUsageRefreshing,
    sessionUsageFailed,
    sessionUsageAvailable,
    dcpStatsRefreshing,
    dcpCompressionRunning,
    dcpCompressionAvailable,
    canCompressContext,
    sessionActivity,
    sessionSubagentSnapshot,
    sessionTodoSnapshot,
    sessionActivityOpen,
    sessionNeedsInput,
    onSetConfig,
    onOpenModelThinking,
    onOpenSessionUsage,
    onOpenDcpStats,
    onCompressDcpContext,
    onOpenSessionActivity,
  }: {
    showSkeletons?: boolean;
    workspacePath?: string;
    workspaceName?: string;
    workspaceBranch?: string;
    workspaceHue?: number;
    workspaceColor?: string;
    configOptions: SessionConfigOption[];
    changingConfig: string | null;
    promptRunning: boolean;
    canConfigure: boolean;
    modelThinkingOpen: boolean;
    runtimeStatus?: RuntimeStatus;
    sessionUsage?: SessionUsageReport;
    sessionUsageRefreshing: boolean;
    sessionUsageFailed: boolean;
    sessionUsageAvailable: boolean;
    dcpStatsRefreshing: boolean;
    dcpCompressionRunning: boolean;
    dcpCompressionAvailable: boolean;
    canCompressContext: boolean;
    sessionActivity: SessionActivitySummary;
    sessionSubagentSnapshot: SessionSubagentSnapshot | undefined;
    sessionTodoSnapshot: SessionTodoSnapshot | undefined;
    sessionActivityOpen: boolean;
    sessionNeedsInput: boolean;
    onSetConfig: (option: SessionConfigOption, value: string | boolean) => void;
    onOpenModelThinking: () => void;
    onOpenSessionUsage: () => void;
    onOpenDcpStats: () => void;
    onCompressDcpContext: () => void;
    onOpenSessionActivity: () => void;
  } = $props();

  const modelThinking = $derived(modelThinkingConfigState(configOptions));

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

<footer class="flex h-full min-w-0 select-none items-center gap-2 border-t border-border bg-chrome px-2.5 text-xs text-muted-foreground">
  <div class="flex min-w-0 flex-1 items-center gap-2">
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
        disabled={!canConfigure || changingConfig !== null}
        onclick={onOpenModelThinking}
      >
        <span class={[
          "max-w-[220px] truncate font-medium",
          modelDisplayToneClass(modelThinking.currentModel.tone),
        ]}>{modelThinking.currentModel.name}</span>
        {#if modelThinking.currentModel.ref !== AUTO_MODEL_REF}
          <span class="text-muted-foreground/50">·</span>
          <span class={[
            "font-medium",
            modelDisplayToneClass(thinkingLevelTone(modelThinking.currentThinking, modelThinking.currentModel.thinkingLevels)),
          ]}>{modelThinking.currentThinking}</span>
        {/if}
        <ChevronDown class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    {:else if showSkeletons}
      <div
        class="flex h-6 min-w-0 items-center gap-1.5 px-1"
        data-status-bar-skeleton="model"
        aria-hidden="true"
      >
        <span class="h-3 w-8 rounded-sm bg-muted-foreground/15 max-[760px]:hidden"></span>
        <span class="h-3 w-24 rounded-sm bg-muted-foreground/20"></span>
        <span class="h-3 w-10 rounded-sm bg-muted-foreground/15"></span>
        <span class="h-3 w-3 rounded-sm bg-muted-foreground/15"></span>
      </div>
    {/if}
    <RuntimeStatusBarItems
      status={runtimeStatus}
      {showSkeletons}
      {workspacePath}
      {workspaceName}
      {workspaceBranch}
      {sessionUsage}
      loadingSessionUsage={sessionUsageRefreshing}
      {sessionUsageFailed}
      {sessionUsageAvailable}
      loadingDcpStats={dcpStatsRefreshing}
      compressingContext={dcpCompressionRunning}
      compressionAvailable={dcpCompressionAvailable}
      {canCompressContext}
      onOpenSessionUsage={onOpenSessionUsage}
      {onOpenDcpStats}
      onCompressContext={onCompressDcpContext}
    />
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

  <SessionActivityStatusHud
    summary={sessionActivity}
    subagentSnapshot={sessionSubagentSnapshot}
    todoSnapshot={sessionTodoSnapshot}
    {promptRunning}
    {sessionNeedsInput}
    {sessionActivityOpen}
    {onOpenSessionActivity}
  />
</footer>
