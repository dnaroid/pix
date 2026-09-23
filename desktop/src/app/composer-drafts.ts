import type { Attachment } from "../lib/attachments";

type ComposerDraft = {
  text: string;
  attachments: Attachment[];
};

type ComposerDraftStoreOptions = {
  workspace: () => string;
  promptText: () => string;
  promptAttachments: () => readonly Attachment[];
  setPromptText: (text: string) => void;
  replacePromptAttachments: (attachments: readonly Attachment[]) => void;
};

export function createComposerDraftStore(options: ComposerDraftStoreOptions) {
  const drafts = new Map<string, ComposerDraft>();

  function key(ownerId: string): string {
    return `${options.workspace()}\0${ownerId}`;
  }

  function save(ownerId: string | null | undefined): void {
    if (!ownerId || !options.workspace()) return;
    drafts.set(key(ownerId), {
      text: options.promptText(),
      attachments: [...options.promptAttachments()],
    });
  }

  function restore(ownerId: string, reset = false): void {
    const draftKey = key(ownerId);
    if (reset) drafts.delete(draftKey);
    const draft = drafts.get(draftKey);
    options.setPromptText(draft?.text ?? "");
    options.replacePromptAttachments(draft?.attachments ?? []);
  }

  function switchTo(
    sourceOwnerId: string | null | undefined,
    targetOwnerId: string,
    { resetTarget = false, preserveSource = true }: { resetTarget?: boolean; preserveSource?: boolean } = {},
  ): void {
    if (sourceOwnerId === targetOwnerId) {
      if (resetTarget) restore(targetOwnerId, true);
      return;
    }
    if (preserveSource) save(sourceOwnerId);
    else if (sourceOwnerId) forget(sourceOwnerId);
    restore(targetOwnerId, resetTarget);
  }

  function forget(ownerId: string): void {
    if (!options.workspace()) return;
    drafts.delete(key(ownerId));
  }

  function reset(): void {
    drafts.clear();
    options.setPromptText("");
    options.replacePromptAttachments([]);
  }

  return { save, restore, switchTo, forget, reset };
}
