<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import type { RuntimeStatus, SessionUsageReport } from "../lib/acp-client";
  import { modelDisplayToneClass, thinkingLevelTone } from "../lib/model-display";
  import { AUTO_MODEL_REF, modelThinkingConfigState } from "../lib/model-thinking";
  import { agentIcon } from "../lib/agent-icons";
  import {
    sessionActivityLabel,
    sessionActivityTone,
    type SessionActivitySummary,
  } from "../lib/session-activity";
  import RuntimeStatusBarItems from "./RuntimeStatusBarItems.svelte";

  type ConnectionStatus = "starting" | "ready" | "error" | "stopped";
  type ConfigValue = { value: string; name: string; group?: string };

  let {
    status,
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
    sessionSubagentIcons,
    sessionActivityOpen,
    sessionNeedsInput,
    onSetConfig,
    onOpenModelThinking,
    onOpenSessionUsage,
    onOpenDcpStats,
    onCompressDcpContext,
    onOpenSessionActivity,
  }: {
    status: ConnectionStatus;
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
    sessionSubagentIcons: readonly (string | undefined)[];
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
  const activityTone = $derived(sessionActivityTone(sessionActivity, promptRunning, sessionNeedsInput));
  const activityLabel = $derived(sessionActivityLabel(sessionActivity, promptRunning, sessionNeedsInput));
  const hasTodoProgress = $derived(sessionActivity.openTodos > 0 && sessionActivity.totalTodos > 0);
  const compactSessionActivityVisible = $derived(
    !sessionActivityOpen && (sessionActivity.activeSubagents > 0 || hasTodoProgress),
  );
  const compactAgentIcons = $derived(sessionSubagentIcons.slice(0, 3));
  const hiddenAgentCount = $derived(Math.max(0, sessionSubagentIcons.length - compactAgentIcons.length));
  const activeConversationWorking = $derived(status === "ready" && promptRunning);

  function connectionLabel(value: ConnectionStatus): string {
    if (value === "ready") return "ACP";
    if (value === "starting") return "starting…";
    return value;
  }

  function connectionActivityLabel(value: ConnectionStatus, working: boolean): string {
    if (working) return "ACP ready; active conversation working";
    if (value === "ready") return "ACP ready";
    return `ACP ${connectionLabel(value)}`;
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

  function activityToneClass(): string {
    if (activityTone === "warning") return "text-tool-warning";
    if (activityTone === "info") return "text-tool-info";
    return "text-muted-foreground";
  }

</script>

<footer class="flex h-full min-w-0 select-none items-center gap-2 border-t border-border bg-chrome px-2.5 text-xs text-muted-foreground">
  <div class={[
    "flex shrink-0 items-center gap-2",
    status === "error" && "text-destructive",
  ]}>
    <span
      class={[
        "h-1.5 w-1.5 rounded-full bg-status",
        activeConversationWorking && "bg-primary connection-activity",
        status === "error" && "bg-destructive",
      ]}
      role={activeConversationWorking ? "img" : undefined}
      aria-label={activeConversationWorking ? connectionActivityLabel(status, activeConversationWorking) : undefined}
      title={connectionActivityLabel(status, activeConversationWorking)}
    ></span>
    <span class="max-[760px]:hidden">{connectionLabel(status)}</span>
  </div>

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

  {#if compactSessionActivityVisible}
    <div class="flex shrink-0 items-center" aria-label="Session activity">
      <button
        class={[
          "flex h-6 cursor-pointer items-center gap-1 rounded-sm bg-transparent px-1.5 transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          activityToneClass(),
        ]}
        type="button"
        title={`Open session activity · ${activityLabel}`}
        aria-label={`Open session activity. ${activityLabel}`}
        aria-expanded="false"
        data-session-activity-summary
        onclick={onOpenSessionActivity}
      >
        {#if compactAgentIcons.length > 0}
          <span class="flex items-center gap-0.5" aria-hidden="true">
            {#each compactAgentIcons as iconName, index (`${iconName ?? "agent"}:${index}`)}
              {@const AgentIcon = agentIcon(iconName)}
              <AgentIcon class="h-3.5 w-3.5 shrink-0" />
            {/each}
            {#if hiddenAgentCount > 0}
              <span class="font-mono text-xs leading-none tabular-nums">+{hiddenAgentCount}</span>
            {/if}
          </span>
        {/if}
        {#if hasTodoProgress}
          <span class="flex items-center gap-0.5 font-mono tabular-nums">
            <ListTodo class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{sessionActivity.completedTodos}/{sessionActivity.totalTodos}</span>
          </span>
        {/if}
      </button>
    </div>
  {/if}
</footer>

<style>
  .connection-activity {
    animation: connection-activity-pulse 1.8s ease-in-out infinite;
  }

  @keyframes connection-activity-pulse {
    50% { opacity: 0.55; }
  }

  @media (prefers-reduced-motion: reduce) {
    .connection-activity { animation: none; }
  }
</style>
