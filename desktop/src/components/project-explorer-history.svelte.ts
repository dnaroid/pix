import type { ProjectTreeEntry } from "../lib/project-tree";

export interface ProjectFileChange { before: string | null; after: string | null }
export interface ProjectFileReceipt {
  token: string;
  entries: ProjectTreeEntry[];
  changes: ProjectFileChange[];
  warning: string | null;
  complete: boolean;
}
export type ProjectFileRequest =
  | { type: "create"; parent: string; name: string; kind: "file" | "directory" }
  | { type: "rename"; path: string; name: string }
  | { type: "move"; paths: string[]; destination: string }
  | { type: "delete"; paths: string[] }
  | { type: "copy"; paths: string[]; destination: string; sourceWorkspace?: string };

interface Options {
  workspace: () => string;
  invoke: (command: string, args: Record<string, unknown>) => Promise<ProjectFileReceipt>;
  prepare: () => Promise<() => void>;
  changed: (receipt: ProjectFileReceipt) => Promise<void>;
  warning: (warning: string) => void;
  forget: (tokens: string[]) => void;
}

/** Only completed, current mutations enter this panel's history. Disk recovery
 * data is backend-owned and is never purged when the panel drops its tokens. */
export function createProjectExplorerHistory(options: Options) {
  let undo = $state<string[]>([]);
  let redo = $state<string[]>([]);
  let active = $state(0);
  let generation = 0;

  async function run(request?: ProjectFileRequest, direction?: "undo" | "redo"): Promise<ProjectFileReceipt | null> {
    if (!request && active > 0) return null;
    const source = direction === "undo" ? undo : redo;
    const token = source.at(-1);
    if (!request && !token) return null;
    active++;
    const workspace = options.workspace();
    const owner = generation;
    const current = () => owner === generation && options.workspace() === workspace;
    let release: (() => void) | undefined;
    try {
      release = await options.prepare();
      if (!current()) return null;
      const receipt = request
        ? await options.invoke("mutate_project_entries", { workspace, request })
        : await options.invoke("replay_project_entries", { workspace, token, undo: direction === "undo" });
      if (!current()) { if (request) options.forget([receipt.token]); return null; }
      // Record before refreshing: a failed UI refresh must not lose undoability.
      if (request) {
        options.forget([...undo.slice(0, -99), ...redo]);
        undo = [...undo.slice(-99), receipt.token]; redo = [];
      }
      else if (receipt.complete) {
        if (direction === "undo") { undo = undo.slice(0, -1); redo = [...redo, receipt.token]; }
        else { redo = redo.slice(0, -1); undo = [...undo, receipt.token]; }
      }
      await options.changed(receipt);
      if (current() && receipt.warning) options.warning(receipt.warning);
      return current() ? receipt : null;
    } finally {
      release?.();
      if (current()) active--;
    }
  }

  return {
    get busy() { return active > 0; },
    get canUndo() { return active === 0 && undo.length > 0; },
    get canRedo() { return active === 0 && redo.length > 0; },
    execute: (request: ProjectFileRequest) => run(request),
    undo: () => run(undefined, "undo"),
    redo: () => run(undefined, "redo"),
    invalidate() { generation++; options.forget([...undo, ...redo]); undo = []; redo = []; active = 0; },
  };
}
