<script lang="ts">
  import type { ComponentProps } from "svelte";
  import CommandPicker from "./CommandPicker.svelte";
  import ElicitationDialog from "./ElicitationDialog.svelte";
  import ModelThinkingPicker from "./ModelThinkingPicker.svelte";
  import QuotaWaitPopup from "./QuotaWaitPopup.svelte";
  import QuotaWaitSchedulePopup from "./QuotaWaitSchedulePopup.svelte";

  let {
    elicitation,
    commandPicker,
    modelThinking,
    quotaWait,
    quotaWaitSchedule,
  }: {
    elicitation: ComponentProps<typeof ElicitationDialog> | null;
    commandPicker: ComponentProps<typeof CommandPicker> | null;
    modelThinking: ComponentProps<typeof ModelThinkingPicker> | null;
    quotaWait: ComponentProps<typeof QuotaWaitPopup> | null;
    quotaWaitSchedule: ComponentProps<typeof QuotaWaitSchedulePopup> | null;
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

{#if quotaWait}
  <QuotaWaitPopup {...quotaWait} />
{/if}

{#if quotaWaitSchedule}
  {#key quotaWaitSchedule.sessionId}
    <QuotaWaitSchedulePopup {...quotaWaitSchedule} />
  {/key}
{/if}
