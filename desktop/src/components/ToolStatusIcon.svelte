<script lang="ts">
  import Circle from "@lucide/svelte/icons/circle";
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import CircleX from "@lucide/svelte/icons/circle-x";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import type { ToolCallStatus } from "@agentclientprotocol/sdk";
  import type { ToolAttention } from "../lib/tool-output";

  let {
    status,
    attention,
    class: className = "h-3 w-3",
  }: {
    status: ToolCallStatus;
    attention?: ToolAttention;
    class?: string;
  } = $props();
</script>

{#if status === "failed"}
  <CircleX class={`${className} text-destructive`} aria-hidden="true" />
{:else if status === "in_progress"}
  <LoaderCircle class={`${className} animate-spin text-primary motion-reduce:animate-none`} aria-hidden="true" />
{:else if status === "completed" && attention}
  <TriangleAlert
    class={className}
    style={`color: var(${attention === "error" ? "--tool-error" : "--tool-warning"})`}
    aria-hidden="true"
  />
{:else if status === "completed"}
  <CircleCheck class={`${className} text-status`} aria-hidden="true" />
{:else}
  <Circle class={`${className} text-muted-foreground`} aria-hidden="true" />
{/if}
