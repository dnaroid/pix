<script lang="ts">
  import CheckCircle2 from "@lucide/svelte/icons/check-circle-2";
  import CircleArrowDown from "@lucide/svelte/icons/circle-arrow-down";
  import CircleArrowUp from "@lucide/svelte/icons/circle-arrow-up";
  import CircleX from "@lucide/svelte/icons/circle-x";
  import CloudOff from "@lucide/svelte/icons/cloud-off";
  import GitCompareArrows from "@lucide/svelte/icons/git-compare-arrows";
  import Link2Off from "@lucide/svelte/icons/link-2-off";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import type { RegistryStatus } from "../lib/registry";

  let { status, synced = false, class: className = "h-3.5 w-3.5" }: {
    status: RegistryStatus;
    /** Overrides the status icon with "up-to-date" styling for in-context, non-local items. */
    synced?: boolean;
    class?: string;
  } = $props();
</script>

{#if status === "up-to-date" || synced}<CheckCircle2 class={className} aria-hidden="true" />
{:else if status === "update-available" || status === "missing-local" || status === "not-installed"}<CircleArrowDown class={className} aria-hidden="true" />
{:else if status === "local-changes" || status === "local-only"}<CircleArrowUp class={className} aria-hidden="true" />
{:else if status === "diverged"}<TriangleAlert class={className} aria-hidden="true" />
{:else if status === "untracked-local"}<GitCompareArrows class={className} aria-hidden="true" />
{:else if status === "removed-remote"}<CloudOff class={className} aria-hidden="true" />
{:else if status === "registry-changed"}<Link2Off class={className} aria-hidden="true" />
{:else}<CircleX class={className} aria-hidden="true" />{/if}
