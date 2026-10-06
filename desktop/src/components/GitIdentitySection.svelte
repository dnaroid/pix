<script lang="ts">
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import { invoke } from "@tauri-apps/api/core";
  import { onDestroy } from "svelte";
  import { createGitIdentityEditor, type GitIdentity } from "../lib/git-identity-editor.svelte";

  let { workspace, busy, onSave }: { workspace: string; busy: boolean; onSave: (name: string, email: string) => Promise<boolean> } = $props();
  const editor = createGitIdentityEditor(() => invoke<GitIdentity>("git_identity", { workspace }), (name, email) => onSave(name, email));
  onDestroy(editor.dispose);
  const input = "h-7 w-full min-w-0 rounded-md border border-input bg-panel-strong px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50";
</script>

<details class="group/identity border-t border-sidebar-border bg-panel" ontoggle={(event) => { if (event.currentTarget.open && !editor.identity) void editor.load(); }}>
  <summary class="flex h-8 items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:bg-panel-hover hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
    <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform group-open/identity:rotate-90 motion-reduce:transition-none" aria-hidden="true" />Commit author
  </summary>
  <form class="space-y-2 px-2 pb-3" onsubmit={(event) => { event.preventDefault(); if (!busy) void editor.save(); }}>
    <p class="text-xs leading-4 text-muted-foreground">Name and email for new commits. Saved only in this repository; global settings and existing commits stay unchanged. This does not change your sign-in account. Environment overrides are not shown.</p>
    {#if editor.loading}<p class="text-xs text-muted-foreground" role="status">Loading commit author…</p>{/if}
    <label class="block space-y-1 text-xs">Name
      <input class={input} bind:value={editor.name} disabled={busy || editor.loading || editor.saving || !editor.identity} autocomplete="off" />
      {#if editor.identity}<span class="block text-muted-foreground">{editor.identity.localName === null || editor.identity.localName !== editor.identity.name ? "Inherited from Git settings" : "Repository override"}</span>{/if}
    </label>
    <label class="block space-y-1 text-xs">Email
      <input class={input} type="text" inputmode="email" bind:value={editor.email} disabled={busy || editor.loading || editor.saving || !editor.identity} autocomplete="off" />
      {#if editor.identity}<span class="block text-muted-foreground">{editor.identity.localEmail === null || editor.identity.localEmail !== editor.identity.email ? "Inherited from Git settings" : "Repository override"}</span>{/if}
    </label>
    {#if editor.error}<p class="text-xs leading-4 text-tool-error break-words" role="alert">{editor.error}</p>{/if}
    {#if editor.saved}<p class="text-xs text-tool-success" role="status">Saved for this repository.</p>{/if}
    <div class="flex items-center gap-1.5">
      <button class="inline-flex h-7 items-center justify-center rounded-md border border-border bg-panel-strong px-2 text-xs hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="submit" disabled={busy || editor.loading || editor.saving || !editor.identity || !editor.name.trim() || !editor.email.trim()}>{editor.saving ? "Saving…" : "Save for repository"}</button>
      <button class="h-7 rounded-sm px-2 text-xs text-muted-foreground hover:bg-panel-hover focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" disabled={busy || editor.loading || editor.saving} onclick={() => void editor.load()}>Reload</button>
    </div>
  </form>
</details>
