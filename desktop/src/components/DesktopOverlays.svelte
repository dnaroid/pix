<script lang="ts">
  import type { ComponentProps } from "svelte";
  import CommandPicker from "./CommandPicker.svelte";
  import ElicitationDialog from "./ElicitationDialog.svelte";
  import ModelThinkingPicker from "./ModelThinkingPicker.svelte";

  let {
    elicitation,
    commandPicker,
    modelThinking,
  }: {
    elicitation: ComponentProps<typeof ElicitationDialog> | null;
    commandPicker: ComponentProps<typeof CommandPicker> | null;
    modelThinking: ComponentProps<typeof ModelThinkingPicker> | null;
  } = $props();
</script>

{#if elicitation}
  <ElicitationDialog {...elicitation} />
{/if}

{#if commandPicker}
  <CommandPicker {...commandPicker} />
{/if}

{#if modelThinking}
  <ModelThinkingPicker {...modelThinking} />
{/if}
