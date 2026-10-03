<script lang="ts">
  import CalendarClock from "@lucide/svelte/icons/calendar-clock";
  import History from "@lucide/svelte/icons/history";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import Pause from "@lucide/svelte/icons/pause";
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import WandSparkles from "@lucide/svelte/icons/wand-sparkles";

  let {
    menu = $bindable<HTMLDivElement | null>(null),
    canChooseAttachments,
    onChooseAttachments,
    historyLabel,
    enhanceLabel,
    createTaskLabel,
    deferLabel,
    scheduleContinuationLabel,
    canOpenHistory,
    canEnhance,
    canCreateTask,
    canDefer,
    canScheduleContinuation,
    onOpenHistory,
    onEnhance,
    onCreateTask,
    onDefer,
    onScheduleContinuation,
    onKeydown,
  }: {
    menu: HTMLDivElement | null;
    canChooseAttachments: boolean;
    onChooseAttachments: () => void;
    historyLabel: string;
    enhanceLabel: string;
    createTaskLabel: string;
    deferLabel: string;
    scheduleContinuationLabel: string;
    canOpenHistory: boolean;
    canEnhance: boolean;
    canCreateTask: boolean;
    canDefer: boolean;
    canScheduleContinuation: boolean;
    onOpenHistory: () => void;
    onEnhance: () => void;
    onCreateTask: () => void;
    onDefer: () => void;
    onScheduleContinuation: () => void;
    onKeydown: (event: KeyboardEvent) => void;
  } = $props();
</script>

<div
  bind:this={menu}
  class="absolute right-3 bottom-[calc(100%+0.375rem)] z-40 w-44 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
  data-composer-menu
  role="menu"
  tabindex="-1"
  aria-label="Composer actions"
  onkeydown={onKeydown}
>
  <button
    class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
    type="button"
    role="menuitem"
    tabindex="-1"
    disabled={!canChooseAttachments}
    onclick={onChooseAttachments}
  >
    <Paperclip class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    <span>Attach files</span>
  </button>
  <button
    class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
    type="button"
    role="menuitem"
    tabindex="-1"
    disabled={!canOpenHistory}
    onclick={onOpenHistory}
  >
    <History class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    <span>{historyLabel}</span>
  </button>
  <div class="mx-1 my-1 h-px bg-border" aria-hidden="true"></div>
  <button
    class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
    type="button"
    role="menuitem"
    tabindex="-1"
    disabled={!canEnhance}
    onclick={onEnhance}
  >
    <WandSparkles class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    <span>{enhanceLabel}</span>
  </button>
  <button
    class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
    type="button"
    role="menuitem"
    tabindex="-1"
    disabled={!canCreateTask}
    onclick={onCreateTask}
  >
    <ListTodo class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    <span>{createTaskLabel}</span>
  </button>
  <button
    class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
    type="button"
    role="menuitem"
    tabindex="-1"
    disabled={!canDefer}
    onclick={onDefer}
  >
    <Pause class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    <span>{deferLabel}</span>
  </button>
  <button
    class="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
    type="button"
    role="menuitem"
    tabindex="-1"
    disabled={!canScheduleContinuation}
    data-composer-menu-schedule-continuation
    onclick={onScheduleContinuation}
  >
    <CalendarClock class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
    <span>{scheduleContinuationLabel}</span>
  </button>
</div>
