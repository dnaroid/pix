<script lang="ts">
  import EllipsisVertical from "@lucide/svelte/icons/ellipsis-vertical";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import Mic from "@lucide/svelte/icons/mic";
  import type { DeepgramDictationState } from "../lib/deepgram";

  let {
    menuTrigger = $bindable<HTMLButtonElement | null>(null),
    menuOpen,
    voiceState,
    voiceSupported,
    voiceCanStart,
    promptRunning,
    promptEnhancing = false,
    canSubmit,
    submitLabel,
    onToggleMenu,
    onToggleVoice,
  }: {
    menuTrigger: HTMLButtonElement | null;
    menuOpen: boolean;
    voiceState: DeepgramDictationState;
    voiceSupported: boolean;
    voiceCanStart: boolean;
    promptRunning: boolean;
    promptEnhancing?: boolean;
    canSubmit: boolean;
    submitLabel?: string;
    onToggleMenu: () => void;
    onToggleVoice: () => void;
  } = $props();
</script>

<div class="relative shrink-0" data-composer-menu>
  <button
    bind:this={menuTrigger}
    class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    type="button"
    aria-label="More composer actions"
    title="More actions"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    onclick={onToggleMenu}
    disabled={promptEnhancing}
  >
    <EllipsisVertical class="h-4 w-4" aria-hidden="true" />
  </button>
</div>
<button
  class={[
    "grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40",
    voiceState === "listening"
      ? "text-destructive hover:bg-destructive/10"
      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
  ]}
  type="button"
  aria-label={voiceState === "listening" ? "Stop voice input" : voiceState === "starting" ? "Connecting voice input" : "Start voice input"}
  title={voiceState === "listening" ? "Stop voice input" : voiceState === "starting" ? "Connecting to Deepgram…" : voiceSupported ? "Voice input" : "Voice input is unavailable in this WebView"}
  disabled={promptEnhancing || (voiceState === "idle" && !voiceCanStart)}
  onclick={onToggleVoice}
>
  {#if voiceState === "starting"}
    <LoaderCircle class="h-4 w-4 animate-spin" aria-hidden="true" />
  {:else}
    <Mic class="h-4 w-4" aria-hidden="true" />
  {/if}
</button>
<button
  class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-35"
  type="submit"
  aria-label={promptEnhancing ? "Improving prompt" : submitLabel ?? (promptRunning ? "Queue message" : "Send message")}
  title={promptEnhancing ? "Improving prompt…" : `${submitLabel ?? (promptRunning ? "Queue message" : "Send message")} · Enter`}
  disabled={promptEnhancing || !canSubmit}
>
  {#if promptEnhancing}
    <LoaderCircle class="h-4 w-4 animate-spin" aria-hidden="true" />
  {:else}
    <ArrowUp class="h-4 w-4" aria-hidden="true" />
  {/if}
</button>
