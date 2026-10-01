import { invoke } from "@tauri-apps/api/core";
import {
  attachmentFromFile,
  attachmentKind,
  mimeTypeForName,
  type Attachment,
  type AttachmentFile,
} from "../lib/attachments";
import type { ProjectFileLineRange, ProjectFilePreview } from "../lib/project-files";
import type { SettingsConfigDocument, SettingsConfigKind } from "../lib/settings";
import type { PreviewStoreOptions } from "./preview-options";
import type { PreviewNavigation, PreviewState } from "./preview-state.svelte";

type PreviewRead = { kind: "text"; file: ProjectFilePreview } | { kind: "external" };

export function createPreviewFileIo(options: PreviewStoreOptions, state: PreviewState) {
  const fileValidationRequests = new Map<string, Promise<boolean>>();

  async function openLargeFile(path: string, workspace: string | null, isCurrent: () => boolean): Promise<void> {
    const editor = await options.loadExternalEditor();
    if (!isCurrent()) return;
    if (!editor) {
      options.setErrorMessage("This file is too large for Preview. Choose an external file editor in Settings → Desktop → Editor.");
      return;
    }
    await invoke("open_preview_file_in_editor", { workspace, path, editor });
  }

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
    const isCurrent = () => state.fileLoadIsCurrent(generation) && options.workspace() === workspace;
    const mediaKind = attachmentKind(mimeTypeForName(path));
    try {
      if (mediaKind !== "file") {
        const attachment = await resolveProjectMedia(path);
        if (!attachment || !isCurrent()) return;
        state.show({ kind: "attachment", attachment }, navigation);
        return;
      }
      const result = await invoke<PreviewRead>("read_preview_file", { workspace, path });
      if (!isCurrent()) return;
      if (result.kind === "external") {
        await openLargeFile(path, workspace, isCurrent);
        return;
      }
      state.show({ kind: "file", file: result.file, ...(lineRange ? { lineRange } : {}) }, navigation);
    } catch (error) {
      if (isCurrent()) options.reportError(error);
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
    const workspace = options.workspace();
    const isCurrent = () => state.fileLoadIsCurrent(generation) && options.workspace() === workspace;
    const isHomePath = path.startsWith("~/");
    if (attachmentKind(mimeTypeForName(path)) !== "file") {
      try {
        const attachment = isHomePath ? await resolveHomeMedia(path) : await resolveLocalMedia(path);
        if (!attachment || !isCurrent()) return;
        state.show({ kind: "attachment", attachment }, navigation);
      } catch (error) {
        if (isCurrent()) options.reportError(error);
      }
      return;
    }

    let result: PreviewRead;
    try {
      result = await invoke<PreviewRead>("read_preview_file", { workspace: null, path });
    } catch (error) {
      if (!isCurrent()) return;
      if (isHomePath) {
        options.reportError(error);
        return;
      }
      // Absolute directories and binary/non-UTF-8 files retain the OS fallback.
      try {
        await invoke("open_local_file", { path });
      } catch (openError) {
        if (isCurrent()) options.reportError(openError);
      }
      return;
    }
    if (!isCurrent()) return;
    try {
      if (result.kind === "external") {
        await openLargeFile(path, null, isCurrent);
      } else {
        state.show({ kind: "file", file: result.file }, navigation);
      }
    } catch (error) {
      // Editor launch failures must not retry with the OS opener.
      if (isCurrent()) options.reportError(error);
    }
  }

  async function openUserConfig(
    kind: SettingsConfigKind,
    navigation: PreviewNavigation = "replace",
  ): Promise<void> {
    const generation = state.beginFileLoad();
    try {
      const document = await invoke<SettingsConfigDocument>("read_user_config", { kind });
      if (!state.fileLoadIsCurrent(generation)) return;
      state.show({
        kind: "file",
        file: { path: document.path, content: document.content },
        userConfigKind: kind,
      }, navigation);
    } catch (error) {
      if (state.fileLoadIsCurrent(generation)) options.reportError(error);
    }
  }

  async function saveUserConfig(kind: SettingsConfigKind, path: string, content: string): Promise<boolean> {
    const active = state.active;
    if (active?.kind !== "file" || active.userConfigKind !== kind || active.file.path !== path) return false;
    try {
      const result = await invoke<{ written: boolean; document: SettingsConfigDocument }>(
        "write_user_config_if_unchanged",
        { kind, expectedContent: active.file.content, content },
      );
      if (!result.written) {
        options.setErrorMessage("This config changed on disk. Reopen it before saving to avoid overwriting newer changes.");
        return false;
      }
      const current = state.active;
      if (current?.kind !== "file" || current.userConfigKind !== kind || current.file.path !== path) return false;
      state.replaceCurrentFile({ path: result.document.path, content: result.document.content });
      return true;
    } catch (error) {
      options.reportError(error);
      return false;
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
    openUserConfig,
    saveUserConfig,
    resolveHomeMedia,
    resolveLocalMedia,
  };
}
