import type { KnowledgeCitation } from "../../../acp/src/knowledge/contract";
import { isKnowledgeDocumentPath } from "../lib/knowledge-citation";
import { wikiCitationContext, wikiCitationSourceLines, type WikiCitationContext } from "../lib/wiki-citation-context";
import type { WikiFileDates, WikiFileDatesRequest } from "../lib/wiki-file-dates";
import { wikiEditableBlock, type WikiEditableBlock } from "../lib/wiki-side-edit";
import type { WikiFinding } from "../lib/wiki-conflicts-index";

export type WikiCompareSide =
  | { readonly state: "idle" }
  | { readonly state: "loading" }
  | {
    readonly state: "ready";
    readonly context: WikiCitationContext;
    /** Raw quote-block lines for inline editing; present only for a matched quotation. */
    readonly block?: WikiEditableBlock;
  }
  | { readonly state: "error"; readonly message: string };

interface Options {
  /** Reads the current project file body; must honor the signal when possible. */
  readonly read: (path: string, signal: AbortSignal) => Promise<string>;
  readonly reportError: (error: unknown) => void;
  /**
   * Optional Git/file timestamps of one side. Supplementary: failures resolve to
   * null and are reported by the loader itself, never as a comparison error.
   */
  readonly dates?: (request: WikiFileDatesRequest, signal: AbortSignal) => Promise<WikiFileDates | null>;
}

const IDLE: WikiCompareSide = { state: "idle" };
const LOADING: WikiCompareSide = { state: "loading" };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Lazily reads both sides of the selected finding. Only the latest selection may
 * publish: switching findings aborts older reads and drops their late responses.
 */
export function createWikiConflictCompare(options: Options) {
  let draft = $state<WikiCompareSide>(IDLE);
  let existing = $state<WikiCompareSide>(IDLE);
  let draftDates = $state<WikiFileDates | null>(null);
  let existingDates = $state<WikiFileDates | null>(null);
  let token = 0;
  let controller: AbortController | undefined;
  let selectedId: string | null = null;
  let selected: WikiFinding | null = null;
  let disposed = false;

  function abort(): void {
    controller?.abort(new Error("Wiki conflict comparison superseded."));
    controller = undefined;
  }

  function select(finding: WikiFinding | null): void {
    if (disposed) return;
    abort();
    const current = ++token;
    const sameFinding = finding !== null && finding.id === selectedId;
    selectedId = finding?.id ?? null;
    selected = finding;
    if (!finding) { draft = IDLE; existing = IDLE; draftDates = null; existingDates = null; return; }
    if (!sameFinding) { draftDates = null; existingDates = null; }
    // Re-reading the same finding after a scan keeps the old context visible.
    if (!sameFinding || draft.state !== "ready") draft = LOADING;
    if (!sameFinding || existing.state !== "ready") existing = LOADING;
    const signal = (controller = new AbortController()).signal;
    const reads = new Map<string, Promise<string>>();
    let reported = false;
    const load = async (citation: KnowledgeCitation): Promise<{ side: WikiCompareSide; content?: string }> => {
      if (!isKnowledgeDocumentPath(citation.path)) return { side: { state: "ready", context: { status: "invalid" } } };
      let pending = reads.get(citation.path);
      if (!pending) reads.set(citation.path, pending = options.read(citation.path, signal));
      try {
        const content = await pending;
        const context = wikiCitationContext(content, citation);
        const block = context.status === "matched" ? wikiEditableBlock(content, context.startLine, context.endLine) : undefined;
        return { side: { state: "ready", context, ...(block ? { block } : {}) }, content };
      } catch (error) {
        if (current === token && !signal.aborted && !reported) {
          reported = true;
          options.reportError(error);
        }
        return { side: { state: "error", message: message(error) } };
      }
    };
    const loadDates = async (citation: KnowledgeCitation, content: string): Promise<WikiFileDates | null> => {
      const lines = wikiCitationSourceLines(content, citation.quote);
      try {
        return await options.dates!({ path: citation.path, ...(lines ? { lines } : {}) }, signal);
      } catch {
        return null;
      }
    };
    const show = (citation: KnowledgeCitation, setSide: (side: WikiCompareSide) => void, setDates: (dates: WikiFileDates | null) => void) =>
      void load(citation).then(async ({ side, content }) => {
        if (current !== token) return;
        setSide(side);
        if (content === undefined || !options.dates) return;
        const dates = await loadDates(citation, content);
        if (current === token) setDates(dates);
      });
    show(finding.draft, side => { draft = side; }, dates => { draftDates = dates; });
    show(finding.existing, side => { existing = side; }, dates => { existingDates = dates; });
  }

  return {
    get draft() { return draft; },
    get existing() { return existing; },
    get draftDates() { return draftDates; },
    get existingDates() { return existingDates; },
    select,
    /** Re-reads the current finding (after an inline edit), keeping visible context meanwhile. */
    reload(): void { if (!disposed) select(selected); },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      token++;
      abort();
      selectedId = null;
      selected = null;
    },
  };
}

export type WikiConflictCompare = ReturnType<typeof createWikiConflictCompare>;
