<script lang="ts">
  import Paperclip from "@lucide/svelte/icons/paperclip";
  import X from "@lucide/svelte/icons/x";
  import type { SessionConfigOption } from "@agentclientprotocol/sdk";
  import type { Attachment } from "../lib/attachments";
  import {
    TASK_TYPES,
    taskTypeLabel,
    type ProjectTask,
    type ProjectTaskType,
  } from "../lib/project-tasks";
  import PromptComposer from "./PromptComposer.svelte";
  import TaskFieldSelect from "./TaskFieldSelect.svelte";
  import WorkspaceSidebarTaskModelControl from "./WorkspaceSidebarTaskModelControl.svelte";
  import WorkspaceSidebarTaskRelations from "./WorkspaceSidebarTaskRelations.svelte";

  let {
    editingTaskId,
    busy,
    title = $bindable(""),
    description = $bindable(""),
    editorAttachments,
    attachmentError = null,
    taskType = $bindable<ProjectTaskType>("feature"),
    editorParentId = $bindable(""),
    editorEpic = $bindable(false),
    editorLinks = $bindable<string[]>([]),
    editorRelatedTaskIds = $bindable<string[]>([]),
    editorModelRef = $bindable(""),
    tasks = [],
    configOptions = [],
    visibleModelRefs,
    rememberedThinkingByModel = {},
    onVisibleModelsChange = () => {},
    projectFileSuggestions = [],
    titleInput = $bindable<HTMLInputElement | null>(null),
    onChooseAttachments,
    onPasteAttachments,
    onRemoveAttachment,
    onOpenAttachment,
    onOpenRelatedTask = () => {},
    onOpenLink = () => {},
    onValidateProjectFile,
    onClose,
    onSubmit,
  }: {
    editingTaskId: string | null;
    busy: boolean;
    title: string;
    description: string;
    editorAttachments: Attachment[];
    attachmentError?: string | null;
    taskType: ProjectTaskType;
    editorParentId?: string;
    editorEpic?: boolean;
    editorLinks?: string[];
    editorRelatedTaskIds?: string[];
    editorModelRef?: string;
    tasks?: readonly ProjectTask[];
    configOptions?: readonly SessionConfigOption[];
    visibleModelRefs?: readonly string[];
    rememberedThinkingByModel?: Readonly<Record<string, string>>;
    onVisibleModelsChange?: (refs: readonly string[]) => Promise<void> | void;
    projectFileSuggestions?: readonly string[];
    titleInput: HTMLInputElement | null;
    onChooseAttachments: () => Promise<void>;
    onPasteAttachments: (files: readonly File[]) => Promise<void>;
    onRemoveAttachment: (id: string) => void;
    onOpenAttachment: (attachment: Attachment) => void;
    onOpenRelatedTask?: (task: ProjectTask) => void;
    onOpenLink?: (link: string) => void | Promise<void>;
    onValidateProjectFile?: (path: string) => Promise<boolean>;
    onClose: () => void;
    onSubmit: () => void;
  } = $props();

  const submitDisabled = $derived(
    busy || Boolean(attachmentError)
      || (!editingTaskId && !title.trim())
      || (!!editingTaskId && !title.trim() && !description.trim() && editorAttachments.length === 0),
  );
  const taskTypeOptions = TASK_TYPES.map((type) => ({ value: type, label: taskTypeLabel(type) }));
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
  <fieldset disabled={busy} class="min-h-0 min-w-0 space-y-3 overflow-y-auto border-0 p-3">
    <label class="block text-xs font-medium text-muted-foreground">Title<input class="mt-1 h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring" bind:this={titleInput} bind:value={title} maxlength="200" placeholder={editingTaskId ? "Optional for captured tasks" : undefined} required={!editingTaskId} /></label>
    <div class="space-y-1">
      <span class="block text-xs font-medium text-muted-foreground">Description</span>
      {#if attachmentError}
        <p class="text-xs text-tool-error" role="alert">Could not load task attachments: {attachmentError}. Close the editor and retry; saving is disabled to protect existing links.</p>
      {/if}
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
    <div class="space-y-1">
      <span class="block text-xs font-medium text-muted-foreground">Type</span>
      <TaskFieldSelect value={taskType} options={taskTypeOptions} ariaLabel="Task type" onChange={(value) => taskType = value as ProjectTaskType} />
    </div>
    <WorkspaceSidebarTaskModelControl
      bind:value={editorModelRef}
      {configOptions}
      {visibleModelRefs}
      {rememberedThinkingByModel}
      {onVisibleModelsChange}
      disabled={busy}
    />
    <WorkspaceSidebarTaskRelations
      {tasks}
      {editingTaskId}
      bind:parentId={editorParentId}
      bind:epic={editorEpic}
      bind:links={editorLinks}
      bind:relatedTaskIds={editorRelatedTaskIds}
      onOpenTask={onOpenRelatedTask}
      {onOpenLink}
      {projectFileSuggestions}
      {onValidateProjectFile}
    />
    <div class="flex items-center gap-1.5 border-t border-sidebar-border pt-3 text-xs font-medium text-muted-foreground"><Paperclip class="h-3.5 w-3.5" aria-hidden="true" />Attached files <span class="rounded-full bg-panel-strong px-1.5 font-mono text-xs font-normal">{editorAttachments.length}</span></div>
    <div class="flex justify-end gap-2 pt-1">
      <button class="h-9 rounded-md px-3 text-sm text-muted-foreground hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring" type="button" onclick={onClose}>Cancel</button>
      <button class="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40" type="button" onclick={onSubmit} disabled={submitDisabled}>{editingTaskId ? "Save" : "Add task"}</button>
    </div>
  </fieldset>
</div>
