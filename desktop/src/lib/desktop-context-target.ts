import { normalizeExternalHref } from "./markdown-links";

export type DesktopContextKind = "editable" | "readonly" | "password" | "selection" | "link" | "terminal";

export interface DesktopContextTarget {
  kind: DesktopContextKind;
  element: HTMLElement;
  editor: HTMLElement | null;
  linkUrl?: string;
  hasSelection: boolean;
  readOnly: boolean;
}

const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "number", "password"]);

export function contextElement(target: EventTarget | null): HTMLElement | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return element instanceof HTMLElement ? element : element?.parentElement ?? null;
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

export function desktopContextTarget(target: EventTarget | null): DesktopContextTarget | null {
  const element = contextElement(target);
  if (!element || element.closest("[inert]")) return null;

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

  const href = element.closest("a[href]")?.getAttribute("href");
  const linkUrl = href ? normalizeExternalHref(href) : undefined;
  const hasSelection = hasContextSelection(element);
  if (linkUrl || hasSelection) {
    return { kind: hasSelection ? "selection" : "link", element, editor: null, linkUrl, hasSelection, readOnly: true };
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
