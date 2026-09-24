<script lang="ts">
  import EllipsisVertical from "@lucide/svelte/icons/ellipsis-vertical";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import Mic from "@lucide/svelte/icons/mic";
  import Pause from "@lucide/svelte/icons/pause";
  import Play from "@lucide/svelte/icons/play";
  import Square from "@lucide/svelte/icons/square";
  import type { AgentControlState } from "../lib/agent-control";
  import type { DeepgramDictationState } from "../lib/deepgram";

  let {
    menuTrigger = $bindable<HTMLButtonElement | null>(null),
    menuOpen,
    voiceState,
    voiceSupported,
    voiceCanStart,
    promptRunning,
    agentControlState,
    canSubmit,
    onToggleMenu,
    onToggleVoice,
    onPause,
    onCancel,
    onContinue,
  }: {
    menuTrigger: HTMLButtonElement | null;
    menuOpen: boolean;
    voiceState: DeepgramDictationState;
    voiceSupported: boolean;
    voiceCanStart: boolean;
    promptRunning: boolean;
    agentControlState: AgentControlState;
    canSubmit: boolean;
    onToggleMenu: () => void;
    onToggleVoice: () => void;
    onPause?: () => void | Promise<void>;
    onCancel: () => void | Promise<void>;
    onContinue?: () => void | Promise<void>;
  } = $props();
</script>

<div class="relative shrink-0" data-composer-menu>
  <button
    bind:this={menuTrigger}
    class="grid h-7 w-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    type="button"
    aria-label="More composer actions"
    title="More actions"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    onclick={onToggleMenu}
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
  disabled={voiceState === "idle" && !voiceCanStart}
  onclick={onToggleVoice}
>
  {#if voiceState === "starting"}
    <LoaderCircle class="h-4 w-4 animate-spin" aria-hidden="true" />
  {:else}
    <Mic class="h-4 w-4" aria-hidden="true" />
  {/if}
</button>
{#if promptRunning}
  <button
    class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
    type="button"
    aria-label={agentControlState === "pause-requested" ? "Pause requested" : "Pause after current turn"}
    title={agentControlState === "pause-requested" ? "Pause requested" : "Pause after current turn"}
    disabled={agentControlState === "pause-requested" || agentControlState === "resuming"}
    onclick={onPause}
  >
    <Pause class="h-3.5 w-3.5" aria-hidden="true" />
  </button>
  <button
    class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-transparent text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    type="button"
    aria-label="Stop response"
    title="Stop response"
    onclick={onCancel}
  >
    <Square class="h-3 w-3 fill-current" aria-hidden="true" />
  </button>
{:else if agentControlState === "paused" || agentControlState === "continuable"}
  <button
    class="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    type="button"
    aria-label="Continue response"
    title="Continue response"
    onclick={onContinue}
  >
    <Play class="h-3.5 w-3.5 fill-current" aria-hidden="true" />
  </button>
{/if}
<button
  class="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-35"
  type="submit"
  aria-label={promptRunning ? "Queue message" : "Send message"}
  title={promptRunning ? "Queue message · Enter" : "Send message · Enter"}
  disabled={!canSubmit}
>
  <ArrowUp class="h-4 w-4" aria-hidden="true" />
</button>
