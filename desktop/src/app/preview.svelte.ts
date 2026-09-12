import { invoke } from "@tauri-apps/api/core";
import {
  attachmentFromFile,
  attachmentKind,
  mimeTypeForName,
  type Attachment,
  type AttachmentFile,
} from "../lib/attachments";
import type { ProjectFileLineRange, ProjectFilePreview } from "../lib/project-files";
import {
  canMovePreviewHistory,
  currentPreview,
  emptyPreviewHistory,
  movePreviewHistory,
  pushPreviewHistory,
  replaceCurrentPreview,
  resetPreviewHistory,
  type PreviewHistory,
  type PreviewScrollPosition,
} from "../lib/preview-history";
import type { WorkbenchTabId } from "../lib/workbench-tabs";

export type PreviewTarget =
  | { kind: "file"; file: ProjectFilePreview; lineRange?: ProjectFileLineRange }
  | { kind: "attachment"; attachment: Attachment };

export type PreviewEntry = PreviewTarget & {
  id: number;
  scrollPosition: PreviewScrollPosition;
};

export type PreviewNavigation = "replace" | "push";

type PreviewStoreOptions = {
  workspace: () => string;
  activeWorkbenchTabId: () => WorkbenchTabId | null;
  activeConversationWorkbenchTabId: () => WorkbenchTabId | null;
  setActiveWorkbenchTabId: (id: WorkbenchTabId | null) => void;
  nextWorkbenchAuxOrder: () => number;
  prepareAttachment: (attachment: Attachment) => Promise<void>;
  preparedAttachment: (attachment: Attachment) => Attachment;
  reportError: (error: unknown) => void;
  setErrorMessage: (message: string) => void;
};

export function createPreviewStore(options: PreviewStoreOptions) {
  let history = $state<PreviewHistory<PreviewEntry>>(emptyPreviewHistory());
  let dirty = $state(false);
  let workbenchAnchorId = $state<WorkbenchTabId | null>(null);
  let workbenchOpenedOrder = $state(0);
  let sequence = 0;
  let filePreviewGeneration = 0;
  const fileValidationRequests = new Map<string, Promise<boolean>>();

  function show(target: PreviewTarget, navigation: PreviewNavigation): void {
    const opening = currentPreview(history) === undefined;
    if (opening) {
      workbenchAnchorId = options.activeWorkbenchTabId() ?? options.activeConversationWorkbenchTabId();
      workbenchOpenedOrder = options.nextWorkbenchAuxOrder();
    }
    sequence += 1;
    const entry: PreviewEntry = {
      ...target,
      id: sequence,
      scrollPosition: { left: 0, top: 0 },
    };
    history = navigation === "push"
      ? pushPreviewHistory(history, entry)
      : resetPreviewHistory(entry);
    dirty = false;
    options.setActiveWorkbenchTabId("preview");
  }

  function rememberScroll(id: number, scrollPosition: PreviewScrollPosition): void {
    const entry = currentPreview(history);
    if (!entry || entry.id !== id) return;
    if (
      entry.scrollPosition.left === scrollPosition.left
      && entry.scrollPosition.top === scrollPosition.top
    ) return;
    history = replaceCurrentPreview(history, { ...entry, scrollPosition });
  }

  function close(): void {
    filePreviewGeneration += 1;
    history = emptyPreviewHistory();
    dirty = false;
    workbenchAnchorId = null;
    workbenchOpenedOrder = 0;
  }

  function resetForWorkspaceChange(): void {
    close();
  }

  function move(offset: -1 | 1): void {
    filePreviewGeneration += 1;
    history = movePreviewHistory(history, offset);
  }

  function invalidateFileLoads(): void {
    filePreviewGeneration += 1;
  }

  function replaceCurrentFile(file: ProjectFilePreview): void {
    const current = currentPreview(history);
    if (current?.kind !== "file" || current.file.path !== file.path) return;
    history = replaceCurrentPreview(history, { ...current, file });
  }

  function setDirty(next: boolean): void {
    dirty = next;
  }

  function retargetAnchor(sourceId: WorkbenchTabId, targetId: WorkbenchTabId | null): void {
    if (workbenchAnchorId === sourceId) workbenchAnchorId = targetId;
  }

  async function activateAttachment(attachment: Attachment): Promise<void> {
    if ((attachment.deferredImageId && !attachment.dataUrl) || attachment.path) {
      try {
        await options.prepareAttachment(attachment);
      } catch (error) {
        options.reportError(error);
        return;
      }
    }
    const preparedAttachment = options.preparedAttachment(attachment);
    if (preparedAttachment.kind === "image" || preparedAttachment.kind === "video") {
      show({ kind: "attachment", attachment: preparedAttachment }, "replace");
      return;
    }
    if (!preparedAttachment.path) {
      options.setErrorMessage(`Cannot open ${preparedAttachment.name}: no local path is available.`);
      return;
    }
    try {
      await invoke("open_attachment", { path: preparedAttachment.path });
    } catch (error) {
      options.reportError(error);
    }
  }

  function sharedFileValidation(key: string, request: () => Promise<boolean>): Promise<boolean> {
    const existing = fileValidationRequests.get(key);
    if (existing) return existing;
    const promise = request()
      .catch(() => false)
      .finally(() => {
        if (fileValidationRequests.get(key) === promise) fileValidationRequests.delete(key);
      });
    fileValidationRequests.set(key, promise);
    return promise;
  }

  async function validateProjectFile(path: string): Promise<boolean> {
    const workspace = options.workspace();
    if (!workspace) return false;
    const exists = await sharedFileValidation(
      `project\0${workspace}\0${path}`,
      () => invoke<boolean>("project_file_exists", { workspace, path }),
    );
    return options.workspace() === workspace && exists;
  }

  async function validateLocalFile(path: string): Promise<boolean> {
    const command = path.startsWith("~/") ? "home_file_exists" : "local_file_exists";
    return sharedFileValidation(`${command}\0${path}`, () => invoke<boolean>(command, { path }));
  }

  async function openProjectFile(
    path: string,
    navigation: PreviewNavigation = "replace",
    lineRange?: ProjectFileLineRange,
  ): Promise<void> {
    const workspace = options.workspace();
    if (!workspace) {
      options.setErrorMessage("Open a workspace before previewing project files.");
      return;
    }

    const generation = ++filePreviewGeneration;
    const mediaKind = attachmentKind(mimeTypeForName(path));
    try {
      if (mediaKind !== "file") {
        const attachment = await resolveProjectMedia(path);
        if (!attachment || generation !== filePreviewGeneration || options.workspace() !== workspace) return;
        show({ kind: "attachment", attachment }, navigation);
        return;
      }
      const preview = await invoke<ProjectFilePreview>("read_project_file", { workspace, path });
      if (generation !== filePreviewGeneration || options.workspace() !== workspace) return;
      show({ kind: "file", file: preview, ...(lineRange ? { lineRange } : {}) }, navigation);
    } catch (error) {
      if (generation === filePreviewGeneration) options.reportError(error);
    }
  }

  async function resolveProjectMedia(path: string): Promise<Attachment | undefined> {
    const workspace = options.workspace();
    if (!workspace || attachmentKind(mimeTypeForName(path)) === "file") return undefined;
    const file = await invoke<AttachmentFile>("resolve_project_media", { workspace, path });
    if (options.workspace() !== workspace) return undefined;
    return attachmentFromFile(file, `project-media:${workspace}:${path}`);
  }

  async function openLocalFile(path: string, navigation: PreviewNavigation = "replace"): Promise<void> {
    const generation = ++filePreviewGeneration;
    const isHomePath = path.startsWith("~/");
    if (attachmentKind(mimeTypeForName(path)) !== "file") {
      try {
        const attachment = isHomePath ? await resolveHomeMedia(path) : await resolveLocalMedia(path);
        if (!attachment || generation !== filePreviewGeneration) return;
        show({ kind: "attachment", attachment }, navigation);
      } catch (error) {
        if (generation === filePreviewGeneration) options.reportError(error);
      }
      return;
    }

    if (isHomePath) {
      try {
        const preview = await invoke<ProjectFilePreview>("read_home_file", { path });
        if (generation !== filePreviewGeneration) return;
        show({ kind: "file", file: preview }, navigation);
      } catch (error) {
        if (generation === filePreviewGeneration) options.reportError(error);
      }
      return;
    }

    try {
      await invoke("open_local_file", { path });
    } catch (error) {
      options.reportError(error);
    }
  }

  async function resolveHomeMedia(path: string): Promise<Attachment | undefined> {
    if (attachmentKind(mimeTypeForName(path)) === "file") return undefined;
    const file = await invoke<AttachmentFile>("resolve_home_media", { path });
    return attachmentFromFile(file, `home-media:${path}`);
  }

  async function resolveLocalMedia(path: string): Promise<Attachment | undefined> {
    if (attachmentKind(mimeTypeForName(path)) === "file") return undefined;
    const file = await invoke<AttachmentFile>("resolve_local_media", { path });
    return attachmentFromFile(file, `local-media:${path}`);
  }

  return {
    get active() { return currentPreview(history); },
    get canGoBack() { return canMovePreviewHistory(history, -1); },
    get canGoForward() { return canMovePreviewHistory(history, 1); },
    get dirty() { return dirty; },
    get workbenchAnchorId() { return workbenchAnchorId; },
    get workbenchOpenedOrder() { return workbenchOpenedOrder; },
    show,
    rememberScroll,
    close,
    resetForWorkspaceChange,
    move,
    invalidateFileLoads,
    replaceCurrentFile,
    setDirty,
    retargetAnchor,
    activateAttachment,
    validateProjectFile,
    validateLocalFile,
    openProjectFile,
    resolveProjectMedia,
    openLocalFile,
    resolveHomeMedia,
    resolveLocalMedia,
  };
}
