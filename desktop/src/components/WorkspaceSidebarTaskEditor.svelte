<script lang="ts">
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import X from "@lucide/svelte/icons/x";
  import type { Attachment } from "../lib/attachments";
  import {
    TASK_TYPES,
    taskTypeLabel,
    type ProjectTaskType,
  } from "../lib/project-tasks";
  import PromptComposer from "./PromptComposer.svelte";

  let {
    editingTaskId,
    busy,
    title = $bindable(""),
    description = $bindable(""),
    editorAttachments,
    taskType = $bindable<ProjectTaskType>("feature"),
    titleInput = $bindable<HTMLInputElement | null>(null),
    onChooseAttachments,
    onPasteAttachments,
    onRemoveAttachment,
    onOpenAttachment,
    onClose,
    onSubmit,
  }: {
    editingTaskId: string | null;
    busy: boolean;
    title: string;
    description: string;
    editorAttachments: Attachment[];
    taskType: ProjectTaskType;
    titleInput: HTMLInputElement | null;
    onChooseAttachments: () => Promise<void>;
    onPasteAttachments: (files: readonly File[]) => Promise<void>;
    onRemoveAttachment: (id: string) => void;
    onOpenAttachment: (attachment: Attachment) => void;
    onClose: () => void;
    onSubmit: () => void;
  } = $props();

  const submitDisabled = $derived(
    busy
      || (!editingTaskId && !title.trim())
      || (!!editingTaskId && !title.trim() && !description.trim() && editorAttachments.length === 0),
  );
</script>

<div
  class="absolute inset-y-0 right-0 left-12 z-20 grid min-h-0 grid-rows-[36px_minmax(0,1fr)] border-r border-sidebar-border bg-sidebar"
  role="dialog"
  aria-modal="true"
  aria-label={editingTaskId ? "Edit task" : "Add task"}
>
  <div class="flex items-center justify-between border-b border-sidebar-border px-3">
    <strong class="text-sm font-semibold">{editingTaskId ? "Edit task" : "Add task"}</strong>
    <button class="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring" type="button" aria-label="Close task editor" onclick={onClose}><X class="h-4 w-4" aria-hidden="true" /></button>
  </div>
  <div class="min-h-0 space-y-3 overflow-y-auto p-3">
    <label class="block text-xs font-medium text-muted-foreground">Title<input class="mt-1 h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring" bind:this={titleInput} bind:value={title} maxlength="200" placeholder={editingTaskId ? "Optional for captured tasks" : undefined} required={!editingTaskId} /></label>
    <div class="space-y-1">
      <span class="block text-xs font-medium text-muted-foreground">Description</span>
      <PromptComposer
        bind:promptText={description}
        attachments={editorAttachments}
        variant="editor"
        placeholder="Describe the task…"
        ariaLabel="Task description"
        activeSessionId={null}
        ready={!busy}
        promptRunning={false}
        dragActive={false}
        autocompleteEnabled={false}
        autocompleteDebounceMs={0}
        onAutocomplete={async () => ""}
        onSubmit={() => {}}
        onDefer={() => {}}
        onCancel={() => {}}
        onChooseAttachments={onChooseAttachments}
        onPasteAttachments={onPasteAttachments}
        onRemoveAttachment={onRemoveAttachment}
        onOpenAttachment={onOpenAttachment}
      />
    </div>
    <label class="block text-xs font-medium text-muted-foreground">Type<span class="relative mt-1 block"><select class="h-9 w-full appearance-none rounded-md border border-input bg-background py-0 pr-8 pl-2.5 text-sm text-foreground shadow-none hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" bind:value={taskType}>{#each TASK_TYPES as type}<option value={type}>{taskTypeLabel(type)}</option>{/each}</select><ChevronDown class="pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /></span></label>
    <div class="flex justify-end gap-2 pt-1">
      <button class="h-9 rounded-md px-3 text-sm text-muted-foreground hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring" type="button" onclick={onClose}>Cancel</button>
      <button class="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" onclick={onSubmit} disabled={submitDisabled}>{editingTaskId ? "Save" : "Add task"}</button>
    </div>
  </div>
</div>
