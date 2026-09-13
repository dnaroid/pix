import { openExternalHref } from "../lib/external-links";
import type { ProjectFileLineRange } from "../lib/project-files";

interface MarkdownLinkActionOptions {
  readonly onOpenProjectFile: () => ((path: string, range?: ProjectFileLineRange) => void | Promise<void>) | undefined;
  readonly onOpenLocalFile: () => ((path: string) => void | Promise<void>) | undefined;
}

export function createMarkdownLinkAction(options: MarkdownLinkActionOptions) {
  return function linkClicks(node: HTMLElement) {
    function handleClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0 || !(event.target instanceof Element)) return;

      const projectFileLink = event.target.closest("a[data-project-file]");
      if (projectFileLink && node.contains(projectFileLink)) {
        event.preventDefault();
        const path = projectFileLink.getAttribute("data-project-file");
        if (path) {
          const startLine = Number(projectFileLink.getAttribute("data-project-file-start-line"));
          const endLine = Number(projectFileLink.getAttribute("data-project-file-end-line"));
          const range = Number.isSafeInteger(startLine) && startLine > 0
            ? {
                startLine,
                endLine: Number.isSafeInteger(endLine) && endLine > 0 ? endLine : startLine,
              }
            : undefined;
          void options.onOpenProjectFile()?.(path, range);
        }
        return;
      }

      const localFileLink = event.target.closest("a[data-local-file]");
      if (localFileLink && node.contains(localFileLink)) {
        event.preventDefault();
        const path = localFileLink.getAttribute("data-local-file");
        if (path) void options.onOpenLocalFile()?.(path);
        return;
      }

      const anchorLink = event.target.closest("a[data-markdown-anchor]");
      if (anchorLink && node.contains(anchorLink)) {
        event.preventDefault();
        const id = anchorLink.getAttribute("data-markdown-anchor");
        const heading = id
          ? Array.from(node.querySelectorAll<HTMLElement>("[id]")).find((element) => element.id === id)
          : undefined;
        heading?.scrollIntoView({ behavior: "smooth", block: "start" });
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
  };
}
