<script lang="ts">
  import RotateCw from "@lucide/svelte/icons/rotate-cw";
  import X from "@lucide/svelte/icons/x";
  import { untrack } from "svelte";
  import { activateModalDialog } from "../lib/modal-dialog";
  import { normalizeProjectColor } from "../lib/project-colors";
  import { projectName } from "../lib/recent-projects";
  import ProjectFolderIcon from "./ProjectFolderIcon.svelte";

  let {
    workspace,
    color,
    saving,
    error,
    onSave,
    onClose,
  }: {
    workspace: string;
    color?: string;
    saving: boolean;
    error: string | null;
    onSave: (color: string | undefined) => void;
    onClose: () => void;
  } = $props();

  let dialogElement: HTMLDialogElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  let custom = $state(untrack(() => color !== undefined));
  let draftColor = $state(untrack(() => color ?? "#7aa2f7"));

  const normalizedColor = $derived(normalizeProjectColor(draftColor));
  const previewColor = $derived(custom ? normalizedColor : undefined);
  const saveDisabled = $derived(saving || (custom && !normalizedColor));

  $effect(() => {
    const dialog = dialogElement;
    if (!dialog) return;
    return activateModalDialog(dialog, () => closeButton);
  });

  function pickerColor(value: string): string {
    const normalized = normalizeProjectColor(value);
    if (!normalized) return "#7aa2f7";
    if (normalized.length === 4 || normalized.length === 5) {
      return `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`;
    }
    return normalized.slice(0, 7);
  }

  function chooseCustom(): void {
    custom = true;
    if (!normalizedColor) draftColor = "#7aa2f7";
  }

  function submit(): void {
    if (saveDisabled) return;
    onSave(custom ? normalizedColor : undefined);
  }

  function handleSubmit(event: SubmitEvent): void {
    event.preventDefault();
    submit();
  }
</script>

<dialog
  bind:this={dialogElement}
  class="fixed inset-0 z-50 m-auto h-screen max-h-none w-screen max-w-none place-items-center bg-transparent p-5 text-foreground backdrop:bg-overlay open:grid"
  aria-label="Project settings"
  oncancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}
  onclick={(event) => { if (!saving && event.target === event.currentTarget) onClose(); }}
>
  <form class="w-[430px] max-w-[calc(100vw-40px)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md" onsubmit={handleSubmit}>
    <header class="flex h-10 items-center gap-2 border-b border-border bg-chrome px-3">
      <ProjectFolderIcon project={workspace} color={previewColor} class="h-4 w-4 shrink-0" />
      <strong class="min-w-0 flex-1 truncate text-xs font-semibold">Project settings</strong>
      <button
        bind:this={closeButton}
        class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-chrome-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
        type="button"
        aria-label="Close project settings"
        disabled={saving}
        onclick={onClose}
      ><X class="h-3.5 w-3.5" aria-hidden="true" /></button>
    </header>

    <div class="space-y-4 p-4">
      <div class="min-w-0">
        <div class="truncate text-xs font-medium">{projectName(workspace)}</div>
        <div class="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={workspace}>{workspace}</div>
      </div>

      <section class="space-y-2" aria-labelledby="project-color-heading">
        <div>
          <h2 id="project-color-heading" class="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Identity color</h2>
          <p class="mt-1 text-[11px] leading-4 text-muted-foreground">Used by the project folder in the activity bar and project switcher.</p>
        </div>

        <div class="grid grid-cols-2 gap-2">
          <button
            class={["flex h-10 items-center gap-2 rounded-md border px-2.5 text-left focus-visible:outline-2 focus-visible:outline-ring", !custom ? "border-primary/60 bg-panel-selected" : "border-border bg-background hover:bg-accent"]}
            type="button"
            aria-pressed={!custom}
            onclick={() => custom = false}
          >
            <ProjectFolderIcon project={workspace} class="h-4 w-4 shrink-0" />
            <span class="min-w-0"><strong class="block text-[11px] font-medium">Automatic</strong><small class="block truncate text-[10px] text-muted-foreground">From project path</small></span>
          </button>
          <button
            class={["flex h-10 items-center gap-2 rounded-md border px-2.5 text-left focus-visible:outline-2 focus-visible:outline-ring", custom ? "border-primary/60 bg-panel-selected" : "border-border bg-background hover:bg-accent"]}
            type="button"
            aria-pressed={custom}
            onclick={chooseCustom}
          >
            <span class="h-4 w-4 shrink-0 rounded-sm border border-border" style:background-color={normalizedColor ?? "#7aa2f7"}></span>
            <span class="min-w-0"><strong class="block text-[11px] font-medium">Custom</strong><small class="block truncate text-[10px] text-muted-foreground">Workspace override</small></span>
          </button>
        </div>

        {#if custom}
          <div class="flex items-center gap-2 rounded-md border border-border bg-background p-2">
            <input
              class="h-8 w-10 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0.5"
              type="color"
              value={pickerColor(draftColor)}
              aria-label="Choose project color"
              oninput={(event) => draftColor = event.currentTarget.value}
            />
            <label class="min-w-0 flex-1">
              <span class="sr-only">Project color hex value</span>
              <input
                class="h-8 w-full rounded-md border border-input bg-background px-2 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                value={draftColor}
                maxlength="9"
                spellcheck="false"
                autocomplete="off"
                placeholder="#7aa2f7"
                oninput={(event) => draftColor = event.currentTarget.value}
              />
            </label>
          </div>
          {#if !normalizedColor}
            <p class="text-[10px] text-tool-error">Use #RGB, #RGBA, #RRGGBB, or #RRGGBBAA.</p>
          {/if}
        {/if}
      </section>

      <p class="font-mono text-[10px] text-muted-foreground">.pi/workspace.jsonc</p>
      {#if error}<p class="rounded-md border border-tool-error/30 bg-tool-error/5 px-2.5 py-2 text-[11px] leading-4 text-tool-error">{error}</p>{/if}
    </div>

    <footer class="flex h-12 items-center justify-end gap-2 border-t border-border bg-chrome/60 px-3">
      <button class="h-8 rounded-md px-3 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" disabled={saving} onclick={onClose}>Cancel</button>
      <button class="inline-flex h-8 min-w-20 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="submit" disabled={saveDisabled}>
        {#if saving}<RotateCw class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{/if}
        {saving ? "Saving…" : "Save"}
      </button>
    </footer>
  </form>
</dialog>
