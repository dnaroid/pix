/** Promote only validated candidates; keep the label DOM and navigation metadata intact. */
export function replaceFileLinkCandidate(
  candidate: HTMLElement,
  target: { path: string; projectPath: string | undefined },
  template?: SVGElement,
): void {
  const link = document.createElement("a");
  link.href = "#";
  link.title = `${target.projectPath ? "Preview" : "Open"} ${target.path}`;
  if (target.projectPath) {
    link.dataset.projectFile = target.path;
    const startLine = candidate.dataset.projectFileStartLine;
    const endLine = candidate.dataset.projectFileEndLine;
    if (startLine) link.dataset.projectFileStartLine = startLine;
    if (endLine) link.dataset.projectFileEndLine = endLine;
  } else {
    link.dataset.localFile = target.path;
  }
  if (template) {
    const icon = template.cloneNode(true) as SVGElement;
    icon.classList.add("markdown-file-link-icon");
    icon.setAttribute("aria-hidden", "true");
    link.append(icon);
  }
  while (candidate.firstChild) link.append(candidate.firstChild);
  candidate.replaceWith(link);
}
