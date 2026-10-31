import type { FileAnnotation, FileAnnotationProgress, FileAnnotations } from "../lib/acp-pix-extensions";

export type PreviewAnnotationStatus = "idle" | "loading" | "done" | "error";
export type PreviewFileAnnotator = (
  request: { readonly path: string; readonly text: string; readonly refresh?: boolean },
  signal: AbortSignal,
  onProgress: (progress: FileAnnotationProgress) => void,
) => Promise<FileAnnotations>;

interface PreviewAnnotationControllerOptions {
  readonly annotate: () => PreviewFileAnnotator | undefined;
  readonly onError: (error: unknown) => void;
}

/** Session memory in front of ACP's durable `.pi/explanations` cache; keyed by content, so edits miss. */
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
    summary: "",
    annotations: [] as readonly FileAnnotation[],
    error: "",
    language: "",
    annotatedLines: 0,
    totalLines: 0,
    /** Parallel parts of a large file; notes arrive per finished part. */
    completedParts: 0,
    totalParts: 0,
    failedParts: 0,
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
      status: "done", error: "", summary: result.summary, annotations: result.annotations, language: result.language,
      annotatedLines: result.annotatedLines, totalLines: result.totalLines,
      completedParts: result.parts, totalParts: result.parts, failedParts: result.failedParts,
    });
  }

  function setSource(key: string): void {
    if (key === sourceKey) return;
    sourceKey = key;
    abort();
    Object.assign(state, {
      showing: false, status: "idle", summary: "", annotations: [], error: "", language: "", annotatedLines: 0, totalLines: 0,
      completedParts: 0, totalParts: 0, failedParts: 0,
    });
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
    Object.assign(state, { showing: true, status: "loading", error: "", summary: "", annotations: [], completedParts: 0, totalParts: 0, failedParts: 0 });
    try {
      const result = await annotator({ path, text, ...(refresh ? { refresh: true } : {}) }, own.signal, (progress) => {
        if (!current()) return;
        if (progress.summary) state.summary = progress.summary;
        if (progress.annotations?.length) state.annotations = mergeNotes(state.annotations, progress.annotations);
        state.completedParts = progress.completedParts;
        state.totalParts = progress.totalParts;
      });
      if (!current()) return;
      // A partial result (failed parts) is shown but not remembered, so the next open retries the gaps.
      if (owner !== undefined && result.failedParts === 0) remember(owner, result);
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

function mergeNotes(current: readonly FileAnnotation[], incoming: readonly FileAnnotation[]): FileAnnotation[] {
  const byLine = new Map(current.map((note) => [note.line, note.text]));
  for (const note of incoming) byLine.set(note.line, note.text);
  return [...byLine].sort(([left], [right]) => left - right).map(([line, text]) => ({ line, text }));
}
