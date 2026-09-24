import { untrack } from "svelte";
import type { ProjectFilePreview } from "../lib/project-files";

interface PreviewEditorControllerOptions {
  readonly previewId: () => number;
  readonly file: () => ProjectFilePreview | undefined;
  readonly editable: () => boolean;
  readonly onSaveProjectFile: () => ((path: string, content: string) => Promise<boolean>) | undefined;
  readonly onDirtyChange: () => ((dirty: boolean) => void) | undefined;
}

export function createPreviewEditorController(options: PreviewEditorControllerOptions) {
  const state = $state({
    editing: false,
    draft: "",
    saving: false,
  });
  let sourceId = options.previewId();
  let sourcePath = options.file()?.path;
  let editGeneration = 0;

  function canEdit(): boolean {
    return Boolean(
      options.file()
      && options.editable()
      && options.onSaveProjectFile(),
    );
  }

  function dirty(): boolean {
    const file = options.file();
    return Boolean(state.editing && file && state.draft !== file.content);
  }

  function synchronizeSource(): void {
    const id = options.previewId();
    const file = options.file();
    const content = file?.content ?? "";
    untrack(() => {
      if (sourceId !== id || sourcePath !== file?.path) {
        editGeneration += 1;
        sourceId = id;
        sourcePath = file?.path;
        state.editing = false;
        state.saving = false;
      }
      // A save updates the loaded file before its promise settles. Keep text
      // typed during that write instead of replacing it with the saved snapshot.
      if (!state.editing) state.draft = content;
    });
  }

  $effect(synchronizeSource);
  $effect(() => () => { editGeneration += 1; });

  $effect(() => {
    options.onDirtyChange()?.(dirty());
  });

  function begin(): void {
    synchronizeSource();
    editGeneration += 1;
    state.saving = false;
    state.draft = options.file()?.content ?? "";
    state.editing = true;
  }

  function cancel(): void {
    editGeneration += 1;
    state.saving = false;
    state.draft = options.file()?.content ?? "";
    state.editing = false;
  }

  async function save(): Promise<void> {
    synchronizeSource();
    const file = options.file();
    const saveFile = options.onSaveProjectFile();
    if (!file || !canEdit() || !saveFile || state.saving || !dirty()) return;
    const generation = ++editGeneration;
    const previewId = options.previewId();
    const draft = state.draft;
    const isCurrent = () => generation === editGeneration
      && options.previewId() === previewId && options.file()?.path === file.path;
    state.saving = true;
    try {
      const saved = await saveFile(file.path, draft);
      if (saved && isCurrent() && state.draft === draft) state.editing = false;
    } finally {
      if (isCurrent()) state.saving = false;
    }
  }

  function handleKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
      return;
    }
    if (event.key === "Escape" && !event.isComposing) {
      event.preventDefault();
      cancel();
    }
  }

  function canClose(): boolean {
    return !(state.editing && dirty()) || window.confirm("Discard unsaved changes?");
  }

  return {
    state,
    get canEdit() { return canEdit(); },
    get dirty() { return dirty(); },
    begin,
    cancel,
    save,
    handleKeydown,
    canClose,
  };
}
