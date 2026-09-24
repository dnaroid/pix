import { invoke } from "@tauri-apps/api/core";
import {
  attachmentFromFile,
  attachmentKind,
  mimeTypeForName,
  type Attachment,
  type AttachmentFile,
} from "../lib/attachments";
import type { ProjectFileLineRange, ProjectFilePreview } from "../lib/project-files";
import type { PreviewStoreOptions } from "./preview-options";
import type { PreviewNavigation, PreviewState } from "./preview-state.svelte";

export function createPreviewFileIo(options: PreviewStoreOptions, state: PreviewState) {
  const fileValidationRequests = new Map<string, Promise<boolean>>();

  async function activateAttachment(attachment: Attachment): Promise<void> {
    const generation = state.beginFileLoad();
    const workspace = options.workspace();
    const isCurrent = () => state.fileLoadIsCurrent(generation) && options.workspace() === workspace;
    if ((attachment.deferredImageId && !attachment.dataUrl) || attachment.path) {
      try {
        await options.prepareAttachment(attachment);
      } catch (error) {
        if (isCurrent()) options.reportError(error);
        return;
      }
    }
    if (!isCurrent()) return;
    const preparedAttachment = options.preparedAttachment(attachment);
    if (preparedAttachment.kind === "image" || preparedAttachment.kind === "video") {
      state.show({ kind: "attachment", attachment: preparedAttachment }, "replace");
      return;
    }
    if (!preparedAttachment.path) {
      options.setErrorMessage(`Cannot open ${preparedAttachment.name}: no local path is available.`);
      return;
    }
    try {
      await invoke("open_attachment", { path: preparedAttachment.path });
    } catch (error) {
      if (isCurrent()) options.reportError(error);
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

    const generation = state.beginFileLoad();
    const mediaKind = attachmentKind(mimeTypeForName(path));
    try {
      if (mediaKind !== "file") {
        const attachment = await resolveProjectMedia(path);
        if (!attachment || !state.fileLoadIsCurrent(generation) || options.workspace() !== workspace) return;
        state.show({ kind: "attachment", attachment }, navigation);
        return;
      }
      const preview = await invoke<ProjectFilePreview>("read_project_file", { workspace, path });
      if (!state.fileLoadIsCurrent(generation) || options.workspace() !== workspace) return;
      state.show({ kind: "file", file: preview, ...(lineRange ? { lineRange } : {}) }, navigation);
    } catch (error) {
      if (state.fileLoadIsCurrent(generation) && options.workspace() === workspace) options.reportError(error);
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
    const generation = state.beginFileLoad();
    const isHomePath = path.startsWith("~/");
    if (attachmentKind(mimeTypeForName(path)) !== "file") {
      try {
        const attachment = isHomePath ? await resolveHomeMedia(path) : await resolveLocalMedia(path);
        if (!attachment || !state.fileLoadIsCurrent(generation)) return;
        state.show({ kind: "attachment", attachment }, navigation);
      } catch (error) {
        if (state.fileLoadIsCurrent(generation)) options.reportError(error);
      }
      return;
    }

    if (isHomePath) {
      try {
        const preview = await invoke<ProjectFilePreview>("read_home_file", { path });
        if (!state.fileLoadIsCurrent(generation)) return;
        state.show({ kind: "file", file: preview }, navigation);
      } catch (error) {
        if (state.fileLoadIsCurrent(generation)) options.reportError(error);
      }
      return;
    }

    try {
      const preview = await invoke<ProjectFilePreview>("read_local_file", { path });
      if (!state.fileLoadIsCurrent(generation)) return;
      state.show({ kind: "file", file: preview }, navigation);
      return;
    } catch {
      // Directories, binary/non-UTF-8 files and files beyond the bounded Preview
      // limit retain the existing system-opener fallback.
      if (!state.fileLoadIsCurrent(generation)) return;
    }

    try {
      await invoke("open_local_file", { path });
    } catch (error) {
      if (state.fileLoadIsCurrent(generation)) options.reportError(error);
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
