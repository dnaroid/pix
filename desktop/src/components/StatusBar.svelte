<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import type { RuntimeStatus, SessionUsageReport } from "../lib/acp-client";
  import { modelProviderBrand } from "../lib/model-display";
  import { AUTO_MODEL_REF, modelThinkingConfigState } from "../lib/model-thinking";
  import type { SessionActivitySummary } from "../lib/session-activity";
  import type { SessionSubagentSnapshot } from "../lib/session-subagents";
  import type { SessionTodoSnapshot, SessionTodoTask } from "../lib/session-todos";
  import ModelProviderIcon from "./ModelProviderIcon.svelte";
  import FrontierModelBadge from "./FrontierModelBadge.svelte";
  import RuntimeStatusBarItems from "./RuntimeStatusBarItems.svelte";
  import ObserverStatus from "./ObserverStatus.svelte";
  import TaskFieldSelect from "./TaskFieldSelect.svelte";
  import type { HeadsUpSnapshot } from "../lib/heads-up";
  import SessionActivityStatusHud from "./SessionActivityStatusHud.svelte";
  import SessionPlanStatus from "./SessionPlanStatus.svelte";
  import type { PlanProgress } from "../lib/project-documents";

  type ConfigValue = { value: string; name: string; group?: string };

  let {
    showSkeletons = false,
    configOptions,
    changingConfig,
    promptRunning,
    quotaWaitIndicator = null,
    observer = null,
    canConfigure,
    modelThinkingOpen,
    runtimeStatus,
    sessionUsage,
    sessionUsageRefreshing,
    sessionUsageFailed,
    sessionUsageAvailable,
    claudeCodeRoute = false,
    lastClaudeAccountAttempt,
    claudeLimitsRefreshing = false,
    claudeLimitsFailed = false,
    sessionActivity,
    sessionSubagentSnapshot,
    sessionTodoSnapshot,
    onOpenSubagentSession,
    sessionNeedsInput,
    canClearTodos,
    onSetConfig,
    onOpenModelThinking,
    onOpenSessionUsage,
    subagentPathNavigation,
    onRefreshClaudeLimits = () => {},
    onClearTodos,
    sessionPlan,
    onOpenPlan,
    onRefreshPlans,
    onResumePlan,
    planRunDisabled = false,
    canJumpToSteps = false,
    onJumpToStep,
  }: {
    showSkeletons?: boolean;
    configOptions: SessionConfigOption[];
    changingConfig: string | null;
    promptRunning: boolean;
    quotaWaitIndicator?: { label: string; onReopen: () => void } | null;
    observer?: {
      sessionId: string | null;
      runtimeReady: boolean;
      snapshot?: HeadsUpSnapshot;
      pendingToggle: boolean;
      pendingCheck: boolean;
      onToggle: () => void;
      onCheck: () => void;
      onRequestSnapshot: () => void;
      onOpenSettings: () => void;
    } | null;
    canConfigure: boolean;
    modelThinkingOpen: boolean;
    runtimeStatus?: RuntimeStatus;
    sessionUsage?: SessionUsageReport;
    sessionUsageRefreshing: boolean;
    sessionUsageFailed: boolean;
    sessionUsageAvailable: boolean;
    claudeCodeRoute?: boolean;
    lastClaudeAccountAttempt?: string;
    claudeLimitsRefreshing?: boolean;
    claudeLimitsFailed?: boolean;
    sessionActivity: SessionActivitySummary;
    sessionSubagentSnapshot: SessionSubagentSnapshot | undefined;
    sessionTodoSnapshot: SessionTodoSnapshot | undefined;
    onOpenSubagentSession?: (runDir: string, agentId: string) => void;
    sessionNeedsInput: boolean;
    canClearTodos: boolean;
    onSetConfig: (option: SessionConfigOption, value: string | boolean) => void;
    onOpenModelThinking: () => void;
    onOpenSessionUsage: () => void;
    subagentPathNavigation?: import("../lib/project-path-navigation").ProjectPathNavigation;
    onRefreshClaudeLimits?: () => void;
    onClearTodos: () => Promise<boolean>;
    /** Saved plan this session was launched from, when it still exists. */
    sessionPlan?: { path: string; progress: PlanProgress | null; task?: string; status?: import("../lib/plan-launches").PlanRunStatus; resumable?: boolean };
    onOpenPlan?: (path: string) => void;
    onRefreshPlans?: () => Promise<void>;
    onResumePlan?: (path: string) => void;
    planRunDisabled?: boolean;
    canJumpToSteps?: boolean;
    onJumpToStep?: (task: SessionTodoTask) => void;
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

<!-- Keep status popovers above positioned composer content, including its textarea. -->
<footer class="relative z-20 flex h-full min-w-0 select-none items-center gap-2 border-t border-border bg-chrome px-2.5 text-xs text-muted-foreground">
  <div class="flex min-w-0 flex-1 items-center gap-2">
    {#if modelThinking.currentModel}
      <button
        class={[
          "flex h-6 min-w-0 items-center gap-1.5 rounded-sm bg-transparent px-1 transition-colors hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40",
          modelThinkingOpen && "bg-chrome-hover",
        ]}
        type="button"
        aria-label="Select model and thinking level"
        data-model-thinking-trigger
        aria-haspopup="dialog"
        aria-expanded={modelThinkingOpen}
        disabled={!canConfigure || changingConfig !== null}
        onclick={onOpenModelThinking}
      >
        {#if modelProviderBrand(modelThinking.currentModel.provider)}
          <ModelProviderIcon provider={modelThinking.currentModel.provider} />
        {/if}
        <span class="max-w-[220px] truncate font-medium text-foreground">{modelThinking.currentModel.name}</span>
        <FrontierModelBadge modelRef={modelThinking.currentModel.ref} />
        {#if modelThinking.currentModel.ref !== AUTO_MODEL_REF}
          <span class="text-muted-foreground/50">·</span>
          <span class="text-muted-foreground">{modelThinking.currentThinking}</span>
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
    {#key observer?.sessionId}
    <RuntimeStatusBarItems
      status={runtimeStatus}
      currentModelProvider={modelThinking.currentModel?.provider}
      {sessionUsage}
      loadingSessionUsage={sessionUsageRefreshing}
      {sessionUsageFailed}
      {sessionUsageAvailable}
      {claudeCodeRoute}
      {lastClaudeAccountAttempt}
      {claudeLimitsRefreshing}
      {claudeLimitsFailed}
      {quotaWaitIndicator}
      onOpenSessionUsage={onOpenSessionUsage}
      {subagentPathNavigation}
      {onOpenSubagentSession}
      onRefreshClaudeLimits={onRefreshClaudeLimits}
    />
    {/key}
    {#each configOptions as option (option.id)}
      {#if option.id === "model" || option.id === "thought_level"}
        <!-- Model + thinking are presented as one staged control above. -->
      {:else if option.type === "select"}
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="text-muted-foreground/70 max-[760px]:hidden" aria-hidden="true">{option.name}</span>
          <div class="min-w-0 max-w-[220px]">
            <TaskFieldSelect
              value={String(option.currentValue)}
              options={configValues(option).map((value) => ({ value: value.value, label: `${value.group ? `${value.group} · ` : ""}${value.name}` }))}
              ariaLabel={option.name}
              size="xs"
              variant="ghost"
              popupMinWidth={180}
              searchPlaceholder="Search…"
              emptyLabel="No matching options"
              disabled={!canConfigure || changingConfig !== null || promptRunning}
              onChange={(value) => onSetConfig(option, value)}
            />
          </div>
        </div>
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

  <div class="flex h-full shrink-0 items-center gap-0.5" data-status-right>
  {#key observer?.sessionId}
  {#if observer}
    <ObserverStatus {...observer} />
  {/if}
  {#if sessionPlan}
    <SessionPlanStatus plan={sessionPlan} onOpen={onOpenPlan} onRefresh={onRefreshPlans} onResume={onResumePlan} resumeDisabled={planRunDisabled} />
  {/if}
  <SessionActivityStatusHud
    summary={sessionActivity}
    subagentSnapshot={sessionSubagentSnapshot}
    todoSnapshot={sessionTodoSnapshot}
    {promptRunning}
    {sessionNeedsInput}
    {canClearTodos}
    {onClearTodos}
    {onOpenSubagentSession}
    {sessionPlan}
    {onOpenPlan}
    {canJumpToSteps}
    {onJumpToStep}
  />
  {/key}
  </div>
</footer>
