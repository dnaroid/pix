<script lang="ts">
  import CalendarClock from "@lucide/svelte/icons/calendar-clock";
  import {
    QUOTA_WAIT_DURATION_PRESETS,
    QUOTA_WAIT_MAX_SCHEDULE_MS,
    parseQuotaWaitDuration,
    formatQuotaWaitLocalDatetime,
    quotaWaitDatetimeDeadline,
    quotaWaitUntilCommand,
    quotaWaitTimezoneLabel,
  } from "../lib/quota-wait";
  import { activateModalDialog } from "../lib/modal-dialog";

  let {
    sessionId,
    timezoneLabel = quotaWaitTimezoneLabel(),
    onSubmit,
    onCancel,
  }: {
    sessionId: string;
    timezoneLabel?: string;
    /** Sends the fully built `/wait …` command out-of-band. */
    onSubmit: (sessionId: string, command: string) => void;
    onCancel: (sessionId: string) => void;
  } = $props();

  type ScheduleMode = "duration" | "datetime" | "usage-reset";

  let dialogElement = $state<HTMLDialogElement | null>(null);
  let durationField = $state<HTMLInputElement | null>(null);
  let mode = $state<ScheduleMode>("duration");
  let durationInput = $state("");
  let datetimeInput = $state("");
  let nowMs = $state(Date.now());

  $effect(() => {
    const ticker = setInterval(() => { nowMs = Date.now(); }, 1000);
    return () => clearInterval(ticker);
  });

  $effect(() => {
    const dialog = dialogElement;
    if (!dialog) return;
    return activateModalDialog(dialog, () => durationField);
  });

  const durationMs = $derived(parseQuotaWaitDuration(durationInput));
  const durationError = $derived.by(() => {
    if (mode !== "duration" || !durationInput.trim()) return "";
    return durationMs === undefined ? "Use a duration like 1h20m (1s–32d)." : "";
  });
  const deadline = $derived(quotaWaitDatetimeDeadline(datetimeInput, nowMs));
  const datetimeError = $derived.by(() => {
    if (mode !== "datetime" || deadline.kind === "ok" || deadline.kind === "empty") return "";
    if (deadline.kind === "invalid") return "Enter a valid local date and time.";
    if (deadline.kind === "past") return "That time is already in the past.";
    return "Choose a time within the next 32 days.";
  });
  const canConfirm = $derived(mode === "usage-reset"
    || (mode === "duration" && durationMs !== undefined)
    || (mode === "datetime" && deadline.kind === "ok"));

  const datetimeMin = $derived(formatQuotaWaitLocalDatetime(nowMs));
  const datetimeMax = $derived(formatQuotaWaitLocalDatetime(nowMs + QUOTA_WAIT_MAX_SCHEDULE_MS));

  function confirmSchedule(): void {
    if (!canConfirm) return;
    if (mode === "usage-reset") {
      onSubmit(sessionId, "/wait usage-reset");
      return;
    }
    if (mode === "duration") {
      if (durationMs === undefined) return;
      onSubmit(sessionId, `/wait ${durationInput.trim()}`);
      return;
    }
    const currentDeadline = quotaWaitDatetimeDeadline(datetimeInput, Date.now());
    if (currentDeadline.kind !== "ok") return;
    onSubmit(sessionId, quotaWaitUntilCommand(currentDeadline.date));
  }
</script>

<dialog
  bind:this={dialogElement}
  class="fixed inset-0 z-50 m-auto h-screen max-h-none w-screen max-w-none place-items-center bg-transparent p-6 text-foreground backdrop:bg-overlay open:grid"
  aria-labelledby="quota-wait-schedule-title"
  data-quota-wait-schedule-popup={sessionId}
  oncancel={(event) => { event.preventDefault(); onCancel(sessionId); }}
  onclick={(event) => { if (event.target === event.currentTarget) onCancel(sessionId); }}
>
  <form
    class="w-[min(460px,100%)] rounded-lg border border-border bg-popover p-5 text-popover-foreground shadow-md"
    aria-labelledby="quota-wait-schedule-title"
    onsubmit={(event) => { event.preventDefault(); confirmSchedule(); }}
  >
    <div class="flex items-start gap-3">
      <CalendarClock class="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <span class="text-xs font-semibold tracking-[0.08em] text-primary uppercase">Scheduled continuation</span>
        <h2 id="quota-wait-schedule-title" class="mt-1 text-sm leading-snug font-medium text-foreground">Schedule continuation…</h2>
        <p class="mt-1.5 text-xs text-muted-foreground">
          Pause this session and continue it automatically later. The current task pauses at a safe point; your composer draft is preserved.
        </p>
      </div>
    </div>

    <fieldset class="mt-4 space-y-1.5" data-quota-wait-schedule-modes>
      <legend class="sr-only">Continuation schedule</legend>
      <label
        class={["flex min-h-8 cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring", mode === "duration" ? "bg-panel-selected" : ""]}
      >
        <input
          class="mt-0.5 accent-primary"
          type="radio"
          name="quota-wait-schedule-mode"
          value="duration"
          bind:group={mode}
        />
        <span class="min-w-0 flex-1">
          <span class="block font-medium text-foreground">After a duration</span>
          <span class="mt-0.5 block text-muted-foreground">Continue in a fixed delay, e.g. 1h20m.</span>
          {#if mode === "duration"}
            <span class="mt-2 block">
              <input
                bind:this={durationField}
                class="h-8 w-full rounded-md border border-input bg-background px-2.5 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
                type="text"
                inputmode="text"
                autocomplete="off"
                spellcheck="false"
                placeholder="e.g. 1h20m"
                aria-label="Continuation delay"
                aria-invalid={durationError ? "true" : undefined}
                data-quota-wait-schedule-duration
                bind:value={durationInput}
              />
              <span class="mt-1.5 flex flex-wrap gap-1.5">
                {#each QUOTA_WAIT_DURATION_PRESETS as preset (preset)}
                  <button
                    class="h-6 rounded-md border border-border px-2 font-mono text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    type="button"
                    data-quota-wait-schedule-preset={preset}
                    onclick={() => { durationInput = preset; }}
                  >{preset}</button>
                {/each}
              </span>
              {#if durationError}
                <span class="mt-1.5 block text-destructive" role="alert">{durationError}</span>
              {/if}
            </span>
          {/if}
        </span>
      </label>

      <label
        class={["flex min-h-8 cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring", mode === "datetime" ? "bg-panel-selected" : ""]}
      >
        <input
          class="mt-0.5 accent-primary"
          type="radio"
          name="quota-wait-schedule-mode"
          value="datetime"
          bind:group={mode}
        />
        <span class="min-w-0 flex-1">
          <span class="block font-medium text-foreground">At a specific time</span>
          <span class="mt-0.5 block text-muted-foreground">Local time ({timezoneLabel}); up to 32 days ahead.</span>
          {#if mode === "datetime"}
            <span class="mt-2 block">
              <input
                class="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs text-foreground outline-none focus:border-ring focus:ring-2 focus:ring-ring/20"
                type="datetime-local"
                aria-label="Continuation date and time"
                aria-invalid={datetimeError ? "true" : undefined}
                data-quota-wait-schedule-datetime
                min={datetimeMin}
                max={datetimeMax}
                bind:value={datetimeInput}
              />
              {#if datetimeError}
                <span class="mt-1.5 block text-destructive" role="alert">{datetimeError}</span>
              {/if}
            </span>
          {/if}
        </span>
      </label>

      <label
        class={["flex min-h-8 cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring", mode === "usage-reset" ? "bg-panel-selected" : ""]}
      >
        <input
          class="mt-0.5 accent-primary"
          type="radio"
          name="quota-wait-schedule-mode"
          value="usage-reset"
          bind:group={mode}
        />
        <span class="min-w-0 flex-1">
          <span class="block font-medium text-foreground">On usage reset</span>
          <span class="mt-0.5 block text-muted-foreground">Continue when the provider reports quota available again.</span>
        </span>
      </label>
    </fieldset>

    <div class="mt-5 flex flex-wrap justify-end gap-2">
      <button
        class="h-8 rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        type="button"
        data-quota-wait-schedule-cancel
        onclick={() => onCancel(sessionId)}
      >Cancel</button>
      <button
        class="inline-flex h-8 min-w-20 items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
        type="submit"
        disabled={!canConfirm}
        data-quota-wait-schedule-confirm
      >Schedule</button>
    </div>
  </form>
</dialog>
