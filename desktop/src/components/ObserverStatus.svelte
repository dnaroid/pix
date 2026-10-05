<script lang="ts">
  import Binoculars from "@lucide/svelte/icons/binoculars";
  import SettingsSwitch from "./settings/SettingsSwitch.svelte";
  import type { HeadsUpSnapshot } from "../lib/heads-up";
  import { observerDuration, observerPopoverPosition, observerResultLabel, observerStatus, observerTime } from "../lib/observer-status";

  let {
    sessionId, runtimeReady, snapshot, pendingToggle = false, pendingCheck = false,
    onToggle = () => {}, onCheck = () => {}, onRequestSnapshot = () => {}, onOpenSettings = () => {},
  }: {
    sessionId: string | null;
    runtimeReady: boolean;
    snapshot?: HeadsUpSnapshot;
    pendingToggle?: boolean;
    pendingCheck?: boolean;
    onToggle?: () => void;
    onCheck?: () => void;
    onRequestSnapshot?: () => void;
    onOpenSettings?: () => void;
  } = $props();

  const componentId = $props.id();
  const popupId = componentId + "-observer";
  let open = $state(false);
  let trigger = $state<HTMLButtonElement | null>(null);
  let popup = $state<HTMLDialogElement | null>(null);
  let owner = $state<{ sessionId: string | null; instanceId?: string } | null>(null);
  let now = $state(Date.now());
  let position = $state({ left: 8, bottom: 34, width: 384, maxHeight: 500 });
  const status = $derived(observerStatus(snapshot, runtimeReady, sessionId, now));
  const canControl = $derived(Boolean(sessionId && runtimeReady && snapshot));
  const iconColor = $derived.by(() => {
    if (!canControl || status.kind === "off") return "text-muted-foreground/70";
    if (status.kind === "limited") return "text-tool-warning";
    return "text-primary";
  });
  const canCheck = $derived(canControl && snapshot!.enabled && snapshot!.phase !== "checking" && !pendingToggle && !pendingCheck);

  $effect(() => {
    if (!open || !owner) return;
    if (owner.sessionId !== sessionId || (owner.instanceId && owner.instanceId !== snapshot?.instanceId)) {
      closePopup(false);
    } else if (!owner.instanceId && snapshot?.instanceId) {
      // A first snapshot arriving while the loading popup is open is not a replacement.
      owner = { sessionId, instanceId: snapshot.instanceId };
    }
  });
  $effect(() => {
    if (!runtimeReady && open && owner?.instanceId) closePopup(false);
  });
  $effect(() => {
    if (!open) return;
    // Only display time advances here. This timer never starts model work.
    const timer = window.setInterval(() => now = Date.now(), 1000);
    return () => window.clearInterval(timer);
  });

  function reposition(): void {
    if (open && trigger) position = observerPopoverPosition(trigger.getBoundingClientRect(), window.innerWidth, window.innerHeight);
  }
  function openPopup(): void {
    if (open) return;
    now = Date.now();
    owner = { sessionId, ...(snapshot ? { instanceId: snapshot.instanceId } : {}) };
    open = true;
    reposition();
    if (sessionId && runtimeReady) onRequestSnapshot();
  }
  function closePopup(restoreFocus = true): void {
    if (!open) return;
    // Restore while still open so focusin cannot reopen a dismissed panel.
    if (restoreFocus && popup?.contains(document.activeElement)) trigger?.focus();
    open = false;
  }
  function leavePopup(event: PointerEvent | FocusEvent): void {
    const region = event.currentTarget as HTMLElement;
    if (event.relatedTarget instanceof Node && region.contains(event.relatedTarget)) return;
    if (event.type === "pointerleave" && region.contains(document.activeElement)) return;
    if (event.type === "focusout" && region.matches(":hover")) return;
    closePopup(false);
  }
  function outside(event: PointerEvent): void {
    if (!open || !(event.target instanceof Node)) return;
    if (!popup?.contains(event.target) && !trigger?.contains(event.target)) closePopup(false);
  }
  function keydown(event: KeyboardEvent): void {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); closePopup();
    } else if (event.key === "Tab" && popup && popup.contains(document.activeElement)) {
      const items = [...popup.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
      const first = items[0]; const last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === popup)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first?.focus();
      }
    }
  }
  function settings(): void { closePopup(false); onOpenSettings(); }
</script>

<svelte:window onpointerdown={outside} onresize={reposition} />

<div class="shrink-0" data-observer-status role="group" aria-label="Observer"
  onpointerenter={openPopup} onpointerleave={leavePopup}
  onfocusin={openPopup} onfocusout={leavePopup}>
  <button bind:this={trigger} type="button" aria-label={`${status.label} · ${status.detail}`}
    aria-haspopup="dialog" aria-expanded={open} aria-controls={popupId} onclick={openPopup} onkeydown={keydown}
    class={["grid h-6 w-6 place-items-center rounded-sm transition-colors hover:bg-chrome-hover focus-visible:outline-2 focus-visible:outline-ring",
      iconColor]}>
    <Binoculars class={["h-4 w-4", status.kind === "checking" && "animate-pulse motion-reduce:animate-none"]} aria-hidden="true" />
  </button>

  {#if open}
    <dialog bind:this={popup} id={popupId} open tabindex="-1" aria-label="Observer status" onkeydown={keydown}
      style={`left:${position.left}px;bottom:${position.bottom}px;width:${position.width}px`}
      class="fixed z-50 m-0 overflow-visible border-0 bg-transparent p-0 text-left text-popover-foreground focus:outline-none">
      <div class="overflow-y-auto rounded-md border border-border bg-popover shadow-lg" style:max-height={`${position.maxHeight}px`}>
      <div class="flex items-start gap-2 border-b border-border px-3 py-2.5">
        <Binoculars class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div class="min-w-0 flex-1"><h2 class="text-sm font-medium">{status.label}</h2><p class="mt-0.5 text-xs leading-4 text-muted-foreground">{status.detail}</p></div>
      </div>
      <div class="space-y-3 px-3 py-3 text-xs">
        <div class="flex items-center justify-between gap-3 font-medium">
          <span>Observer for this session</span>
          <SettingsSwitch value={snapshot?.enabled ?? false} disabled={!canControl || pendingToggle} onChange={onToggle} ariaLabel="Observer for this session" />
        </div>
        {#if snapshot}
          <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 leading-4">
            <dt class="text-muted-foreground">Last check</dt><dd>{snapshot.details ? observerTime(snapshot.details.lastCheck?.finishedAt ?? snapshot.details.lastCheck?.startedAt ?? null) : "Unavailable in this runtime"}</dd>
            <dt class="text-muted-foreground">Result</dt><dd>{snapshot.details ? observerResultLabel(snapshot.details.lastCheck) : "Unavailable in this runtime"}{snapshot.details?.lastCheck?.durationMs != null ? ` · ${observerDuration(snapshot.details.lastCheck.durationMs)}` : ""}</dd>
            <dt class="text-muted-foreground">New turns</dt><dd>{snapshot.details?.newTurns ?? "Unavailable"}</dd>
            <dt class="text-muted-foreground">Checks</dt><dd>{snapshot.details ? `${snapshot.details.checksInWindow} in the past hour · ` : ""}{snapshot.checks} total</dd>
            <dt class="text-muted-foreground">Input used</dt><dd>{snapshot.details ? `${snapshot.details.inputCharsInWindow.toLocaleString()} chars in the past hour` : "Unavailable"}</dd>
            <dt class="text-muted-foreground">Recorded tokens</dt><dd>{snapshot.inputTokens.toLocaleString()} input/cache · {snapshot.outputTokens.toLocaleString()} output</dd>
          </dl>
        {:else}
          <p class="leading-4 text-muted-foreground">{sessionId ? "No Observer status has been received. A new or reloaded session may be needed." : "Start a session to enable Observer. You can set defaults in Settings."}</p>
        {/if}
      </div>
      <div class="flex items-center justify-end gap-2 border-t border-border px-3 py-2">
        <button type="button" class="h-7 rounded-sm px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" onclick={settings}>Observer settings</button>
        <button type="button" class="h-7 rounded-sm bg-primary px-2 text-xs text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40" disabled={!canCheck} onclick={onCheck}>{pendingCheck || snapshot?.phase === "checking" ? "Checking…" : "Check now"}</button>
      </div>
      </div>
    </dialog>
  {/if}
</div>
