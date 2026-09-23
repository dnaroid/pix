import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, type MenuItemOptions, type PredefinedMenuItemOptions } from "@tauri-apps/api/menu";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { DesktopContextTarget } from "./desktop-context-target";

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
  } else if (context.kind === "readonly") {
    edit("Copy");
    separator();
    edit("SelectAll");
  } else if (readonlyPassword) {
    edit("SelectAll");
  } else if (context.hasSelection) {
    edit("Copy");
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
  return items;
}

export function createNativeContextMenuFactory(
  reportError: (error: unknown) => void,
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
      const items = nativeContextMenuItems(context, linux, reportError, isActive)
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
