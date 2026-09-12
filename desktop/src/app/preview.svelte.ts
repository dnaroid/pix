import type { PreviewStoreOptions } from "./preview-options";
import { createPreviewFileIo } from "./preview-file-io";
import { createPreviewState } from "./preview-state.svelte";

export type {
  PreviewEntry,
  PreviewNavigation,
  PreviewTarget,
} from "./preview-state.svelte";

export function createPreviewStore(options: PreviewStoreOptions) {
  const state = createPreviewState(options);
  const files = createPreviewFileIo(options, state);

  return {
    get active() { return state.active; },
    get canGoBack() { return state.canGoBack; },
    get canGoForward() { return state.canGoForward; },
    get dirty() { return state.dirty; },
    get workbenchAnchorId() { return state.workbenchAnchorId; },
    get workbenchOpenedOrder() { return state.workbenchOpenedOrder; },
    show: state.show,
    rememberScroll: state.rememberScroll,
    close: state.close,
    resetForWorkspaceChange: state.close,
    move: state.move,
    invalidateFileLoads: state.invalidateFileLoads,
    replaceCurrentFile: state.replaceCurrentFile,
    setDirty: state.setDirty,
    retargetAnchor: state.retargetAnchor,
    activateAttachment: files.activateAttachment,
    validateProjectFile: files.validateProjectFile,
    validateLocalFile: files.validateLocalFile,
    openProjectFile: files.openProjectFile,
    resolveProjectMedia: files.resolveProjectMedia,
    openLocalFile: files.openLocalFile,
    resolveHomeMedia: files.resolveHomeMedia,
    resolveLocalMedia: files.resolveLocalMedia,
  };
}
