<script lang="ts">
  import Timer from "@lucide/svelte/icons/timer";
  import { iconButtonClass } from "../lib/icon-button";
  import { EMPTY_WIKI_AUTO_CHECK_VIEW, type WikiAutoCheckView } from "../lib/wiki-auto-check-config";

  // "switch" is the compact header toggle; "notice" is the optional error line
  // rendered below the header only when a recoverable error exists.
  let { state = EMPTY_WIKI_AUTO_CHECK_VIEW, disabled = false, part = "switch", onChange }: {
    state?: WikiAutoCheckView;
    disabled?: boolean;
    part?: "switch" | "notice";
    onChange?: (enabled: boolean) => void | Promise<void>;
  } = $props();

  const LABEL = "Проверять в фоне";
  const unavailable = $derived(disabled || state.saving || !onChange);
  const progress = $derived.by(() => {
    if (state.saving) return "Сохранение…";
    if (!state.enabled) return state.running ? "Текущая проверка завершается…" : "";
    if (state.scanning && !state.total) return "Поиск страниц…";
    if (state.total) {
      const count = `Обработано ${state.completed} из ${state.total}`;
      if (state.queued) return `${count} · в очереди ${state.queued}`;
      if (state.running) return `${count} · проверка…`;
      if (state.scanning) return `${count} · поиск страниц…`;
      return `${count} · отслеживание изменений`;
    }
    return state.running ? "Проверка…" : "Отслеживание изменений";
  });
  const title = $derived(progress ? `${LABEL} — ${progress}` : LABEL);

  function toggle(): void {
    if (!unavailable) void onChange?.(!state.enabled);
  }
</script>

{#if part === "switch"}
  <button
    class={iconButtonClass("sm", "chrome", { extra: state.enabled ? "bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary" : "" })}
    type="button"
    role="switch"
    aria-checked={state.enabled}
    aria-label={LABEL}
    aria-busy={state.saving}
    {title}
    disabled={unavailable}
    onclick={toggle}
    data-wiki-auto-check
  ><Timer class="h-3.5 w-3.5" aria-hidden="true" /></button>
{:else if state.error}
  <p class="min-w-0 break-words border-b border-sidebar-border bg-sidebar px-3 py-1 text-xs text-tool-warning" data-wiki-auto-check-error role="status">{state.error}</p>
{/if}
