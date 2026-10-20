import { createDiagnosticLogger } from "../lib/diagnostic-logging";
import { decodeOggSource, isOggAudioPath } from "../lib/ogg-audio-source";
import { previewMediaPlayback } from "./audio-playback-action";

interface AudioSourceOptions {
  source: string;
  path: string;
  active?: boolean;
  autoplay?: boolean;
  onAutoplayConsumed?: () => void;
  onUnavailable: () => void;
}

const diagnostics = createDiagnosticLogger(() => ({ workspace: "" }));

/** Sole source/playback owner for inline and Preview audio, including decoded URLs. */
export function audioSource(node: HTMLAudioElement, initial: AudioSourceOptions) {
  let options = initial;
  let destroyed = false;
  let generation = 0;
  let phase: "native" | "decoding" | "decoded" | "failed" = "native";
  let pendingAutoplay = false;
  let objectUrl: string | undefined;
  let controller: AbortController | undefined;
  let playback: ReturnType<typeof previewMediaPlayback> | undefined;

  function release(): void {
    generation++;
    controller?.abort();
    controller = undefined;
    if (playback) playback.destroy();
    else { node.pause(); node.removeAttribute("src"); node.load(); }
    playback = undefined;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = undefined;
  }

  function start(first = false): void {
    phase = "native";
    pendingAutoplay = Boolean(first && options.autoplay && options.active !== false);
    if (first && options.autoplay) options.onAutoplayConsumed?.();
    node.src = options.source;
  }

  function ready(): void {
    if (destroyed || playback || (phase !== "native" && phase !== "decoded") || node.readyState < 1) return;
    playback = previewMediaPlayback(node, {
      active: options.active !== false,
      autoplay: pendingAutoplay,
      onAutoplayConsumed: () => {}, // The request was consumed at mount, not after async decoding.
    });
  }

  function playing(): void { pendingAutoplay = false; }
  function requestedPlay(): void {
    if (phase === "native" && options.active !== false) pendingAutoplay = true;
  }

  function unavailable(error: unknown): void {
    phase = "failed";
    pendingAutoplay = false;
    release();
    diagnostics.report(error instanceof Error ? error.message : "Audio playback unavailable.", "media:playback-unavailable");
    options.onUnavailable();
  }

  async function failed(): Promise<void> {
    if (destroyed || !node.error || phase === "failed" || phase === "decoding") return;
    const unsupported = node.error.code === 4 || (node.error.code === 3 && node.readyState === 0);
    if (phase !== "native" || !unsupported || !isOggAudioPath(options.path)) {
      unavailable(new Error(`Audio playback failed (media error ${node.error?.code ?? "unknown"}).`));
      return;
    }
    phase = "decoding";
    diagnostics.record("media:ogg-fallback");
    const owner = generation;
    const abort = new AbortController();
    controller = abort;
    try {
      const decodedUrl = await decodeOggSource(options.source, abort.signal);
      if (destroyed || owner !== generation || abort.signal.aborted) {
        URL.revokeObjectURL(decodedUrl);
        return;
      }
      // In case a native player managed metadata/playback before reporting its codec error.
      playback?.destroy();
      playback = undefined;
      objectUrl = decodedUrl;
      phase = "decoded";
      node.src = decodedUrl;
    } catch (error) {
      if (!destroyed && owner === generation && !abort.signal.aborted) unavailable(error);
    }
  }

  node.addEventListener("loadedmetadata", ready);
  node.addEventListener("canplay", ready);
  node.addEventListener("playing", playing);
  node.addEventListener("play", requestedPlay);
  node.addEventListener("error", failed);
  start(true);
  return {
    update(next: AudioSourceOptions): void {
      const changed = next.source !== options.source || next.path !== options.path;
      if (changed) release();
      options = next;
      if (changed) start();
      if (options.active === false) pendingAutoplay = false;
      playback?.update({ active: options.active !== false, autoplay: false, onAutoplayConsumed: () => {} });
      if (options.active === false) node.pause();
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      node.removeEventListener("loadedmetadata", ready);
      node.removeEventListener("canplay", ready);
      node.removeEventListener("playing", playing);
      node.removeEventListener("play", requestedPlay);
      node.removeEventListener("error", failed);
      release();
    },
  };
}
