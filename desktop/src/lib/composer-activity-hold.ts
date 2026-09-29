import type { ComposerActivity } from "./composer-activity";

/** Throttle visible changes, retaining only the latest pending status. */
export function createComposerActivityHold(publish: (activity: ComposerActivity) => void) {
  let current: ComposerActivity | undefined;
  let latest: ComposerActivity;
  let shownAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function flush() {
    timer = undefined;
    if (disposed || (current?.action === latest.action && current.moreCount === latest.moreCount)) return;
    current = latest;
    shownAt = performance.now();
    publish(current);
  }

  return {
    update(activity: ComposerActivity) {
      if (disposed) return;
      latest = activity;
      if (timer !== undefined) return;
      const remaining = 1000 - (performance.now() - shownAt);
      if (!current || remaining <= 0) flush();
      else if (current.action !== latest.action || current.moreCount !== latest.moreCount) {
        timer = setTimeout(flush, remaining);
      }
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
