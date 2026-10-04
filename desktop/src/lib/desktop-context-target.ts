import { normalizeExternalHref } from "./markdown-links";
import { isWorkspaceProjectFilePath } from "./project-files";

export type DesktopContextKind = "editable" | "readonly" | "password" | "selection" | "link" | "terminal" | "image" | "file";

export interface DesktopContextTarget {
  kind: DesktopContextKind;
  element: HTMLElement;
  editor: HTMLElement | null;
  linkUrl?: string;
  image?: HTMLImageElement;
  imagePath?: string;
  imageRelativePath?: string;
  filePath?: string;
  sourceReference?: string;
  hasSelection: boolean;
  readOnly: boolean;
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "number", "password"]);

/** Only trusted component metadata supplies local paths; never decode asset URLs. */
export function contextFilePath(path: string | undefined, workspace: string): string | undefined {
  if (!path || path.includes("\0")) return undefined;
  if (path.startsWith("/")) return path;
  if (!workspace.startsWith("/") || !isWorkspaceProjectFilePath(path) || /^[a-z][a-z\d+.-]*:/iu.test(path)) return undefined;
  return `${workspace.replace(/\/$/u, "")}/${path}`;
}

export function contextElement(target: EventTarget | null): HTMLElement | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return element instanceof HTMLElement ? element : element?.parentElement ?? null;
}

/** Only the prose composer opts into WebKit's OS-owned spelling menu. */
export function nativeSpellingContextTarget(target: EventTarget | null): boolean {
  const element = contextElement(target);
  return element instanceof HTMLTextAreaElement
    && element.hasAttribute("data-native-spelling-menu")
    && element.spellcheck
    && !element.readOnly
    && !element.matches(":disabled")
    && !element.closest("[inert]");
}

/** A selection elsewhere in the window must not steal a control's context menu. */
export function hasContextSelection(element: HTMLElement): boolean {
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString()) return false;
  if (getComputedStyle(element).userSelect === "none") return false;
  for (let index = 0; index < selection.rangeCount; index++) {
    if (selection.getRangeAt(index).intersectsNode(element)) return true;
  }
  return false;
}

export function relativeImagePath(path: string, workspace: string): string | undefined {
  if (!path.startsWith("/") || !workspace.startsWith("/")) return undefined;
  const destination = path.split("/").filter(Boolean);
  const base = workspace.split("/").filter(Boolean);
  let common = 0;
  while (common < base.length && common < destination.length && base[common] === destination[common]) common++;
  return [...base.slice(common).map(() => ".."), ...destination.slice(common)].join("/") || ".";
}

/** Source rows, including their generated line-number gutter, share one logical line. */
export function previewSourceReference(element: HTMLElement, workspace: string): string | undefined {
  const surface = element.closest<HTMLElement>("[data-preview-source-path]");
  const row = element.closest<HTMLElement>(".sh__line");
  const code = row?.parentElement;
  if (!surface || !row || !code?.matches(".preview-code") || !surface.contains(code)) return undefined;
  const path = surface.dataset.previewSourcePath;
  if (!path) return undefined;
  const relative = isWorkspaceProjectFilePath(path) ? path : relativeImagePath(path, workspace);
  if (!relative) return undefined;
  const index = Array.from(code.children).indexOf(row);
  return index < 0 ? undefined : `${relative}:${index + 1}`;
}

export function desktopContextTarget(target: EventTarget | null, workspace = ""): DesktopContextTarget | null {
  const element = contextElement(target);
  if (!element || element.closest("[inert], :disabled")) return null;

  // xterm prepares its helper textarea during its own contextmenu handler.
  // Keep native Copy/Paste events so terminal selection and bracketed paste survive.
  const terminal = element.closest(".xterm");
  if (terminal) {
    const editor = terminal.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    const readOnly = terminal.closest("[data-terminal-readonly]")?.getAttribute("data-terminal-readonly") === "true";
    return editor ? { kind: "terminal", element, editor, hasSelection: true, readOnly } : null;
  }

  const input = element.closest("input, textarea");
  if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
    if (input.matches(":disabled") || (input instanceof HTMLInputElement && !TEXT_INPUT_TYPES.has(input.type))) return null;
    const password = input instanceof HTMLInputElement && input.type === "password";
    return {
      kind: password ? "password" : input.readOnly ? "readonly" : "editable",
      element,
      editor: input,
      readOnly: input.readOnly,
      hasSelection: !password && input.selectionStart !== null && input.selectionStart !== input.selectionEnd,
    };
  }

  if (element.isContentEditable) {
    let editor = element;
    while (editor.parentElement?.isContentEditable) editor = editor.parentElement;
    return { kind: "editable", element, editor, hasSelection: hasContextSelection(element), readOnly: false };
  }

  const image = element.closest("img");
  if (image instanceof HTMLImageElement && image.getAttribute("src")) {
    const imagePath = contextFilePath(image.dataset.imagePath, workspace);
    return {
      kind: "image", element: image, image, imagePath,
      imageRelativePath: imagePath ? relativeImagePath(imagePath, workspace) : undefined,
      editor: null, hasSelection: false, readOnly: true,
    };
  }

  const fileSurface = element.closest<HTMLElement>("[data-context-file-path]");
  const filePath = contextFilePath(fileSurface?.dataset.contextFilePath, workspace);

  const href = element.closest("a[href]")?.getAttribute("href");
  const linkUrl = href ? normalizeExternalHref(href) : undefined;
  const hasSelection = hasContextSelection(element);
  const sourceReference = previewSourceReference(element, workspace);
  if (linkUrl || hasSelection || sourceReference || fileSurface) {
    let kind: DesktopContextKind = fileSurface ? "file" : "readonly";
    if (linkUrl) kind = "link";
    if (hasSelection) kind = "selection";
    return { kind, element, editor: null, linkUrl, sourceReference, filePath, hasSelection, readOnly: true };
  }
  return null;
}

/** Focus the clicked surface without replacing its selection or its undo history. */
export function focusContextTarget(context: DesktopContextTarget): void {
  if (context.editor) {
    context.editor.focus({ preventScroll: true });
    return;
  }
  const active = context.element.ownerDocument.activeElement;
  if (active instanceof HTMLElement
    && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active.isContentEditable)) {
    active.blur();
  }
}
