/** Share the scroll pane's visible height without observing individual media. */
export function transcriptMediaViewport(node: HTMLElement) {
  let destroyed = false;
  const update = () => {
    if (destroyed || node.clientHeight <= 0) return;
    node.style.setProperty("--chat-media-max-height", `${node.clientHeight}px`);
  };
  update();
  const observer = new ResizeObserver(update);
  observer.observe(node);
  return {
    destroy() {
      destroyed = true;
      observer.disconnect();
      node.style.removeProperty("--chat-media-max-height");
    },
  };
}
