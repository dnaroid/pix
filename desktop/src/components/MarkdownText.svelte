<script lang="ts">
  import { openExternalHref } from "../lib/external-links";
  import { renderMarkdown } from "../lib/markdown";
  import { renderMermaidDiagram } from "../lib/mermaid";

  let {
    text,
    compact = false,
    onOpenProjectFile,
  }: {
    text: string;
    compact?: boolean;
    onOpenProjectFile?: (path: string) => void | Promise<void>;
  } = $props();
  let html = $derived(renderMarkdown(text));

  function markdownContent(node: HTMLElement, _renderedHtml: string) {
    let generation = 0;
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");

    function scheduleRender() {
      generation += 1;
      const scheduledGeneration = generation;
      queueMicrotask(() => void renderDiagrams(scheduledGeneration));
    }

    async function renderDiagrams(scheduledGeneration: number) {
      if (scheduledGeneration !== generation) return;

      const diagrams = Array.from(node.querySelectorAll<HTMLElement>(".mermaid-diagram"));
      for (const diagram of diagrams) {
        const source = diagram.dataset.mermaidSource;
        const canvas = diagram.querySelector<HTMLElement>(".mermaid-canvas");
        if (source === undefined || !canvas) continue;

        canvas.setAttribute("aria-busy", "true");
        try {
          const svg = await renderMermaidDiagram(source, node);
          if (scheduledGeneration !== generation || !node.contains(diagram)) return;

          if (svg) {
            canvas.innerHTML = svg;
            canvas.setAttribute("role", "img");
            canvas.setAttribute("aria-label", "Mermaid diagram");
            diagram.dataset.mermaidState = "rendered";
          } else {
            showMermaidError(canvas, diagram);
          }
        } catch (error: unknown) {
          if (scheduledGeneration !== generation || !node.contains(diagram)) return;
          console.warn("Failed to render Mermaid diagram", error);
          showMermaidError(canvas, diagram);
        } finally {
          if (scheduledGeneration === generation && node.contains(canvas)) {
            canvas.setAttribute("aria-busy", "false");
          }
        }
      }
    }

    function handleColorSchemeChange() {
      scheduleRender();
    }

    colorScheme.addEventListener("change", handleColorSchemeChange);
    scheduleRender();
    return {
      update(_nextHtml: string) {
        scheduleRender();
      },
      destroy() {
        generation += 1;
        colorScheme.removeEventListener("change", handleColorSchemeChange);
      },
    };
  }

  function showMermaidError(canvas: HTMLElement, diagram: HTMLElement) {
    const message = document.createElement("p");
    message.className = "mermaid-error";
    message.textContent = "Could not render this Mermaid diagram. Source is shown below.";
    canvas.replaceChildren(message);
    canvas.removeAttribute("role");
    canvas.removeAttribute("aria-label");
    diagram.dataset.mermaidState = "error";
  }

  function linkClicks(node: HTMLElement) {
    function handleClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return;

      const projectFileLink = event.target.closest("a[data-project-file]");
      if (projectFileLink && node.contains(projectFileLink)) {
        event.preventDefault();
        const path = projectFileLink.getAttribute("data-project-file");
        if (path) void onOpenProjectFile?.(path);
        return;
      }

      const link = event.target.closest("a[data-external-link]");
      if (!link || !node.contains(link)) return;

      event.preventDefault();
      void openExternalHref(link.getAttribute("href") ?? "").catch((error: unknown) => {
        console.error("Failed to open external link", error);
      });
    }

    node.addEventListener("click", handleClick);
    return {
      destroy() {
        node.removeEventListener("click", handleClick);
      },
    };
  }
</script>

<div class:compact class="markdown-text" use:linkClicks use:markdownContent={html}>{@html html}</div>

<style>
  .markdown-text {
    min-width: 0;
    line-height: 1.625;
    overflow-wrap: anywhere;
  }

  :global(.markdown-text > :first-child) { margin-top: 0; }
  :global(.markdown-text > :last-child) { margin-bottom: 0; }
  .markdown-text :global(p) { margin: 0 0 0.75rem; }
  .markdown-text :global(strong) { font-weight: 600; }
  .markdown-text :global(em) {
    font-style: italic;
    font-synthesis: style;
  }
  .markdown-text :global(del) {
    color: var(--muted-foreground);
    text-decoration-thickness: 1px;
  }
  .markdown-text :global(h1),
  .markdown-text :global(h2),
  .markdown-text :global(h3),
  .markdown-text :global(h4),
  .markdown-text :global(h5),
  .markdown-text :global(h6) {
    margin: 1.1em 0 0.45em;
    color: inherit;
    font-weight: 600;
    line-height: 1.3;
  }
  .markdown-text :global(h1) { font-size: 1.35rem; }
  .markdown-text :global(h2) { font-size: 1.2rem; }
  .markdown-text :global(h3) { font-size: 1.08rem; }
  .markdown-text :global(h4),
  .markdown-text :global(h5),
  .markdown-text :global(h6) { font-size: 1rem; }
  .markdown-text.compact :global(h1),
  .markdown-text.compact :global(h2),
  .markdown-text.compact :global(h3),
  .markdown-text.compact :global(h4),
  .markdown-text.compact :global(h5),
  .markdown-text.compact :global(h6) { font-size: 1em; }
  .markdown-text :global(ul),
  .markdown-text :global(ol) {
    margin: 0.4rem 0 0.8rem;
    padding-left: 1.35rem;
  }
  .markdown-text :global(ul) { list-style: disc; }
  .markdown-text :global(ol) { list-style: decimal; }
  .markdown-text :global(li + li) { margin-top: 0.2rem; }
  .markdown-text :global(.task-item) {
    display: flex;
    align-items: baseline;
    gap: 0.45rem;
    list-style: none;
  }
  .markdown-text :global(.task-item input) {
    width: 0.8rem;
    height: 0.8rem;
    margin: 0;
    accent-color: var(--primary);
  }
  .markdown-text :global(blockquote) {
    margin: 0.65rem 0;
    padding-left: 0.85rem;
    border-left: 2px solid var(--border);
    color: var(--muted-foreground);
  }
  .markdown-text :global(hr) {
    margin: 1rem 0;
    border: 0;
    border-top: 1px solid var(--border);
  }
  .markdown-text :global(a) {
    color: var(--primary);
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, currentColor 50%, transparent);
    text-underline-offset: 2px;
  }
  .markdown-text :global(a:hover) { text-decoration-color: currentColor; }
  .markdown-text :global(a[data-project-file]) {
    border-radius: calc(var(--radius) - 10px);
    background: var(--muted);
    box-decoration-break: clone;
    padding: 0.08em 0.3em;
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 0.92em;
    -webkit-box-decoration-break: clone;
  }
  .markdown-text :global(a[data-project-file]:hover) { background: var(--accent); }
  .markdown-text :global(a[data-project-file] > code) {
    background: transparent;
    padding: 0;
    font-size: inherit;
  }
  .markdown-text :global(a:focus-visible) {
    border-radius: var(--radius-sm);
    outline: 2px solid var(--ring);
    outline-offset: 2px;
  }
  .markdown-text :global(code) {
    border-radius: var(--radius-sm);
    background: var(--muted);
    padding: 0.12em 0.32em;
    color: var(--primary);
    font-family: "Geist Mono", ui-monospace, monospace;
    font-size: 0.88em;
  }
  .markdown-text :global(pre) {
    max-width: 100%;
    margin: 0.75rem 0;
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--muted);
    padding: 0.75rem;
  }
  .markdown-text :global(pre code) {
    display: block;
    width: max-content;
    min-width: 100%;
    border-radius: 0;
    background: transparent;
    padding: 0;
    color: inherit;
    white-space: pre;
  }
  .markdown-text :global(pre code.highlighted-code) {
    /* Sugar High emits block line spans separated by literal newlines. */
    white-space: normal;
  }
  .markdown-text :global(.highlighted-code .sh__line) {
    display: block;
    min-height: 1.45em;
    white-space: pre;
    line-height: 1.45;
  }
  .markdown-text :global(.table-scroll) {
    max-width: 100%;
    margin: 0.75rem 0;
    overflow-x: auto;
  }
  .markdown-text :global(table) {
    width: max-content;
    border-collapse: collapse;
    border: 1px solid var(--border);
    font-size: 0.94em;
  }
  .markdown-text :global(th),
  .markdown-text :global(td) {
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    padding: 0.4rem 0.65rem;
    text-align: left;
    vertical-align: top;
  }
  .markdown-text :global(th:last-child),
  .markdown-text :global(td:last-child) {
    border-right: 0;
  }
  .markdown-text :global(th) {
    background: color-mix(in srgb, var(--muted) 65%, transparent);
    font-weight: 600;
  }
  .markdown-text :global(.align-center) { text-align: center; }
  .markdown-text :global(.align-right) { text-align: right; }
  .markdown-text :global(.align-left) { text-align: left; }
  .markdown-text :global(.mermaid-diagram) {
    max-width: 100%;
    margin: 0.75rem 0;
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--card);
    padding: 0.75rem;
  }
  .markdown-text :global(.mermaid-canvas) {
    min-height: 2rem;
    color: var(--muted-foreground);
  }
  .markdown-text :global(.mermaid-canvas svg) {
    display: block;
    height: auto;
    margin: 0 auto;
  }
  .markdown-text :global(.mermaid-fallback) {
    margin: 0;
  }
  .markdown-text :global(.mermaid-diagram[data-mermaid-state="rendered"] .mermaid-fallback) {
    display: none;
  }
  .markdown-text :global(.mermaid-error) {
    margin: 0 0 0.5rem;
    color: var(--destructive);
    font-size: 0.9em;
  }
</style>
