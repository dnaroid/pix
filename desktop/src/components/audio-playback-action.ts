/** Stop playback and release the WebView's media resource on removal/close. */
export function audioPlayback(node: HTMLAudioElement, active = true) {
  if (!active) node.pause();
  return {
    update(nextActive: boolean) {
      if (!nextActive) node.pause();
    },
    destroy() {
      node.pause();
      node.removeAttribute("src");
      node.load();
    },
  };
}

interface PreviewPlaybackOptions {
  active: boolean;
  autoplay: boolean;
  onAutoplayConsumed: () => void;
}

/** One user-requested start; hidden tabs and stale play completions cannot resume it. */
export function previewMediaPlayback(node: HTMLMediaElement, options: PreviewPlaybackOptions) {
  let active = options.active;
  let destroyed = false;
  let generation = 0;
  if (options.autoplay) {
    options.onAutoplayConsumed();
    if (active) {
      const request = generation;
      try {
        void node.play().then(() => {
          if (destroyed || !active || request !== generation) node.pause();
        }).catch(() => { /* Native controls remain available if WebKit denies playback. */ });
      } catch { /* Unsupported media retains native controls/error handling. */ }
    }
  }
  if (!active) node.pause();
  return {
    update(next: PreviewPlaybackOptions) {
      active = next.active;
      if (!active) {
        generation += 1;
        node.pause();
      }
    },
    destroy() {
      destroyed = true;
      node.pause();
      node.removeAttribute("src");
      node.load();
    },
  };
}
