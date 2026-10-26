<script lang="ts">
  import Circle from "@lucide/svelte/icons/circle";
  import CircleCheck from "@lucide/svelte/icons/circle-check";
  import Image from "@lucide/svelte/icons/image";
  import CircleX from "@lucide/svelte/icons/circle-x";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import type { ToolCallStatus } from "@agentclientprotocol/sdk";
  import type { ToolAttention } from "../lib/tool-output";

  let {
    status,
    attention,
    lifecycleOnly = false,
    imageRead = false,
    class: className = "h-3 w-3",
  }: {
    status: ToolCallStatus;
    attention?: ToolAttention;
    lifecycleOnly?: boolean;
    imageRead?: boolean;
    class?: string;
  } = $props();
</script>

{#if lifecycleOnly && status === "in_progress"}
  <LoaderCircle class={`${className} animate-spin text-primary motion-reduce:animate-none`} aria-hidden="true" />
{:else if lifecycleOnly && status === "pending"}
  <Circle class={`${className} text-muted-foreground`} aria-hidden="true" />
{:else if lifecycleOnly}
  <CircleCheck class={`${className} text-muted-foreground`} aria-hidden="true" />
{:else if status === "failed"}
  <CircleX class={`${className} text-tool-error`} aria-hidden="true" />
{:else if status === "in_progress"}
  <LoaderCircle class={`${className} animate-spin text-primary motion-reduce:animate-none`} aria-hidden="true" />
{:else if status === "completed" && attention}
  <TriangleAlert
    class={`${className} ${attention === "error" ? "text-tool-error" : "text-tool-warning"}`}
    aria-hidden="true"
  />
{:else if status === "completed"}
  {#if imageRead}
    <Image class={`${className} text-tool-success`} aria-hidden="true" />
  {:else}
    <CircleCheck class={`${className} text-tool-success`} aria-hidden="true" />
  {/if}
{:else}
  <Circle class={`${className} text-muted-foreground`} aria-hidden="true" />
{/if}
