<script lang="ts">
  import FileText from "@lucide/svelte/icons/file-text";
  import Search from "@lucide/svelte/icons/search";
  import X from "@lucide/svelte/icons/x";
  import Play from "@lucide/svelte/icons/play";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { iconButtonClass } from "../lib/icon-button";
  import { projectDocumentLabel } from "../lib/project-documents";
  import { linearFocusIndex } from "../lib/keyboard-navigation";
  import type { RegistryPlansView } from "./registry-plans-view.svelte";
  import type { PlanProgress } from "../lib/project-documents";
  import PlanProgressIndicator from "./PlanProgressIndicator.svelte";
  import { onMount } from "svelte";
  import { createProjectFilesRefresh } from "../lib/project-files-refresh";

  let { plans, activePath, view, onChoose, planProgress = {}, onRefresh = async () => {}, actionsDisabled = false, runDisabled = false, onRun = () => {}, onDelete = () => {} }: {
    plans: readonly string[];
    activePath: string | null;
    view: RegistryPlansView;
    onChoose: (path: string) => void;
    planProgress?: Readonly<Record<string, PlanProgress | null>>;
    onRefresh?: () => Promise<void>;
    actionsDisabled?: boolean;
    runDisabled?: boolean;
    onRun?: (path: string) => void;
    onDelete?: (path: string) => void;
  } = $props();

  let searchInput = $state<HTMLInputElement>();
  const choices = $derived(view.visible(plans));
  onMount(() => createProjectFilesRefresh(() => onRefresh(), undefined, 3_000).dispose);

  export function focusSearch(): void {
    searchInput?.focus({ preventScroll: true });
  }

  function focusPlan(event: KeyboardEvent): void {
    const root = (event.currentTarget as HTMLElement).closest("nav")!;
    const rows = [...root.querySelectorAll<HTMLButtonElement>("[data-plan-path]")];
    const current = rows.indexOf(event.target as HTMLButtonElement);
    const index = linearFocusIndex(current, event.key, rows.length, "vertical", false);
    if (index === null) return;
    event.preventDefault();
    rows[index]?.focus();
  }
</script>

{#if plans.length > 0}
<section class="flex max-h-[45%] min-h-0 shrink-0 flex-col border-b border-sidebar-border" aria-label="Project plans">
  <div class="flex h-9 min-w-0 shrink-0 items-center gap-2 px-3">
    <FileText class="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
    <h3 class="shrink-0 text-xs font-semibold">Plans</h3>
    <div class="relative min-w-0 flex-1">
    <Search class="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
    <input
      bind:this={searchInput}
      class="h-7 w-full rounded-md border border-input bg-background pr-8 pl-7 text-xs text-foreground placeholder:text-muted-foreground/70"
      type="search"
      aria-label="Find plan"
      placeholder="Find plan…"
      value={view.query}
      oninput={(event) => view.search(event.currentTarget.value)}
      onkeydown={(event) => {
        if (event.key === "Escape" && view.query) {
          event.preventDefault();
          event.stopPropagation();
          view.search("");
        }
      }}
      autocomplete="off"
      spellcheck="false"
    />
    {#if view.query}
      <button class={iconButtonClass("sm", "chrome", { extra: "absolute top-0.5 right-0.5" })} type="button" aria-label="Clear plan search" onclick={() => { view.search(""); focusSearch(); }}>
        <X class="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    {/if}
    </div>
    <span class="shrink-0 text-xs tabular-nums text-muted-foreground" aria-label={`${plans.length} plans`}>{view.query.trim() ? `${choices.length} / ${plans.length}` : plans.length}</span>
  </div>
  <nav
    class="min-h-0 overflow-y-auto px-1.5 pb-1.5"
    aria-label="Plans"
    use:view.restoreList={{ workspace: view.workspace, query: view.query }}
  >
    {#each choices as plan (plan)}
      {@const label = projectDocumentLabel(plan)}
      {@const slash = label.lastIndexOf("/")}
      <div class={["flex min-h-8 min-w-0 items-start rounded-sm border-l-2 hover:bg-sidebar-accent", activePath === plan ? "border-l-primary bg-sidebar-accent text-foreground" : "border-l-transparent text-muted-foreground"]}>
        <button
          class="flex min-w-0 flex-1 items-start gap-2 rounded-sm px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-ring"
          type="button"
          data-plan-path={plan}
          aria-current={activePath === plan ? "page" : undefined}
          title={plan}
          onclick={() => onChoose(plan)}
          onkeydown={focusPlan}
        >
          <FileText class="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span class="min-w-0 flex-1">
            <span class="block break-words text-xs font-medium text-foreground">{label.slice(slash + 1)}</span>
            {#if slash >= 0}<span class="block break-words text-[11px] text-muted-foreground">{label.slice(0, slash)}</span>{/if}
          </span>
        </button>
        <div class="flex shrink-0 items-center gap-0.5 pt-1 pr-1">
          <PlanProgressIndicator progress={planProgress[plan]} />
          <button class={iconButtonClass("sm", "chrome")} type="button" title="Run plan in a new session"
            aria-label={`Run plan ${label}`} disabled={actionsDisabled || runDisabled} onclick={() => onRun(plan)}>
            <Play class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <button class={iconButtonClass("sm", "chrome", { extra: "hover:text-destructive" })} type="button" title="Delete plan"
            aria-label={`Delete plan ${label}`} disabled={actionsDisabled} onclick={() => onDelete(plan)}>
            <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    {:else}
      <p class="px-2 py-3 text-xs text-muted-foreground">No matching plans</p>
    {/each}
  </nav>
</section>
{/if}
