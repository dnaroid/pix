import { PROJECT_FILE_DROP_EVENT, PROJECT_FILE_HOVER_EVENT, type ProjectFileDrop } from "../lib/desktop-file-drop";
import { projectTreeAbsolutePath } from "../lib/project-tree";
import type { ProjectFileRequest } from "./project-explorer-history.svelte";

export function installProjectExplorerNativeDrop(panel: HTMLElement, options: {
  workspace: () => string;
  generation: () => number;
  hover: (destination: string | null) => void;
  mutate: (request: ProjectFileRequest, label: string) => Promise<unknown>;
  report: (error: unknown) => void;
  error: (message: string) => void;
}): () => void {
  let disposed = false;
  const hover = (event: Event) => options.hover((event as CustomEvent<string | null>).detail);
  function drop(event: Event) {
    const { reference, destination, operation: requestedOperation } = (event as CustomEvent<ProjectFileDrop>).detail;
    const workspace = options.workspace();
    const generation = options.generation();
    const current = () => !disposed && workspace === options.workspace() && generation === options.generation();
    void reference.then(async ({ reference: copied, source }) => {
      if (!current()) return;
      const operation = source?.workspace === workspace ? "move" : requestedOperation;
      const target = projectTreeAbsolutePath(workspace, destination);
      const paths = (copied.entries ?? [copied]).map((entry) => entry.path).filter((path) => {
        const source = projectTreeAbsolutePath(copied.workspace, path);
        return operation !== "move" || source.slice(0, source.lastIndexOf("/") + 1) !== `${target.replace(/\/$/u, "")}/`;
      });
      if (!paths.length) return;
      await options.mutate({ type: operation === "move" ? "importMove" : "copy", paths, destination, sourceWorkspace: copied.workspace }, operation === "move" ? "Move from Finder" : "Copy from Finder");
    }).catch((error) => {
      options.report(error);
      if (current()) options.error(error instanceof Error ? error.message : String(error));
    });
  }
  panel.addEventListener(PROJECT_FILE_HOVER_EVENT, hover);
  panel.addEventListener(PROJECT_FILE_DROP_EVENT, drop);
  return () => {
    disposed = true;
    panel.removeEventListener(PROJECT_FILE_HOVER_EVENT, hover);
    panel.removeEventListener(PROJECT_FILE_DROP_EVENT, drop);
    options.hover(null);
  };
}
