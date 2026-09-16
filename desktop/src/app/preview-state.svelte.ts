import type { Attachment } from "../lib/attachments";
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
import type { PreviewStoreOptions } from "./preview-options";

export type PreviewTarget =
  | { kind: "file"; file: ProjectFilePreview; lineRange?: ProjectFileLineRange }
  | { kind: "attachment"; attachment: Attachment };

export type PreviewEntry = PreviewTarget & {
  id: number;
  scrollPosition: PreviewScrollPosition;
};

export type PreviewNavigation = "replace" | "push";

export function createPreviewState(options: PreviewStoreOptions) {
  let history = $state<PreviewHistory<PreviewEntry>>(emptyPreviewHistory());
  let dirty = $state(false);
  let workbenchAnchorId = $state<WorkbenchTabId | null>(null);
  let workbenchOpenedOrder = $state(0);
  let sequence = 0;
  let filePreviewGeneration = 0;

  function show(target: PreviewTarget, navigation: PreviewNavigation): void {
    filePreviewGeneration += 1;
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

  function move(offset: -1 | 1): void {
    filePreviewGeneration += 1;
    history = movePreviewHistory(history, offset);
  }

  function invalidateFileLoads(): void {
    filePreviewGeneration += 1;
  }

  function beginFileLoad(): number {
    filePreviewGeneration += 1;
    return filePreviewGeneration;
  }

  function fileLoadIsCurrent(generation: number): boolean {
    return generation === filePreviewGeneration;
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
    move,
    invalidateFileLoads,
    beginFileLoad,
    fileLoadIsCurrent,
    replaceCurrentFile,
    setDirty,
    retargetAnchor,
  };
}

export type PreviewState = ReturnType<typeof createPreviewState>;
