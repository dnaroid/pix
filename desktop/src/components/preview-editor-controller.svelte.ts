import type { ProjectFilePreview } from "../lib/project-files";

interface PreviewEditorControllerOptions {
  readonly previewId: () => number;
  readonly file: () => ProjectFilePreview | undefined;
  readonly editable: () => boolean;
  readonly renderAsMarkdown: () => boolean;
  readonly onSaveProjectFile: () => ((path: string, content: string) => Promise<boolean>) | undefined;
  readonly onDirtyChange: () => ((dirty: boolean) => void) | undefined;
}

export function createPreviewEditorController(options: PreviewEditorControllerOptions) {
  const state = $state({
    editing: false,
    draft: "",
    saving: false,
  });

  function canEdit(): boolean {
    return Boolean(
      options.file()
      && options.renderAsMarkdown()
      && options.editable()
      && options.onSaveProjectFile(),
    );
  }

  function dirty(): boolean {
    const file = options.file();
    return Boolean(file && state.draft !== file.content);
  }

  $effect(() => {
    options.previewId();
    state.draft = options.file()?.content ?? "";
    state.editing = false;
    state.saving = false;
  });

  $effect(() => {
    options.onDirtyChange()?.(dirty());
  });

  function begin(): void {
    state.draft = options.file()?.content ?? "";
    state.editing = true;
  }

  function cancel(): void {
    state.draft = options.file()?.content ?? "";
    state.editing = false;
  }

  async function save(): Promise<void> {
    const file = options.file();
    const saveFile = options.onSaveProjectFile();
    if (!file || !canEdit() || !saveFile || state.saving || !dirty()) return;
    state.saving = true;
    try {
      const saved = await saveFile(file.path, state.draft);
      if (saved) state.editing = false;
    } finally {
      state.saving = false;
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
