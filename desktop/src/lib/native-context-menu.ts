import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, type MenuItemOptions, type PredefinedMenuItemOptions } from "@tauri-apps/api/menu";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { DesktopContextTarget } from "./desktop-context-target";
import { copyContextImage, openContextImage } from "./image-context-actions";
import { gitRemoteLinkLabel, type GitRemoteEntryLink } from "./project-git-remote-link";

export interface ContextMenuPosition { x: number; y: number }
export interface NativeContextMenu {
  popup(position: ContextMenuPosition): Promise<void>;
  close(): Promise<void>;
}

type EditCommand = "Undo" | "Redo" | "Cut" | "Copy" | "Paste" | "SelectAll";
type ContextMenuItem = MenuItemOptions | PredefinedMenuItemOptions;
const EDIT_LABELS: Record<EditCommand, string> = {
  Undo: "Undo", Redo: "Redo", Cut: "Cut", Copy: "Copy", Paste: "Paste", SelectAll: "Select All",
};

function editorSelectionText(context: DesktopContextTarget): string | null {
  const editor = context.editor;
  if (
    !editor
    || context.kind === "password"
    || !("value" in editor)
    || !("selectionStart" in editor)
    || !("selectionEnd" in editor)
  ) return null;
  const textEditor = editor as HTMLInputElement | HTMLTextAreaElement;
  const start = textEditor.selectionStart;
  const end = textEditor.selectionEnd;
  if (start === null || end === null || end <= start) return null;
  return textEditor.value.slice(start, end);
}

export function nativeContextMenuItems(
  context: DesktopContextTarget,
  linux: boolean,
  reportError: (error: unknown) => void,
  isActive: () => boolean,
  revealProjectEntry?: (path: string) => Promise<void>,
  remoteLink?: GitRemoteEntryLink | null,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  const run = (action: () => Promise<unknown>) => () => {
    if (isActive() && context.element.isConnected) void action().catch(reportError);
  };
  const edit = (command: EditCommand) => {
    if (linux) {
      // muda's Linux predefined actions emulate X11 keys (and omit Undo/Redo).
      // Execute WebKit's native editing commands instead, including on Wayland.
      items.push({
        id: `desktop.text.${command}`,
        text: EDIT_LABELS[command],
        enabled: (command !== "Cut" && command !== "Copy") || context.hasSelection,
        action: run(() => invoke("desktop_edit", { command })),
      });
    } else if (command === "Copy") {
      const selectedText = editorSelectionText(context);
      if (selectedText !== null) {
        items.push({
          id: "desktop.text.Copy",
          text: EDIT_LABELS.Copy,
          enabled: selectedText.length > 0,
          action: run(() => writeText(selectedText)),
        });
      } else {
        items.push({ item: command, text: EDIT_LABELS[command] });
      }
    } else {
      items.push({ item: command, text: EDIT_LABELS[command] });
    }
  };
  const separator = () => items.push({ item: "Separator" });
  const writable = context.kind === "editable" || context.kind === "password";
  const readonlyPassword = context.kind === "password" && context.readOnly;

  if (context.moveTab) {
    const moveTab = context.moveTab;
    items.push({
      id: "desktop.workbench.move-tab",
      text: "Move Tab",
      action: run(async () => moveTab()),
    });
  }

  if (context.kind === "session") {
    const sessionFile = context.sessionFile;
    items.push({
      id: "desktop.session.copy-path",
      text: "Copy Session File Path",
      enabled: Boolean(sessionFile),
      action: run(() => sessionFile ? writeText(sessionFile) : Promise.resolve()),
    });
    return items;
  }

  if (context.image) {
    const image = context.image;
    items.push(
      { id: "desktop.image.open", text: "Open Image in External App", action: run(() => openContextImage(image, isActive)) },
      { id: "desktop.image.copy", text: "Copy Image", action: run(() => copyContextImage(image, isActive)) },
      { id: "desktop.image.reveal", text: "Reveal in Finder", enabled: Boolean(context.imagePath),
        action: run(() => context.imagePath ? invoke("preview_file_action", { path: context.imagePath, action: "reveal" }) : Promise.resolve()) },
      { item: "Separator" },
      { id: "desktop.image.absolute", text: "Copy Absolute Path", enabled: Boolean(context.imagePath),
        action: run(() => context.imagePath ? writeText(context.imagePath) : Promise.resolve()) },
      { id: "desktop.image.relative", text: "Copy Relative Path", enabled: Boolean(context.imageRelativePath),
        action: run(() => context.imageRelativePath ? writeText(context.imageRelativePath) : Promise.resolve()) },
    );
    return items;
  }

  if (writable && !readonlyPassword) {
    edit("Undo");
    edit("Redo");
    separator();
    if (context.kind !== "password") { edit("Cut"); edit("Copy"); }
    edit("Paste");
    separator();
    edit("SelectAll");
  } else if (context.kind === "terminal") {
    edit("Copy");
    if (!context.readOnly) edit("Paste");
  } else if (context.kind === "readonly" && !context.sourceReference) {
    edit("Copy");
    separator();
    edit("SelectAll");
  } else if (readonlyPassword) {
    edit("SelectAll");
  } else if (context.hasSelection) {
    edit("Copy");
  }

  const sourceReference = context.sourceReference;
  if (sourceReference) {
    if (items.length) separator();
    items.push({
      id: "desktop.source.reference",
      text: "Copy Relative Path with Line Number",
      action: run(() => writeText(sourceReference)),
    });
  }

  const url = context.linkUrl;
  if (url) {
    if (items.length) separator();
    // Stable ids keep the native callback registry bounded across repeated clicks.
    items.push(
      { id: "desktop.link.open", text: "Open Link", action: run(() => openUrl(url)) },
      { id: "desktop.link.copy", text: "Copy Link Address", action: run(() => writeText(url)) },
    );
  }
  const fileLinkPath = context.fileLinkPath;
  if (fileLinkPath) {
    if (items.length) separator();
    if (/\.html?$/iu.test(fileLinkPath)) {
      items.push({ id: "desktop.link-file.browser", text: "Open in Browser",
        action: run(() => invoke("preview_file_action", { path: fileLinkPath, action: "browser" })) });
    }
    const revealPath = context.fileLinkRevealPath;
    if (revealPath && revealProjectEntry) {
      items.push({ id: "desktop.link-file.explorer", text: "Show in Files",
        action: run(() => revealProjectEntry(revealPath)) });
    }
    if (revealPath && remoteLink) {
      const url = remoteLink.url;
      items.push({ id: "desktop.link-file.remote", text: gitRemoteLinkLabel(remoteLink.provider),
        action: run(() => openUrl(url)) });
    }
    items.push({ id: "desktop.link-file.reveal", text: "Reveal in Finder",
      action: run(() => invoke("preview_file_action", { path: fileLinkPath, action: "reveal" })) });
  }
  if (context.kind === "file" || context.filePath) {
    if (items.length) separator();
    for (const [action, text] of [["copy", "Copy File"], ["open", "Open in External App"], ["reveal", "Reveal in Finder"]] as const) {
      const path = context.filePath;
      items.push({ id: `desktop.file.${action}`, text, enabled: Boolean(path),
        action: run(() => path ? invoke("preview_file_action", { path, action }) : Promise.resolve()) });
    }
    if (context.projectRevealPath && revealProjectEntry) {
      const path = context.projectRevealPath;
      items.push({ id: "desktop.file.explorer", text: "Show in Files",
        action: run(() => revealProjectEntry(path)) });
    }
  }
  return items;
}

export function createNativeContextMenuFactory(
  reportError: (error: unknown) => void,
  revealProjectEntry?: (path: string) => Promise<void>,
  resolveRemoteLink?: (path: string) => Promise<GitRemoteEntryLink | null>,
): (context: DesktopContextTarget, isActive: () => boolean) => Promise<NativeContextMenu> {
  // Tauri's callback registry is app-wide, not per WebView. Each mounted owner
  // needs a namespace so secondary windows cannot overwrite each other's actions.
  const namespace = `desktop-context:${crypto.randomUUID()}`;
  const linux = /Linux|X11/.test(navigator.userAgent);
  let pending: Promise<unknown> = Promise.resolve();

  return (context, isActive) => {
    // Keep native registration ordered as well as guarding JS completions: a
    // late obsolete creation must not overwrite a newer menu's stable callback ids.
    const result = pending.then(async () => {
      // Lookup stays inside the ordered chain so registration order is unchanged.
      // Unsupported remotes, non-repositories and Git failures just hide the item.
      const revealPath = context.fileLinkRevealPath;
      const remoteLink = revealPath && resolveRemoteLink
        ? await resolveRemoteLink(revealPath).catch(() => null) : null;
      const items = nativeContextMenuItems(context, linux, reportError, isActive, revealProjectEntry, remoteLink)
        .map((item) => "id" in item ? { ...item, id: `${namespace}:${item.id}` } : item);
      const menu = await Menu.new({ items });
      return {
        popup: ({ x, y }: ContextMenuPosition) => menu.popup(new LogicalPosition(x, y)),
        close: () => menu.close(),
      };
    });
    pending = result.catch(() => undefined);
    return result;
  };
}
