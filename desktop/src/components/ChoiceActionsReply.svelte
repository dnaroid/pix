<script lang="ts">
  import Check from "@lucide/svelte/icons/check";
  import type { ChoiceActions } from "../lib/choice-actions";

  let { actions }: { actions: ChoiceActions } = $props();
</script>

<div data-choice-actions-reply>
  <p class="mb-2 text-sm">{actions.submitLabel}:</p>
  <ul class="w-full divide-y divide-border/70 rounded-md border border-border/70">
    {#each actions.items as item, index}
      <li class={["flex w-full cursor-default items-start gap-2.5 px-2.5 py-2 text-sm opacity-60", item.checked && "bg-panel-selected"]}>
        <span class={[
          "mt-0.5 grid size-4 shrink-0 place-items-center rounded-sm border",
          item.checked ? "border-primary" : "border-muted-foreground/50",
        ]} aria-hidden="true">{#if item.checked}<Check class="size-3 text-primary" strokeWidth={2.4} />{/if}</span>
        <span class="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground">
          <span class="sr-only">{item.checked ? "Selected: " : "Not selected: "}</span>
          <span class="text-muted-foreground tabular-nums">{index + 1}.</span> {item.label}
        </span>
      </li>
    {/each}
  </ul>
</div>
