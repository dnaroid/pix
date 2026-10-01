import { currentSettingsSection, settingsSearchMatches } from "./settings-navigation";

type ViewportOptions = { query: string; onChange: (visible: string[], active: string) => void };

// Filter only authored labels/descriptions, never control values (including secrets).
// Keep controls mounted so filtering cannot discard local editor state.
export function settingsViewport(node: HTMLElement, initial: ViewportOptions) {
  let options = initial;
  let frame = 0;
  let needsFilter = true;
  let disposed = false;
  let visible: HTMLElement[] = [];

  function track() {
    const top = node.getBoundingClientRect().top;
    const stickyHeader = Array.from(node.querySelectorAll<HTMLElement>("[data-settings-config] > header"))
      .find((header) => header.getBoundingClientRect().top <= top + 1 && header.getBoundingClientRect().bottom > top);
    const active = currentSettingsSection(
      visible.map((section) => ({ id: section.dataset.settingsSection!, top: section.getBoundingClientRect().top - top })),
      stickyHeader ? stickyHeader.getBoundingClientRect().bottom - top + 8 : 8,
      node.scrollHeight > node.clientHeight && node.scrollTop + node.clientHeight >= node.scrollHeight - 2,
    );
    options.onChange(visible.map((section) => section.dataset.settingsSection!), active);
  }

  function filter() {
    if (disposed) return;
    visible = [];
    for (const section of node.querySelectorAll<HTMLElement>("[data-settings-section]")) {
      let matches = 0;
      for (const row of section.querySelectorAll<HTMLElement>("[data-settings-field]")) {
        row.hidden = !settingsSearchMatches(options.query, `${section.dataset.settingsTitle} ${row.dataset.settingsField}`);
        if (!row.hidden) matches++;
      }
      section.hidden = matches === 0;
      if (!section.hidden) visible.push(section);
    }
    for (const config of node.querySelectorAll<HTMLElement>("[data-settings-config]")) {
      const sections = Array.from(config.querySelectorAll<HTMLElement>("[data-settings-section]"));
      config.hidden = Boolean(options.query.trim() && sections.length && sections.every((section) => section.hidden));
    }
    track();
  }

  function schedule() {
    if (frame || disposed) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (needsFilter) { needsFilter = false; filter(); }
      else track();
    });
  }

  function scheduleFilter() { needsFilter = true; schedule(); }
  const observer = new MutationObserver(scheduleFilter);
  observer.observe(node, { childList: true, subtree: true });
  const resize = new ResizeObserver(schedule);
  resize.observe(node);
  node.addEventListener("scroll", schedule, { passive: true });
  schedule();
  return {
    update(next: ViewportOptions) {
      const changed = options.query !== next.query;
      options = next;
      if (changed) node.scrollTop = 0;
      scheduleFilter();
    },
    destroy() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      resize.disconnect();
      node.removeEventListener("scroll", schedule);
    },
  };
}
