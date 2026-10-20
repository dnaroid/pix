<script lang="ts">
  import FileText from "@lucide/svelte/icons/file-text";
  import Play from "@lucide/svelte/icons/play";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import RotateCcw from "@lucide/svelte/icons/rotate-ccw";
  import Ellipsis from "@lucide/svelte/icons/ellipsis";
  import MessageSquare from "@lucide/svelte/icons/message-square";
  import { tick } from "svelte";
  import { registryMenuPosition } from "../lib/registry-card-actions";
  import { planRunResumable } from "../lib/plan-launches";
  import { iconButtonClass } from "../lib/icon-button";
  import type { PlanProgress } from "../lib/project-documents";
  import PlanProgressRing from "./PlanProgressRing.svelte";
  import type { PlanRun } from "../lib/project-task-plans";

  let {
    plan,
    label,
    active,
    progress,
    owner = null,
    runs = [],
    actionsDisabled = false,
    runDisabled = false,
    onChoose,
    onKeydown,
    onRun,
    onDelete,
    onOpenRun,
    onResume,
  }: {
    plan: string;
    label: string;
    active: boolean;
    progress: PlanProgress | null | undefined;
    owner?: string | null;
    runs?: readonly PlanRun[];
    actionsDisabled?: boolean;
    runDisabled?: boolean;
    onChoose: (path: string) => void;
    onKeydown: (event: KeyboardEvent) => void;
    onRun: (path: string) => void;
    onDelete: (path: string) => void;
    onOpenRun?: (sessionId: string) => void;
    onResume?: (path: string) => void;
  } = $props();

  const name = $derived(label.slice(label.lastIndexOf("/") + 1).replace(/\.md$/i, ""));
  const runningRun = $derived(runs.find((run) => run.status === "running") ?? null);
  /** Session opened from the menu: the active run, otherwise the newest one. */
  const sessionRun = $derived(runningRun ?? runs[0] ?? null);
  // Only the newest run can be resumed, and never while another run is active.
  const resumable = $derived(Boolean(onResume && runs[0] && planRunResumable(runs[0].status) && !runningRun));

  let menuOpen = $state(false);
  let trigger: HTMLButtonElement | null = $state(null);
  let menu: HTMLDivElement | null = $state(null);
  let position = $state<{ left: number; top: number } | null>(null);
  let generation = 0;

  function menuItems(): HTMLButtonElement[] {
    return Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
  }

  async function openMenu() {
    const request = ++generation;
    menuOpen = true;
    await tick();
    if (request !== generation || !menuOpen || !menu || !trigger) return;
    const rect = menu.getBoundingClientRect();
    position = registryMenuPosition(trigger.getBoundingClientRect(), rect.width, rect.height, window.innerWidth, window.innerHeight);
    await tick();
    if (request !== generation || !menuOpen) return;
    (menuItems()[0] ?? menu)?.focus();
  }

  function toggleMenu() {
    if (menuOpen) closeMenu(true);
    else void openMenu();
  }

  function closeMenu(restoreFocus = false) {
    generation += 1;
    menuOpen = false;
    position = null;
    if (restoreFocus) trigger?.focus();
  }

  // Overlay: escape the sidebar's scrolling/overflow container; removed on teardown.
  function portal(node: HTMLDivElement) {
    document.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  function choose(action: () => void) {
    closeMenu();
    action();
  }

  function onMenuKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") { closeMenu(true); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const items = menuItems();
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? items.length - 1
      : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  }

  $effect(() => {
    if (!menuOpen) return;
    const outside = (event: Event) => {
      const target = event.target as Node | null;
      if (target && !menu?.contains(target) && !trigger?.contains(target)) closeMenu();
    };
    const scroll = (event: Event) => { if (!menu?.contains(event.target as Node)) closeMenu(); };
    const resize = () => closeMenu();
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    document.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
  });

  const menuItemClass = "flex h-7 w-full items-center gap-2 rounded-sm px-2 text-left text-xs whitespace-nowrap hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
</script>

<div
  class={[
    "group min-w-0 rounded-lg border shadow-xs transition-[background-color,border-color] duration-150 hover:border-border hover:bg-panel-hover motion-reduce:transition-none",
    active ? "border-primary/50 bg-panel-selected ring-1 ring-primary/30" : "border-border/60 bg-panel-strong/30",
  ]}
  data-plan-row={plan}
>
  <div class="flex min-w-0 items-center gap-1.5 px-2 py-1" data-plan-title-row>
    <button
      class="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring"
      type="button"
      data-plan-path={plan}
      aria-current={active ? "page" : undefined}
      title={runningRun ? `${plan} — running: ${runningRun.title}` : plan}
      onclick={() => onChoose(plan)}
      onkeydown={onKeydown}
    >
      {#if runningRun}
        <span class="flex shrink-0 text-primary" data-plan-running title="Running">
          <LoaderCircle class="h-3 w-3 animate-spin" aria-hidden="true" />
          <span class="sr-only">Running:</span>
        </span>
      {:else}
        <FileText class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      {/if}
      <span class="min-w-0 flex-1 truncate text-xs leading-4 font-medium text-foreground">{name}</span>
    </button>
    {#if owner}
      <span class="shrink-0 text-muted-foreground" data-plan-owner aria-label={`Task: ${owner}`} title={`Task: ${owner}`}>
        <ListTodo class="h-3 w-3" aria-hidden="true" />
      </span>
    {/if}
    <PlanProgressRing {progress} />
    <div data-plan-actions class={["flex shrink-0 items-center gap-0.5 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none", menuOpen ? "opacity-100" : "opacity-0"]}>
      <button class={iconButtonClass("sm", "chrome")} type="button" title="Run plan in a new session"
        aria-label={`Run plan ${label}`} disabled={actionsDisabled || runDisabled} onclick={() => onRun(plan)}>
        <Play class="h-3 w-3" aria-hidden="true" />
      </button>
      <div class="relative">
        <button
          bind:this={trigger}
          class={iconButtonClass("sm", "popover")}
          type="button"
          title="Plan actions"
          aria-label={`Actions for plan ${label}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-plan-menu-trigger
          onclick={toggleMenu}
        ><Ellipsis class="h-3.5 w-3.5" aria-hidden="true" /></button>
      </div>
    </div>
  </div>
</div>
{#if menuOpen}
  <div
    use:portal
    bind:this={menu}
    class="fixed z-50 w-40 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    style:left={`${position?.left ?? 0}px`}
    style:top={`${position?.top ?? 0}px`}
    style:visibility={position ? "visible" : "hidden"}
    role="menu"
    tabindex="-1"
    aria-label={`Actions for plan ${label}`}
    data-plan-menu
    onkeydown={onMenuKeydown}
  >
    {#if sessionRun && onOpenRun}
      <button class={[menuItemClass, "text-foreground"]} type="button" role="menuitem" tabindex="-1"
        data-plan-open-session={sessionRun.sessionId} title={sessionRun.title}
        aria-label={`Open session for plan ${label}`}
        onclick={() => choose(() => onOpenRun(sessionRun.sessionId))}>
        <MessageSquare class="h-3 w-3" aria-hidden="true" />Open session
      </button>
    {/if}
    {#if resumable}
      <button class={[menuItemClass, "text-foreground"]} type="button" role="menuitem" tabindex="-1"
        data-plan-resume title="Resume the plan from the first unchecked item in a new session"
        aria-label={`Resume plan ${label}`} disabled={actionsDisabled || runDisabled}
        onclick={() => choose(() => onResume?.(plan))}>
        <RotateCcw class="h-3 w-3" aria-hidden="true" />Resume
      </button>
    {/if}
    <button class={[menuItemClass, "text-tool-error"]} type="button" role="menuitem" tabindex="-1"
      title="Delete plan" aria-label={`Delete plan ${label}`} disabled={actionsDisabled}
      onclick={() => choose(() => onDelete(plan))}>
      <Trash2 class="h-3 w-3" aria-hidden="true" />Delete plan
    </button>
  </div>
{/if}
