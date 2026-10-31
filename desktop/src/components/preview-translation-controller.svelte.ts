import type { DocumentTranslation } from "../lib/acp-pix-extensions";

export type PreviewTranslationStatus = "idle" | "loading" | "streaming" | "done" | "error";
export type PreviewTranslationDelta = { readonly text: string } | { readonly reset: true };
export type PreviewDocumentTranslator = (
  request: { readonly path: string; readonly text: string; readonly refresh?: boolean },
  signal: AbortSignal,
  onDelta: (delta: PreviewTranslationDelta) => void,
) => Promise<DocumentTranslation>;

interface PreviewTranslationControllerOptions {
  readonly translate: () => PreviewDocumentTranslator | undefined;
  readonly onError: (error: unknown) => void;
}

/**
 * Whole-document translation state for one Preview. A changed document
 * (another preview, path or content) aborts and drops the translation; a
 * newer request aborts the previous one, and late output from an aborted or
 * superseded request is ignored. `dispose` aborts the in-flight request.
 */
export function createPreviewTranslationController(options: PreviewTranslationControllerOptions) {
  const state = $state({
    /** Rendered Preview shows the translation instead of the original. */
    showing: false,
    status: "idle" as PreviewTranslationStatus,
    text: "",
    error: "",
    language: "",
    chunks: 0,
    cachedChunks: 0,
  });
  let controller: AbortController | null = null;
  let sourceKey: string | undefined;
  let disposed = false;

  function abort(): void {
    controller?.abort();
    controller = null;
  }

  function reset(): void {
    abort();
    Object.assign(state, { showing: false, status: "idle", text: "", error: "", language: "", chunks: 0, cachedChunks: 0 });
  }

  /** Bind to the current document; a different identity or content discards the old translation. */
  function setSource(key: string): void {
    if (key === sourceKey) return;
    sourceKey = key;
    reset();
  }

  async function translate(path: string, text: string, refresh = false): Promise<void> {
    if (disposed) return;
    const translator = options.translate();
    if (!translator || !text.trim()) return;
    abort();
    const own = new AbortController();
    controller = own;
    const owner = sourceKey;
    const current = () => controller === own && sourceKey === owner && !disposed;
    Object.assign(state, { showing: true, status: "loading", text: "", error: "" });
    try {
      const result = await translator({ path, text, ...(refresh ? { refresh: true } : {}) }, own.signal, (delta) => {
        if (!current()) return;
        state.text = "reset" in delta ? "" : state.text + delta.text;
        state.status = state.text ? "streaming" : "loading";
      });
      if (!current()) return;
      Object.assign(state, {
        status: "done", text: result.text, language: result.language, chunks: result.chunks, cachedChunks: result.cachedChunks,
      });
    } catch (error) {
      if (!current() || own.signal.aborted) return;
      Object.assign(state, { status: "error", error: error instanceof Error ? error.message : String(error) });
      options.onError(error);
    } finally {
      if (controller === own) controller = null;
    }
  }

  /** Header toggle: show a finished translation again, or start one. */
  function toggle(path: string, text: string): void {
    if (state.showing) { state.showing = false; return; }
    if (state.status === "done" || state.status === "streaming" || state.status === "loading") { state.showing = true; return; }
    void translate(path, text);
  }

  function cancel(): void {
    abort();
    if (state.status === "loading" || state.status === "streaming") reset();
  }

  function dispose(): void {
    disposed = true;
    abort();
  }

  return {
    state,
    get running() { return state.status === "loading" || state.status === "streaming"; },
    setSource,
    translate,
    toggle,
    showOriginal: () => { state.showing = false; },
    cancel,
    dispose,
  };
}
