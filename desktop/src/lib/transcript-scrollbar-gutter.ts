/** Keep the dock aligned with the scrollport, not its scrollbar-inclusive pane. */
export function observeTranscriptScrollbarGutter(
  pane: HTMLElement,
  onChange: (width: number) => void,
): () => void {
  let disposed = false;
  function update(): void {
    if (!disposed) onChange(Math.max(0, pane.offsetWidth - pane.clientWidth));
  }
  const observer = new ResizeObserver(update);
  observer.observe(pane);
  update();
  return () => {
    disposed = true;
    observer.disconnect();
  };
}
