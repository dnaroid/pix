<script lang="ts">
  import type { ElicitationField } from "../lib/elicitation";

  let {
    message,
    field,
    onValueChange,
    onAnswer,
  }: {
    message: string;
    field: ElicitationField;
    onValueChange: (value: string | boolean) => void;
    onAnswer: (accepted: boolean) => void;
  } = $props();
</script>

<div class="fixed inset-0 z-30 grid place-items-center bg-foreground/50 p-6 backdrop-blur-sm" role="presentation">
  <div class="w-[min(520px,100%)] rounded-xl border border-border bg-popover p-5 text-popover-foreground shadow-md" role="dialog" aria-modal="true" aria-labelledby="elicitation-title">
    <span class="text-[10px] font-semibold tracking-[0.08em] text-primary uppercase">Pix needs your input</span>
    <h2 id="elicitation-title" class="mt-2 mb-[22px] text-base leading-snug font-medium whitespace-pre-wrap text-foreground">{message}</h2>
    <label class="grid gap-2">
      <span class="text-xs font-semibold">{field.label}</span>
      {#if field.description}<small class="text-muted-foreground">{field.description}</small>{/if}
      {#if field.type === "select"}
        <select
          class="min-h-[34px] w-full rounded-lg border border-input bg-card px-2.5 py-2 text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
          value={String(field.value)}
          onchange={(event) => onValueChange(event.currentTarget.value)}
        >
          {#each field.options as option}<option value={option}>{option}</option>{/each}
        </select>
      {:else if field.type === "boolean"}
        <input
          class="h-5 w-5 accent-primary"
          type="checkbox"
          checked={Boolean(field.value)}
          onchange={(event) => onValueChange(event.currentTarget.checked)}
        />
      {:else}
        <textarea
          class="min-h-[34px] w-full resize-y rounded-lg border border-input bg-card px-2.5 py-2 text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
          rows="5"
          value={String(field.value)}
          oninput={(event) => onValueChange(event.currentTarget.value)}
        ></textarea>
      {/if}
    </label>
    <div class="mt-[22px] flex justify-end gap-2.5">
      <button
        class="rounded-md border border-border bg-secondary px-2.5 py-1 font-medium text-secondary-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onclick={() => onAnswer(false)}
      >Cancel</button>
      <button
        class="rounded-md border border-primary bg-primary px-2.5 py-1 font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onclick={() => onAnswer(true)}
      >Continue</button>
    </div>
  </div>
</div>
