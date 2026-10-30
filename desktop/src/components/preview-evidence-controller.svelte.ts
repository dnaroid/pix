import { tick, untrack } from "svelte";
import type { KnowledgeCitation } from "../../../acp/src/knowledge/contract";
import { matchKnowledgeCitation, type KnowledgeEvidenceDisplay } from "../lib/knowledge-citation";
import type { PreviewScrollPosition } from "../lib/preview-history";
import type { ProjectFilePreview } from "../lib/project-files";
import { decorateEvidence, type EvidenceDecoration } from "./preview-evidence-highlight";
import { renderedRangeElements, scheduleAfterScrollRestore } from "./preview-scroll-controller.svelte";

interface PreviewEvidenceOptions {
  readonly previewId: () => number;
  readonly workspace: () => string;
  readonly active: () => boolean;
  readonly citation: () => KnowledgeCitation | undefined;
  readonly file: () => ProjectFilePreview | undefined;
  readonly content: () => string;
  readonly element: () => HTMLDivElement | undefined;
  readonly editing: () => boolean;
  readonly scrollPosition: () => PreviewScrollPosition;
  readonly onError?: (error: unknown) => void;
}

export function createPreviewEvidenceController(options: PreviewEvidenceOptions) {
  let status = $state<KnowledgeEvidenceDisplay>("idle");
  let disposed = false;
  let cancelCurrent = () => {};

  $effect(() => {
    const previewId = options.previewId();
    const workspace = options.workspace();
    const citation = options.citation();
    const file = options.file();
    const content = options.content();
    const scroll = options.element();
    const active = options.active();
    const editing = options.editing();
    status = "idle";
    if (disposed || !citation || !file || !scroll || !active || editing) return;

    // Validate the actual file again after a save/update. Never substitute a
    // report's old line numbers when the quoted text changed or became ambiguous.
    const match = matchKnowledgeCitation(file.content, file.path, citation);
    if (match.status !== "matched") { status = match.status; return; }
    const savedScroll = untrack(options.scrollPosition);
    const reveal = savedScroll.top === 0 && savedScroll.left === 0;
    let cancelled = false;
    let cancelReveal = () => {};
    let decoration: EvidenceDecoration | undefined;
    const current = () => !cancelled && !disposed && options.active() && !options.editing()
      && options.previewId() === previewId && options.workspace() === workspace
      && options.file() === file && options.content() === content
      && options.element() === scroll && options.citation() === citation;

    void tick().then(() => {
      if (!current()) return;
      cancelReveal = scheduleAfterScrollRestore(() => {
        if (!current()) return;
        try {
          const blocks = renderedRangeElements(scroll, match.range);
          decoration = decorateEvidence(scroll.ownerDocument, blocks, match.quote);
          status = decoration.status;
          // History restores and a user's intervening scroll take priority.
          if (!reveal || scroll.scrollTop !== 0 || scroll.scrollLeft !== 0 || !decoration.target) return;
          const scrollRect = scroll.getBoundingClientRect();
          const rect = decoration.range?.getBoundingClientRect() ?? decoration.target.getBoundingClientRect();
          const targetTop = scroll.scrollTop + rect.top - scrollRect.top - Math.max(24, (scroll.clientHeight - rect.height) * 0.35);
          scroll.scrollTo({ top: Math.max(0, targetTop), behavior: "auto" });
        } catch (error) {
          decoration?.cleanup();
          decoration = undefined;
          status = "source";
          options.onError?.(error);
        }
      });
    });
    const cancel = () => { cancelled = true; cancelReveal(); decoration?.cleanup(); };
    cancelCurrent = cancel;
    return cancel;
  });

  return {
    get status() { return status; },
    dispose(): void { disposed = true; cancelCurrent(); },
  };
}
