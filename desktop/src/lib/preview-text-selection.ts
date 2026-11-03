/** Select only the document, never other panes or Preview chrome. */
export function selectPreviewText(surface: HTMLElement): void {
  if (!surface.isConnected) return;
  const selection = surface.ownerDocument.getSelection();
  if (!selection) return;
  const range = surface.ownerDocument.createRange();
  range.selectNodeContents(surface);
  selection.removeAllRanges();
  selection.addRange(range);
}

/** Native editable descendants keep their own Select All behavior. */
export function previewTextSelection(surface: HTMLElement): { destroy(): void } {
  const keydown = (event: KeyboardEvent) => {
    const target = event.target;
    if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey
      || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "a") return;
    if (target instanceof Element && target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")) return;
    event.preventDefault();
    event.stopPropagation();
    selectPreviewText(surface);
  };
  surface.addEventListener("keydown", keydown);
  return { destroy: () => surface.removeEventListener("keydown", keydown) };
}
