<script lang="ts">
  import File from "@lucide/svelte/icons/file";
  import Folder from "@lucide/svelte/icons/folder";
  import { projectEntryNameSelection, type ProjectEntryNameEdit } from "./project-explorer-name-editor.svelte";

  let { edit, depth, onSubmit, onCancel }: {
    edit: ProjectEntryNameEdit;
    depth: number;
    onSubmit: () => void;
    onCancel: (restoreFocus: boolean) => void;
  } = $props();
  const directory = $derived(edit.mode === "new-directory" || (edit.mode === "rename" && edit.entry.kind === "directory"));
  const label = $derived(edit.mode === "rename" ? "Rename entry" : directory ? "New folder name" : "New file name");

  function focusInput(input: HTMLInputElement): void {
    input.focus();
    input.setSelectionRange(0, projectEntryNameSelection(edit));
    input.scrollIntoView({ block: "nearest" });
  }
</script>

<div role="treeitem" aria-level={depth + 1} aria-label={label} aria-selected="false" data-project-entry-name-editor>
  <div class="flex h-7 min-w-0 items-center gap-1.5 pr-2" style:padding-left={`${4 + depth * 14 + 16 + 6}px`}>
    {#if directory}
      <Folder class="h-3.5 w-3.5 shrink-0 text-primary/75" aria-hidden="true" />
    {:else}
      <File class="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    {/if}
    <input
      use:focusInput
      bind:value={edit.value}
      class="h-6 min-w-0 flex-1 bg-panel-strong px-1 text-xs text-foreground outline-none"
      aria-label={label}
      aria-invalid={!!edit.error}
      aria-describedby={edit.error ? "project-entry-name-error" : undefined}
      autocomplete="off"
      spellcheck="false"
      oninput={() => { edit.error = null; }}
      onblur={() => onCancel(false)}
      onkeydown={(event) => {
        event.stopPropagation();
        if (event.isComposing) return;
        if (event.key === "Enter") { event.preventDefault(); onSubmit(); }
        else if (event.key === "Escape") { event.preventDefault(); onCancel(true); }
      }}
    />
  </div>
  {#if edit.error}
    <p id="project-entry-name-error" role="alert" class="pr-2 text-xs leading-4 text-tool-error" style:padding-left={`${4 + depth * 14 + 36}px`}>{edit.error}</p>
  {/if}
</div>
