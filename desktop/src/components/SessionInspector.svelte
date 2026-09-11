<script lang="ts">
  import Activity from "@lucide/svelte/icons/activity";
  import X from "@lucide/svelte/icons/x";
  import { onMount } from "svelte";
  import type { SessionActivitySummary } from "../lib/session-activity";
  import type { SessionSubagentSnapshot } from "../lib/session-subagents";
  import type { SessionTodoSnapshot } from "../lib/session-todos";
  import SessionSubagentsPanel from "./SessionSubagentsPanel.svelte";
  import SessionTodosPanel from "./SessionTodosPanel.svelte";

  let {
    activeSessionId,
    sessionTitle,
    summary,
    todoSnapshot,
    subagentSnapshot,
    onClose,
  }: {
    activeSessionId: string | null;
    sessionTitle: string;
    summary: SessionActivitySummary;
    todoSnapshot: SessionTodoSnapshot | undefined;
    subagentSnapshot: SessionSubagentSnapshot | undefined;
    onClose: () => void;
  } = $props();

  const WIDTH_KEY = "pix.desktop.sessionInspectorWidth";
  const DEFAULT_WIDTH = 320;
  const MIN_WIDTH = 280;
  const MAX_WIDTH = 480;
  const KEYBOARD_STEP = 12;

  let inspectorWidth = $state(DEFAULT_WIDTH);
  let resizePointerId = $state<number | null>(null);
  let resizeStartX = 0;
  let resizeStartWidth = DEFAULT_WIDTH;
  let previousDocumentUserSelect: string | null = null;
  let previousDocumentCursor: string | null = null;

  onMount(() => {
    try {
      const savedWidth = Number(localStorage.getItem(WIDTH_KEY));
      if (Number.isFinite(savedWidth) && savedWidth > 0) {
        inspectorWidth = clampWidth(savedWidth);
      }
    } catch {
      // Pane sizing is a convenience; keep the in-memory default when unavailable.
    }

    return () => setDocumentResizeState(false);
  });

  function clampWidth(width: number): number {
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
  }

  function persistWidth(): void {
    try {
      localStorage.setItem(WIDTH_KEY, String(inspectorWidth));
    } catch {
      // Persistence is best-effort and must never gate inspector use.
    }
  }

  function startResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    resizePointerId = event.pointerId;
    resizeStartX = event.clientX;
    resizeStartWidth = inspectorWidth;
    setDocumentResizeState(true);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function resize(event: PointerEvent): void {
    if (event.pointerId !== resizePointerId) return;
    inspectorWidth = clampWidth(resizeStartWidth + resizeStartX - event.clientX);
  }

  function finishResize(event: PointerEvent): void {
    if (event.pointerId !== resizePointerId) return;
    resizePointerId = null;
    setDocumentResizeState(false);
    persistWidth();
  }

  function resizeWithKeyboard(event: KeyboardEvent): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home") return;
    event.preventDefault();
    if (event.key === "Home") inspectorWidth = DEFAULT_WIDTH;
    else inspectorWidth = clampWidth(inspectorWidth + (event.key === "ArrowLeft" ? KEYBOARD_STEP : -KEYBOARD_STEP));
    persistWidth();
  }

  function resetWidth(): void {
    inspectorWidth = DEFAULT_WIDTH;
    persistWidth();
  }

  function setDocumentResizeState(active: boolean): void {
    const root = document.documentElement;
    if (active) {
      if (previousDocumentUserSelect === null) previousDocumentUserSelect = root.style.userSelect;
      if (previousDocumentCursor === null) previousDocumentCursor = root.style.cursor;
      root.style.userSelect = "none";
      root.style.cursor = "col-resize";
      return;
    }

    if (previousDocumentUserSelect !== null) {
      root.style.userSelect = previousDocumentUserSelect;
      previousDocumentUserSelect = null;
    }
    if (previousDocumentCursor !== null) {
      root.style.cursor = previousDocumentCursor;
      previousDocumentCursor = null;
    }
  }
</script>

<aside
  id="session-activity-inspector"
  class="relative z-20 grid min-h-0 shrink-0 grid-rows-[36px_minmax(0,1fr)] border-l border-border bg-panel text-foreground max-[980px]:absolute max-[980px]:inset-y-0 max-[980px]:right-0 max-[980px]:max-w-[calc(100%_-_48px)] max-[980px]:shadow-md"
  style:width={`${inspectorWidth}px`}
  aria-label="Session activity inspector"
>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="absolute inset-y-0 -left-[4px] z-30 w-2 cursor-col-resize touch-none after:absolute after:inset-y-0 after:left-[3px] after:w-px hover:after:bg-primary focus-visible:after:bg-ring max-[980px]:hidden"
    role="separator"
    aria-label="Resize session inspector"
    aria-orientation="vertical"
    aria-valuemin={MIN_WIDTH}
    aria-valuemax={MAX_WIDTH}
    aria-valuenow={inspectorWidth}
    aria-controls="session-activity-inspector"
    tabindex="0"
    onpointerdown={startResize}
    onpointermove={resize}
    onpointerup={finishResize}
    onpointercancel={finishResize}
    onlostpointercapture={finishResize}
    onkeydown={resizeWithKeyboard}
    ondblclick={resetWidth}
  ></div>

  <header class="flex min-w-0 items-center gap-2 border-b border-border bg-chrome px-2.5">
    <Activity class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    <strong class="shrink-0 text-[11px] font-semibold uppercase tracking-wide">Session</strong>
    <span class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground" title={sessionTitle}>{sessionTitle}</span>
    <button
      class="grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      type="button"
      title="Close session activity"
      aria-label="Close session activity"
      onclick={onClose}
    ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
  </header>

  {#if !activeSessionId}
    <div class="grid min-h-0 place-items-center px-4 text-center">
      <div>
        <Activity class="mx-auto mb-2 h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <p class="text-xs font-medium">No active session</p>
        <p class="mt-1 text-[11px] leading-4 text-muted-foreground">Open a conversation to inspect its runtime activity.</p>
      </div>
    </div>
  {:else}
    <div class="min-h-0 overflow-y-auto">
      <SessionSubagentsPanel snapshot={subagentSnapshot} activeCount={summary.activeSubagents} />
      <SessionTodosPanel snapshot={todoSnapshot} summary={summary} />
    </div>
  {/if}
</aside>

