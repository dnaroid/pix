// Keep hydrated image/model subtrees alive across Svelte's {@html} replacements.
// Identity includes the original caption/attributes, not just the file path;
// duplicate occurrences each own a distinct DOM node.
export class MarkdownImageRetention {
  constructor(private readonly kind: "image" | "model" = "image") {}
  private originals = new WeakMap<HTMLElement, string>();
  private previous = new Map<string, HTMLElement[]>();

  restore(root: HTMLElement): void {
    const next = new Map<string, HTMLElement[]>();
    const candidates = root.querySelectorAll<HTMLElement>(
      `.markdown-media[data-project-media="${this.kind}"], .markdown-media[data-local-media="${this.kind}"]`,
    );
    for (const candidate of candidates) {
      // Also explicit for minimal DOM hosts that don't implement CSS filtering.
      if ((candidate.dataset.projectMedia ?? candidate.dataset.localMedia) !== this.kind) continue;
      const key = this.originals.get(candidate) ?? candidate.outerHTML;
      const retained = this.previous.get(key)?.shift() ?? candidate;
      if (retained !== candidate) candidate.replaceWith(retained);
      this.originals.set(retained, key);
      const occurrences = next.get(key) ?? [];
      occurrences.push(retained);
      next.set(key, occurrences);
    }
    this.previous = next;
  }

  clear(): void {
    this.previous.clear();
    this.originals = new WeakMap();
  }
}
