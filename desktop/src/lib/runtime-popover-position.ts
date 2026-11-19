export function runtimePopoverLeft(
  anchor: { left: number; right: number },
  bounds: { left: number; right: number },
  width: number,
  align: "left" | "right",
): number {
  const preferred = align === "left" ? anchor.left : anchor.right - width;
  return Math.max(bounds.left, Math.min(preferred, bounds.right - width)) - anchor.left;
}

/** Keep the popup inside the workbench, not just the wider WebView. */
export function fitRuntimePopover(align: "left" | "right") {
  return (popup: HTMLElement) => {
    const anchor = popup.parentElement;
    const footer = anchor?.closest("footer");
    const layout = anchor?.parentElement;
    const group = layout?.parentElement;
    if (!anchor || !footer || !layout || !group) return;

    const reposition = () => {
      const { left, right, width } = footer.getBoundingClientRect();
      const inset = Math.min(8, width / 2);
      popup.style.maxWidth = `${Math.min(360, width - 2 * inset)}px`;
      const bounds = { left: left + inset, right: right - inset };
      const offset = runtimePopoverLeft(anchor.getBoundingClientRect(), bounds, popup.getBoundingClientRect().width, align);
      popup.style.left = `${offset}px`;
    };

    const resize = new ResizeObserver(reposition);
    const observeLayout = () => {
      resize.disconnect();
      // The model label and Context can move the anchor without resizing it.
      for (const node of [footer, popup, ...group.children, ...layout.children]) resize.observe(node);
      reposition();
    };

    const children = new MutationObserver(observeLayout);
    children.observe(group, { childList: true });
    children.observe(layout, { childList: true });
    observeLayout();
    return () => {
      children.disconnect();
      resize.disconnect();
    };
  };
}
