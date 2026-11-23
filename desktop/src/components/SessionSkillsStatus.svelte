<script lang="ts">
  import GraduationCap from "@lucide/svelte/icons/graduation-cap";
  import LoaderCircle from "@lucide/svelte/icons/loader-circle";
  import { onDestroy } from "svelte";
  import type { FindSessionSkills, SessionSkillsResult } from "../lib/session-skills";
  import StatusBarPopover from "./StatusBarPopover.svelte";

  let { sessionId, findSkills }: {
    sessionId: string;
    findSkills: FindSessionSkills;
  } = $props();
  let result = $state<SessionSkillsResult>();
  let loading = $state(false);
  const lifetime = new AbortController();
  onDestroy(() => { lifetime.abort(); });

  async function search() {
    if (loading) return;
    loading = true;
    const next = await findSkills(sessionId, lifetime.signal);
    if (lifetime.signal.aborted) return;
    result = next;
    loading = false;
  }
</script>

<StatusBarPopover label="Loaded skills" onOpen={() => { void search(); }}>
  {#snippet trigger({ open, toggle, id })}
    <button
      class={[
        "flex h-6 items-center rounded-sm bg-transparent px-1.5 transition-colors hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        open && "bg-chrome-hover",
      ]}
      type="button"
      aria-label="Loaded skills"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={id}
      onclick={toggle}
    >
      <GraduationCap class="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  {/snippet}

  <div class="rounded-md border border-border bg-popover text-popover-foreground shadow-md">
    <h2 class="border-b border-border px-2.5 py-1.5 text-xs font-semibold">Loaded skills</h2>
    {#if loading}
      <p class="flex items-center gap-1.5 px-2.5 py-1.5 text-muted-foreground" role="status">
        <LoaderCircle class="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        Searching session…
      </p>
    {:else if result}
      {#if result.names.length}
        <ul class="max-h-60 overflow-y-auto px-2.5 py-1.5 font-mono">
          {#each result.names as name (name)}
            <li class="break-words py-0.5">{name}</li>
          {/each}
        </ul>
      {:else if result.source !== "error"}
        <p class="px-2.5 py-1.5 text-muted-foreground">No skill loads found.</p>
      {/if}
      <p class="border-t border-border px-2.5 py-1.5 text-muted-foreground">
        {result.source === "file" ? "From the session file and loaded chat" : result.source === "chat"
          ? "From loaded chat history" : "Could not search the session file. Showing loaded chat only."}
      </p>
    {/if}
  </div>
</StatusBarPopover>
