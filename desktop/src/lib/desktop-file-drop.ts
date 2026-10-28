import { invoke } from "@tauri-apps/api/core";
import { decodeProjectEntryClipboard, type ProjectEntryClipboard } from "./project-entry-clipboard";
import { projectTreeAbsolutePath } from "./project-tree";

export const PROJECT_FILE_DROP_EVENT = "pix-native-file-drop";
export const PROJECT_FILE_HOVER_EVENT = "pix-native-file-hover";

export interface ProjectFileDrop {
  reference: Promise<ProjectEntryDrag>;
  destination: string;
  operation: "copy" | "move";
}
export interface ProjectEntryDrag {
  reference: ProjectEntryClipboard;
  source?: { workspace: string; paths: string[] } | null;
}
interface NativeFileDrop {
  reference: string;
  source?: ProjectEntryDrag["source"];
}

// Hover feedback only. Committed drops use immutable native source metadata,
// even if AppKit has already ended the source session before IPC resolves.
let sourceWorkspace: string | null = null;
export async function startProjectFileDrag(workspace: string, paths: string[], signal?: AbortSignal): Promise<void> {
  if (sourceWorkspace !== null || signal?.aborted) return;
  const dragId = crypto.randomUUID();
  let cancellation: Promise<unknown> | undefined;
  let cancelError: unknown;
  const cancel = () => {
    cancellation = invoke("cancel_project_entry_drag", { dragId }).catch((error: unknown) => { cancelError = error; });
  };
  sourceWorkspace = workspace;
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await invoke("start_project_entry_drag", { workspace, paths, dragId });
    await cancellation;
    if (cancelError) throw cancelError;
  } finally {
    signal?.removeEventListener("abort", cancel);
    sourceWorkspace = null;
  }
}

interface Options {
  workspace: () => string;
  sessionId: () => string | null;
  canAcceptAttachments: () => boolean;
  setDragActive: (active: boolean) => void;
  questionId: () => string | null;
  addQuestionPaths: (id: string, paths: readonly string[]) => void | Promise<void>;
  canInsertPromptPaths: () => boolean;
  insertPromptPaths: (paths: readonly string[]) => void | Promise<void>;
  reportError: (error: unknown) => void;
  read?: () => Promise<NativeFileDrop>;
}

/** DOM dropEffect participates in WebKit/AppKit negotiation. Capture Cmd at
 * the drop event, not later in an IPC callback after the user released it. */
export function installDesktopFileDrop(options: Options): () => void {
  let disposed = false;
  let hovered: HTMLElement | null = null;
  let depth = 0;
  const read = options.read ?? (() => invoke("capture_project_entry_drag")
    .then((snapshot) => invoke<NativeFileDrop>("read_project_entry_drag", { snapshot })));
  const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");

  function reference(): Promise<ProjectEntryDrag> {
    const snapshot = read().then((native) => {
      const value = decodeProjectEntryClipboard(native.reference);
      if (!value) throw new Error("The drag contains no supported files or folders.");
      return { reference: value, source: native.source };
    });
    // Rejected file rows still consume their native snapshot but do no work.
    void snapshot.catch(() => {});
    return snapshot;
  }

  function target(event: DragEvent) {
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const panel = hit?.closest<HTMLElement>("[data-project-explorer]") ?? null;
    const row = hit?.closest<HTMLElement>("[data-project-move-row]")
      ?? hit?.closest<HTMLElement>("[data-project-tree-path]");
    // A file row blocks the root fallback; only folders and tree background accept.
    const folder = row ?? hit?.closest<HTMLElement>("[data-project-move-target]");
    const destination = folder?.dataset.projectMoveTarget;
    const valid = panel && destination !== undefined && panel.dataset.projectWorkspace === options.workspace();
    return { panel, destination: valid ? destination : null };
  }

  function hover(panel: HTMLElement | null, destination: string | null) {
    if (hovered && hovered !== panel) hovered.dispatchEvent(new CustomEvent(PROJECT_FILE_HOVER_EVENT, { detail: null }));
    hovered = panel;
    hovered?.dispatchEvent(new CustomEvent(PROJECT_FILE_HOVER_EVENT, { detail: destination }));
  }
  function reset() {
    depth = 0;
    hover(null, null);
    options.setDragActive(false);
  }
  function over(event: DragEvent) {
    if (!isFileDrag(event)) return;
    if (event.type === "dragenter") depth++;
    // Prevent WebKit navigation to files, including over a rejected destination.
    event.preventDefault();
    const { panel, destination } = target(event);
    hover(panel, destination);
    const attachments = !panel && options.canAcceptAttachments();
    options.setDragActive(attachments);
    if (event.dataTransfer) {
      let effect: DataTransfer["dropEffect"] = "none";
      if (panel && destination !== null) effect = event.metaKey || sourceWorkspace === options.workspace() ? "move" : "copy";
      else if (attachments) effect = "copy";
      event.dataTransfer.dropEffect = effect;
    }
  }
  function leave(event: DragEvent) {
    if (!isFileDrag(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) reset();
  }
  function drop(event: DragEvent) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const pending = reference();
    const { panel, destination } = target(event);
    const localSource = sourceWorkspace;
    const operation = event.metaKey || localSource === options.workspace() ? "move" : "copy";
    reset();
    if (panel) {
      if (destination !== null) panel.dispatchEvent(new CustomEvent<ProjectFileDrop>(PROJECT_FILE_DROP_EVENT, {
        detail: { reference: pending, destination, operation },
      }));
      return;
    }
    const workspace = options.workspace();
    const session = options.sessionId();
    const question = options.questionId();
    if (!options.canAcceptAttachments()) return;
    void pending.then(async ({ reference: copied, source }) => {
      if (disposed || workspace !== options.workspace() || session !== options.sessionId() || question !== options.questionId()) return;
      const absolute = (copied.entries ?? [copied]).map((entry) => projectTreeAbsolutePath(copied.workspace, entry.path));
      // Composer drops are references only, regardless of Cmd. Do not mutate disk.
      if (question) await options.addQuestionPaths(question, absolute);
      else if (options.canInsertPromptPaths()) {
        await options.insertPromptPaths(source?.workspace === workspace
          ? source.paths
          : absolute);
      }
    }).catch(options.reportError);
  }
  const capture = { capture: true };
  document.addEventListener("dragenter", over, capture);
  document.addEventListener("dragover", over, capture);
  document.addEventListener("dragleave", leave, capture);
  document.addEventListener("drop", drop, capture);
  return () => {
    disposed = true;
    document.removeEventListener("dragenter", over, capture);
    document.removeEventListener("dragover", over, capture);
    document.removeEventListener("dragleave", leave, capture);
    document.removeEventListener("drop", drop, capture);
    reset();
  };
}
