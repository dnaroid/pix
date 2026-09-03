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

  function handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
    void onSubmit();
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    void onSubmit();
  }
</script>

<form
  class="row-start-3 mx-[22px] mb-3.5 rounded-xl border border-border bg-card px-3 pt-2.5 pb-2 shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20 max-[760px]:mx-3"
  onsubmit={handleSubmit}
>
  <textarea
    class="block min-h-[42px] w-full resize-none border-0 bg-transparent px-0.5 leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/80 disabled:cursor-default disabled:opacity-40"
    bind:value={promptText}
    onkeydown={handleKeydown}
    placeholder={activeSessionId ? "Ask Pix to change, explain, or investigate…" : "Start or load a conversation first"}
    disabled={!activeSessionId || !ready}
    rows="2"
  ></textarea>
  <div class="flex items-center justify-between text-[10px] text-muted-foreground">
    <span>⌘/Ctrl + Enter to send</span>
    {#if promptRunning}
      <button
        class="rounded-md border border-border bg-transparent px-2.5 py-1 font-medium text-destructive transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        type="button"
        onclick={onCancel}
      >Stop</button>
    {:else}
      <button
        class="rounded-md border border-transparent bg-primary px-2.5 py-1 font-medium text-primary-foreground transition-opacity before:content-['↵_'] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-40"
        type="submit"
        disabled={!activeSessionId || !promptText.trim()}
      >Send</button>
    {/if}
  </div>
</form>
