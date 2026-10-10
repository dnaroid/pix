<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { onMount, tick } from "svelte";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import Mic from "@lucide/svelte/icons/mic";
  import Square from "@lucide/svelte/icons/square";
  import { browserDeepgramSupported, DeepgramDictationController, type DeepgramDictationState, type DeepgramToken } from "../lib/deepgram";
  import { SearchVoiceController, insertSearchTranscript } from "../lib/search-voice-controller";
  import { taskTypeLabel } from "../lib/project-tasks";
  import { QUICK_TASK_MAX_LENGTH } from "../../../acp/src/tasks/type-classification-contract";
  import { TaskQuickAddController, type QuickTaskDraft, type TaskTypeClient } from "../lib/task-quick-add-controller";

  let { workspace, client = null, busy = false, onCreate }: {
    workspace: string;
    client?: TaskTypeClient | null;
    busy?: boolean;
    onCreate: (draft: QuickTaskDraft) => Promise<boolean | void> | boolean | void;
  } = $props();

  let text = $state("");
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let sending = $state(false);
  let notice = $state("");
  let error = $state("");
  let voiceSupported = $state(false);
  let voiceState = $state<DeepgramDictationState>("idle");
  let voiceInterim = $state("");
  let voiceError = $state("");
  let voice: SearchVoiceController | undefined;
  let generation = 0;
  let disposed = false;
  const creation = new TaskQuickAddController();

  function cancelPending() {
    generation++;
    creation.cancel();
    voice?.cancel();
    sending = false;
    voiceError = "";
    voiceInterim = "";
  }

  function reset() {
    cancelPending();
    text = "";
    notice = "";
    error = "";
  }

  onMount(() => {
    voiceSupported = browserDeepgramSupported();
    voice = new SearchVoiceController(
      callbacks => new DeepgramDictationController(callbacks, () => invoke<DeepgramToken>("deepgram_token")),
      {
        onState: next => { voiceState = next; },
        onInterim: next => { voiceInterim = next ?? ""; },
        onError: next => { voiceError = next; },
        onFinal: next => {
          const input = textarea;
          const insertion = insertSearchTranscript(text, next, input?.selectionStart ?? text.length, input?.selectionEnd ?? text.length);
          text = insertion.query;
          const currentGeneration = generation;
          void tick().then(() => {
            if (!disposed && generation === currentGeneration && textarea === input && text === insertion.query) {
              input?.setSelectionRange(insertion.caret, insertion.caret);
            }
          });
        },
      },
    );
    return () => {
      disposed = true;
      generation++;
      creation.cancel();
      voice?.dispose();
    };
  });

  let previousWorkspace: string | undefined;
  let previousClient: TaskTypeClient | null | undefined;
  $effect(() => {
    const currentWorkspace = workspace;
    const currentClient = client;
    if (previousWorkspace !== undefined) {
      if (previousWorkspace !== currentWorkspace) reset();
      else if (previousClient !== currentClient) {
        // Reconnecting ACP must not erase unsent task text.
        cancelPending();
        notice = "";
      }
    }
    previousWorkspace = currentWorkspace;
    previousClient = currentClient;
  });

  function manualInput() {
    if (voiceState !== "idle") voice?.cancel();
    notice = "";
    error = "";
  }

  async function toggleVoice() {
    voiceError = "";
    await voice?.toggle();
    if (!disposed) textarea?.focus();
  }

  async function submit() {
    if (sending || busy || !workspace) return;
    const owner = ++generation;
    const ownerWorkspace = workspace;
    const ownerClient = client;
    sending = true;
    notice = "";
    error = "";
    const finalized = voice ? await voice.stop() : true;
    if (!finalized || disposed || owner !== generation || workspace !== ownerWorkspace || client !== ownerClient) {
      if (owner === generation) sending = false;
      return;
    }
    const draftText = text;
    if (!draftText.trim()) { sending = false; return; }
    const result = await creation.submit(draftText, ownerWorkspace, ownerClient, onCreate,
      () => !disposed && owner === generation && workspace === ownerWorkspace && client === ownerClient && !busy);
    if (disposed || owner !== generation || workspace !== ownerWorkspace || client !== ownerClient) return;
    sending = false;
    if (result.status === "created") {
      text = "";
      notice = result.fallback
        ? `Added as ${taskTypeLabel(result.type)} · Jev unavailable`
        : `Added as ${taskTypeLabel(result.type)}`;
      await tick();
      if (!disposed && owner === generation) textarea?.focus();
    } else if (result.status === "failed") {
      error = "Could not save task. Text is preserved; try again.";
    } else if (result.status === "busy") {
      error = "Tasks are busy. Text is preserved; try again.";
    }
  }
</script>

<section class="border-b border-sidebar-border px-2 py-2" aria-label="Quick add task" data-task-quick-add>
  <form onsubmit={(event) => { event.preventDefault(); void submit(); }} class="flex min-w-0 items-end gap-1 rounded-md border border-input bg-panel-strong px-1 py-0.5 focus-within:ring-2 focus-within:ring-ring/30">
    <textarea
      bind:this={textarea} bind:value={text} rows="1" maxlength={QUICK_TASK_MAX_LENGTH}
      aria-label="New task text" placeholder="Add a task…" disabled={sending || busy}
      oninput={manualInput}
      onkeydown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit(); } }}
      class="min-h-7 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-xs leading-4 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-50"
    ></textarea>
    {#if voiceSupported}
      <button type="button" onclick={() => void toggleVoice()} disabled={sending || busy} aria-pressed={voiceState !== "idle"}
        aria-label={voiceState === "idle" ? "Dictate task" : "Stop task dictation"}
        title={voiceState === "idle" ? "Dictate task · audio sent to Deepgram" : "Stop dictation"}
        class={["grid h-7 w-7 shrink-0 place-items-center rounded text-muted-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40", voiceState !== "idle" && "text-primary"]}>
        {#if voiceState === "starting"}<LoaderCircle class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />{:else if voiceState === "listening"}<Square class="h-3.5 w-3.5" aria-hidden="true" />{:else}<Mic class="h-3.5 w-3.5" aria-hidden="true" />{/if}
      </button>
    {/if}
    <button type="submit" disabled={sending || busy || (!text.trim() && voiceState === "idle")}
      aria-label="Create task" title="Create task · Enter (Shift+Enter for new line) · Task text sent to OpenRouter Jev for type classification"
      class="grid h-7 w-7 shrink-0 place-items-center rounded bg-primary text-primary-foreground hover:brightness-110 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40">
      {#if sending}<LoaderCircle class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />{:else}<ArrowUp class="h-3.5 w-3.5" aria-hidden="true" />{/if}
    </button>
  </form>
  {#if sending}<p class="mt-1 text-xs text-muted-foreground" role="status">Classifying and saving task…</p>
  {:else if voiceState !== "idle"}<p class="mt-1 text-xs text-muted-foreground" role="status">{voiceState === "starting" ? "Starting microphone…" : "Listening…"} {voiceInterim}</p>
  {:else if error || voiceError}<p class="mt-1 text-xs text-tool-error" role="alert">{error || voiceError}</p>
  {:else if notice}<p class="mt-1 text-xs text-muted-foreground" role="status">{notice}</p>{/if}
</section>
