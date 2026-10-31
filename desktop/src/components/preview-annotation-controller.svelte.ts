import type { FileAnnotation, FileAnnotations } from "../lib/acp-pix-extensions";

export type PreviewAnnotationStatus = "idle" | "loading" | "done" | "error";
export type PreviewFileAnnotator = (
  request: { readonly path: string; readonly text: string },
  signal: AbortSignal,
) => Promise<FileAnnotations>;

interface PreviewAnnotationControllerOptions {
  readonly annotate: () => PreviewFileAnnotator | undefined;
  readonly onError: (error: unknown) => void;
}

/** Session-only memory of finished annotations, so reopening a file is free. */
const RESULT_CACHE_LIMIT = 24;

/**
 * Inline commentary state for one Preview. A changed document aborts the
 * running request and hides notes (a cached result for the new content is
 * reused on the next toggle); late output from aborted requests is ignored.
 */
export function createPreviewAnnotationController(options: PreviewAnnotationControllerOptions) {
  const state = $state({
    showing: false,
    status: "idle" as PreviewAnnotationStatus,
    annotations: [] as readonly FileAnnotation[],
    error: "",
    language: "",
    annotatedLines: 0,
    totalLines: 0,
  });
  const results = new Map<string, FileAnnotations>();
  let controller: AbortController | null = null;
  let sourceKey: string | undefined;
  let disposed = false;

  function abort(): void {
    controller?.abort();
    controller = null;
  }

  function apply(result: FileAnnotations): void {
    Object.assign(state, {
      status: "done", error: "", annotations: result.annotations, language: result.language,
      annotatedLines: result.annotatedLines, totalLines: result.totalLines,
    });
  }

  function setSource(key: string): void {
    if (key === sourceKey) return;
    sourceKey = key;
    abort();
    Object.assign(state, { showing: false, status: "idle", annotations: [], error: "", language: "", annotatedLines: 0, totalLines: 0 });
  }

  function remember(key: string, result: FileAnnotations): void {
    results.delete(key);
    results.set(key, result);
    for (const oldest of results.keys()) {
      if (results.size <= RESULT_CACHE_LIMIT) break;
      results.delete(oldest);
    }
  }

  async function annotate(path: string, text: string, refresh = false): Promise<void> {
    if (disposed || !text.trim()) return;
    const owner = sourceKey;
    const cached = owner !== undefined && !refresh ? results.get(owner) : undefined;
    if (cached) { abort(); apply(cached); state.showing = true; return; }
    const annotator = options.annotate();
    if (!annotator) return;
    abort();
    const own = new AbortController();
    controller = own;
    const current = () => controller === own && sourceKey === owner && !disposed;
    Object.assign(state, { showing: true, status: "loading", error: "" });
    try {
      const result = await annotator({ path, text }, own.signal);
      if (!current()) return;
      if (owner !== undefined) remember(owner, result);
      apply(result);
    } catch (error) {
      if (!current() || own.signal.aborted) return;
      Object.assign(state, { status: "error", error: error instanceof Error ? error.message : String(error) });
      options.onError(error);
    } finally {
      if (controller === own) controller = null;
    }
  }

  function toggle(path: string, text: string): void {
    if (state.showing) { state.showing = false; return; }
    if (state.status === "done" || state.status === "loading") { state.showing = true; return; }
    void annotate(path, text);
  }

  function cancel(): void {
    if (state.status !== "loading") return;
    abort();
    Object.assign(state, { showing: false, status: "idle" });
  }

  function dispose(): void {
    disposed = true;
    abort();
    results.clear();
  }

  return {
    state,
    get running() { return state.status === "loading"; },
    setSource,
    annotate,
    toggle,
    hide: () => { state.showing = false; },
    cancel,
    dispose,
  };
}
