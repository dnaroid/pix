<script lang="ts">
  let {
    promptText = $bindable(""),
    activeSessionId,
    ready,
    promptRunning,
    onSubmit,
    onCancel,
  }: {
    promptText?: string;
    activeSessionId: string | null;
    ready: boolean;
    promptRunning: boolean;
    onSubmit: () => void | Promise<void>;
    onCancel: () => void | Promise<void>;
  } = $props();

  let composerForm: HTMLFormElement | undefined;
  let textarea: HTMLTextAreaElement | undefined;

  function resizeComposer(): void {
    if (!textarea) return;

    textarea.style.height = "auto";
    const composerChromeHeight = composerForm ? composerForm.offsetHeight - textarea.offsetHeight : 0;
    const maxTextareaHeight = Math.max(24, window.innerHeight / 2 - composerChromeHeight);
    const height = Math.min(textarea.scrollHeight, maxTextareaHeight);

    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxTextareaHeight ? "auto" : "hidden";
  }

  $effect(() => {
    promptText;
    promptRunning;
    const frame = requestAnimationFrame(resizeComposer);
    return () => cancelAnimationFrame(frame);
  });

  function handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void onSubmit();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void onSubmit();
  }
</script>

<svelte:window onresize={resizeComposer} />

<form
  class="row-start-3 mx-2 mb-2 rounded-xl border border-border bg-card px-3 pt-2.5 pb-2 shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20"
  bind:this={composerForm}
  onsubmit={handleSubmit}
>
  <textarea
    class="block min-h-6 w-full resize-none overflow-y-hidden border-0 bg-transparent px-0.5 leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/80 disabled:cursor-default disabled:opacity-40"
    bind:this={textarea}
    bind:value={promptText}
    oninput={resizeComposer}
    onkeydown={handleKeydown}
    placeholder={activeSessionId ? "Ask Pix to change, explain, or investigate…" : "Start or load a conversation first"}
    disabled={!activeSessionId || !ready}
    rows="1"
  ></textarea>
  {#if promptRunning}
    <div class="flex justify-end text-[10px]">
      <button
        class="rounded-md border border-border bg-transparent px-2.5 py-1 font-medium text-destructive transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        type="button"
        onclick={onCancel}
      >Stop</button>
    </div>
  {/if}
</form>
