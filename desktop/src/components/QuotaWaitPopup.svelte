<script lang="ts">
  import { dialogCancelButtonClass, dialogPrimaryButtonClass, modalBackdropClass } from "../lib/dialog";
  import Hourglass from "@lucide/svelte/icons/hourglass";
  import {
    formatQuotaWaitCountdown,
    quotaWaitCountdownSeconds,
    quotaWaitHeadline,
    type QuotaWaitState,
  } from "../lib/quota-wait";
  import { activateModalDialog } from "../lib/modal-dialog";

  let {
    sessionId,
    wait,
    nowMs,
    onRetry,
    onCancelAutoResume,
    onHide,
  }: {
    sessionId: string;
    wait: QuotaWaitState;
    nowMs: number;
    onRetry: (sessionId: string) => void;
    onCancelAutoResume: (sessionId: string) => void;
    onHide: (sessionId: string) => void;
  } = $props();

  let dialogElement = $state<HTMLDialogElement | null>(null);
  let primaryButton = $state<HTMLButtonElement | null>(null);

  $effect(() => {
    const dialog = dialogElement;
    if (!dialog) return;
    return activateModalDialog(dialog, () => primaryButton);
  });

  const headline = $derived(quotaWaitHeadline(wait, nowMs));
  const countdown = $derived(formatQuotaWaitCountdown(quotaWaitCountdownSeconds(wait, nowMs)));
  const scopeLabel = $derived(wait.window === "weekly"
    ? "weekly"
    : wait.window === "hourly" ? "hourly" : "usage");
</script>

<dialog
  bind:this={dialogElement}
  class={modalBackdropClass}
  aria-labelledby="quota-wait-title"
  data-quota-wait-popup={sessionId}
  oncancel={(event) => { event.preventDefault(); onHide(sessionId); }}
  onclick={(event) => { if (event.target === event.currentTarget) onHide(sessionId); }}
>
  <div class="w-[min(440px,100%)] rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-md" role="dialog" aria-labelledby="quota-wait-title">
    <div class="flex items-start gap-3">
      <Hourglass class="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <span class="text-xs font-semibold tracking-[0.08em] text-primary uppercase">Scheduled continuation</span>
        <h2 id="quota-wait-title" class="mt-1 text-sm leading-snug font-medium text-foreground">{headline}</h2>
        <p class="mt-1.5 text-xs text-muted-foreground">
          {#if wait.autoResume}
            {wait.mode === "timer" ? "Continuation" : `${scopeLabel} limit check`} in
            <span class="font-mono font-medium tabular-nums text-foreground" role="timer" aria-live="off" aria-atomic="true" data-quota-wait-countdown>{countdown}</span>
            {#if wait.attempt > 0}<span> · attempt {wait.attempt + 1}</span>{/if}
          {:else}
            Auto-resume is cancelled; the task stays paused.
          {/if}
        </p>
      </div>
    </div>
    <div class="mt-5 flex flex-wrap justify-end gap-2">
      {#if wait.autoResume}
        <button
          class={dialogCancelButtonClass}
          type="button"
          onclick={() => onCancelAutoResume(sessionId)}
        >Cancel auto-resume</button>
        <button
          bind:this={primaryButton}
          class={dialogPrimaryButtonClass}
          type="button"
          data-quota-wait-retry
          onclick={() => onRetry(sessionId)}
        >Try now</button>
      {:else}
        <button
          bind:this={primaryButton}
          class={dialogPrimaryButtonClass}
          type="button"
          data-quota-wait-retry
          onclick={() => onRetry(sessionId)}
        >Try now</button>
      {/if}
      <button
        class={dialogCancelButtonClass}
        type="button"
        data-quota-wait-hide
        onclick={() => onHide(sessionId)}
      >Hide</button>
    </div>
  </div>
</dialog>
