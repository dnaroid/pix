import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  MAX_ATTACHMENTS,
  MAX_EMBEDDED_ATTACHMENT_BYTES,
  attachmentFromFile,
  attachmentKind,
  mimeTypeForName,
  type Attachment,
  type AttachmentFile,
} from "../lib/attachments";
import {
  cachePastedAttachment,
  cachePastedTaskAttachment,
} from "./attachment-io";

type AttachmentDraftControllerOptions = {
  workspace: () => string;
  activeSessionId: () => string | null;
  draftSessionTabActive: () => boolean;
  sessionMutationRunning: () => boolean;
  operationRunning: () => boolean;
  attachmentDraftKey: () => string;
  promptAttachments: () => Attachment[];
  setPromptAttachments: (attachments: Attachment[]) => void;
  setErrorMessage: (message: string) => void;
  reportError: (error: unknown) => void;
};

export function createAttachmentDraftController(options: AttachmentDraftControllerOptions) {
  let sequence = 0;
  let generation = 0;
  const addQueues = new Map<string, Promise<void>>();

  function nextAttachmentId(): string {
    sequence += 1;
    return `local-attachment:${sequence}`;
  }

  async function chooseTaskAttachments(current: readonly Attachment[]): Promise<Attachment[]> {
    const workspace = options.workspace();
    if (!workspace || options.operationRunning()) return [...current];
    try {
      const selected = await open({
        directory: false,
        multiple: true,
        title: "Attach files to task",
        defaultPath: workspace,
      });
      if (!selected) return [...current];
      return await addTaskAttachmentPaths(current, typeof selected === "string" ? [selected] : selected);
    } catch (error) {
      options.reportError(error);
      return [...current];
    }
  }

  async function addTaskAttachmentPaths(
    current: readonly Attachment[],
    paths: readonly string[],
  ): Promise<Attachment[]> {
    const existingPaths = new Set(current.flatMap((attachment) => attachment.path ? [attachment.path] : []));
    const available = MAX_ATTACHMENTS - current.length;
    if (available <= 0) {
      if (paths.length > 0) options.setErrorMessage(`Attach at most ${MAX_ATTACHMENTS} files.`);
      return [...current];
    }
    const candidates = paths.filter((path) => !existingPaths.has(path)).slice(0, available);
    if (candidates.length === 0) return [...current];
    try {
      const files = await invoke<AttachmentFile[]>("inspect_attachments", { paths: candidates });
      const additions = files.map((file) => attachmentFromFile(file, nextAttachmentId()));
      if (candidates.length < paths.length) {
        options.setErrorMessage(`Only the first ${MAX_ATTACHMENTS} files were attached.`);
      }
      return [...current, ...additions];
    } catch (error) {
      options.reportError(error);
      return [...current];
    }
  }

  async function pasteTaskAttachments(
    files: readonly File[],
    current: readonly Attachment[],
  ): Promise<Attachment[]> {
    const workspace = options.workspace();
    if (!workspace || options.operationRunning() || files.length === 0) return [...current];
    const available = MAX_ATTACHMENTS - current.length;
    if (available <= 0) {
      options.setErrorMessage(`Attach at most ${MAX_ATTACHMENTS} files.`);
      return [...current];
    }
    try {
      const additions: Attachment[] = [];
      for (const file of files.slice(0, available)) {
        if (file.size > MAX_EMBEDDED_ATTACHMENT_BYTES) {
          throw new Error(`${file.name} is too large to paste (maximum 25 MB).`);
        }
        const cached = await cachePastedTaskAttachment(file, workspace);
        if (options.workspace() !== workspace) return [...current];
        const inferredMimeType = mimeTypeForName(file.name);
        const mimeType = file.type || inferredMimeType;
        const base = attachmentFromFile(cached, nextAttachmentId());
        additions.push({ ...base, kind: attachmentKind(mimeType), mimeType });
      }
      if (files.length > available) {
        options.setErrorMessage(`Only the first ${MAX_ATTACHMENTS} files were attached.`);
      }
      return [...current, ...additions];
    } catch (error) {
      options.reportError(error);
      return [...current];
    }
  }

  async function chooseAttachments(): Promise<void> {
    if ((!options.activeSessionId() && !options.draftSessionTabActive()) || options.sessionMutationRunning()) return;
    try {
      const workspace = options.workspace();
      const selected = await open({
        directory: false,
        multiple: true,
        title: "Attach files",
        ...(workspace ? { defaultPath: workspace } : {}),
      });
      if (!selected) return;
      await addAttachmentPaths(typeof selected === "string" ? [selected] : selected);
    } catch (error) {
      options.reportError(error);
    }
  }

  function enqueueDraftOperation(key: string, run: () => Promise<void>): Promise<void> {
    const previous = addQueues.get(key) ?? Promise.resolve();
    const operation = previous.then(run);
    const tracked = operation.catch(() => undefined);
    addQueues.set(key, tracked);
    void tracked.finally(() => {
      if (addQueues.get(key) === tracked) addQueues.delete(key);
    });
    return operation;
  }

  function addAttachmentPaths(paths: readonly string[]): Promise<void> {
    const key = options.attachmentDraftKey();
    const requestGeneration = generation;
    return enqueueDraftOperation(key, () => addAttachmentPathsNow(paths, key, requestGeneration));
  }

  async function addAttachmentPathsNow(
    paths: readonly string[],
    key: string,
    requestGeneration: number,
  ): Promise<void> {
    if (!draftIsCurrent(key, requestGeneration)) return;
    const current = options.promptAttachments();
    const existingPaths = new Set(current.flatMap((attachment) => attachment.path ? [attachment.path] : []));
    const available = MAX_ATTACHMENTS - current.length;
    const candidates = paths.filter((path) => !existingPaths.has(path)).slice(0, Math.max(0, available));
    if (candidates.length === 0) {
      if (paths.length > 0 && available <= 0) options.setErrorMessage(`Attach at most ${MAX_ATTACHMENTS} files.`);
      return;
    }
    try {
      const files = await invoke<AttachmentFile[]>("inspect_attachments", { paths: candidates });
      if (!draftIsCurrent(key, requestGeneration)) return;
      const attachments = files.map((file) => attachmentFromFile(file, nextAttachmentId()));
      options.setPromptAttachments([...options.promptAttachments(), ...attachments]);
      if (candidates.length < paths.length) {
        options.setErrorMessage(`Only the first ${MAX_ATTACHMENTS} files were attached.`);
      }
    } catch (error) {
      options.reportError(error);
    }
  }

  function addPastedAttachments(files: readonly File[]): Promise<void> {
    const key = options.attachmentDraftKey();
    const requestGeneration = generation;
    return enqueueDraftOperation(key, () => addPastedAttachmentsNow(files, key, requestGeneration));
  }

  async function addPastedAttachmentsNow(
    files: readonly File[],
    key: string,
    requestGeneration: number,
  ): Promise<void> {
    if (!draftIsCurrent(key, requestGeneration)) return;
    if (
      (!options.activeSessionId() && !options.draftSessionTabActive())
      || options.sessionMutationRunning()
      || files.length === 0
    ) return;
    const available = MAX_ATTACHMENTS - options.promptAttachments().length;
    if (available <= 0) {
      options.setErrorMessage(`Attach at most ${MAX_ATTACHMENTS} files.`);
      return;
    }
    try {
      const attachments: Attachment[] = [];
      for (const file of files.slice(0, available)) {
        if (!draftIsCurrent(key, requestGeneration)) return;
        if (file.size > MAX_EMBEDDED_ATTACHMENT_BYTES) {
          throw new Error(`${file.name} is too large to paste (maximum 25 MB).`);
        }
        const cached = await cachePastedAttachment(file);
        if (!draftIsCurrent(key, requestGeneration)) return;
        const inferredMimeType = mimeTypeForName(file.name);
        const mimeType = file.type || inferredMimeType;
        const base = attachmentFromFile(cached, nextAttachmentId());
        attachments.push({ ...base, kind: attachmentKind(mimeType), mimeType });
      }
      options.setPromptAttachments([...options.promptAttachments(), ...attachments]);
      if (files.length > available) {
        options.setErrorMessage(`Only the first ${MAX_ATTACHMENTS} files were attached.`);
      }
    } catch (error) {
      options.reportError(error);
    }
  }

  function draftIsCurrent(key: string, requestGeneration: number): boolean {
    return key === options.attachmentDraftKey()
      && requestGeneration === generation
      && (!!options.activeSessionId() || options.draftSessionTabActive())
      && !options.sessionMutationRunning();
  }

  function invalidate(): void {
    addQueues.clear();
    generation += 1;
    options.setPromptAttachments([]);
  }

  function replaceDraftAttachments(attachments: readonly Attachment[]): void {
    generation += 1;
    options.setPromptAttachments([...attachments]);
  }

  function bumpGeneration(): void {
    generation += 1;
  }

  function removeAttachment(id: string): void {
    options.setPromptAttachments(options.promptAttachments().filter((attachment) => attachment.id !== id));
  }

  async function waitForSettled(key: string): Promise<void> {
    let pending = addQueues.get(key);
    while (true) {
      if (!pending) return;
      await pending.catch(() => undefined);
      const next = addQueues.get(key);
      if (!next || next === pending) return;
      pending = next;
    }
  }

  return {
    get generation() { return generation; },
    chooseTaskAttachments,
    pasteTaskAttachments,
    chooseAttachments,
    addAttachmentPaths,
    addPastedAttachments,
    invalidate,
    replaceDraftAttachments,
    bumpGeneration,
    removeAttachment,
    nextAttachmentId,
    waitForSettled,
  };
}
