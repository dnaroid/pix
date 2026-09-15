<script lang="ts">
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import CircleHelp from "@lucide/svelte/icons/circle-help";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import type { SessionTabStatusKind } from "../lib/session-tab-status";

  let {
    kind,
    active = false,
  }: {
    kind: SessionTabStatusKind;
    active?: boolean;
  } = $props();
</script>

<span
  class="relative grid h-3.5 w-3.5 shrink-0 place-items-center"
  data-session-tab-status={kind}
  aria-hidden="true"
>
  {#if kind === "running"}
    <LoaderCircle class="h-3.5 w-3.5 animate-spin text-tool-info motion-reduce:animate-none" />
  {:else if kind === "needs-input"}
    <CircleHelp class={[
      "h-3.5 w-3.5 text-tool-warning",
      !active && "animate-pulse motion-reduce:animate-none",
    ]} />
  {:else if kind === "warning"}
    <TriangleAlert class="h-3.5 w-3.5 text-tool-warning" />
  {:else}
    <CircleCheck class="h-3.5 w-3.5 text-tool-success" />
    {#if kind === "unseen-complete"}
      <span class="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-primary ring-1 ring-background"></span>
    {/if}
  {/if}
</span>
