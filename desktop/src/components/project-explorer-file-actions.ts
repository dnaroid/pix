import { invoke } from "@tauri-apps/api/core";
import type { ProjectTreeEntry } from "../lib/project-tree";
import { projectFileRequestClaims } from "./project-explorer-file-claims";
import { createProjectExplorerHistory, type ProjectFileRequest, type ProjectFileReceipt } from "./project-explorer-history.svelte";
import type { createProjectExplorerOperations, ProjectOperation } from "./project-explorer-operations.svelte";
import type { createProjectExplorerTreeController } from "./project-explorer-tree-controller.svelte";

interface Options {
  workspace: () => string;
  generation: () => number;
  operations: ReturnType<typeof createProjectExplorerOperations>;
  tree: ReturnType<typeof createProjectExplorerTreeController>;
  prepare: () => Promise<() => void>;
  closeMenu: () => void;
  report: (error: unknown, context: string) => void;
  setError: (message: string | null) => void;
  finish: (operation: ProjectOperation) => void;
}

export function parentDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

/** Connect the history state machine to tree refresh, reservations and diagnostics. */
export function createProjectExplorerFileActions(options: Options) {
  const { operations, tree } = options;
  const history = createProjectExplorerHistory({
    workspace: options.workspace,
    prepare: options.prepare,
    invoke: (command, args) => invoke<ProjectFileReceipt>(command, args),
    forget: (tokens) => {
      if (tokens.length) void invoke("forget_project_file_history", { tokens })
        .catch((error) => options.report(error, "project-explorer:release-history-failed"));
    },
    changed: async (receipt) => {
      const workspace = options.workspace();
      const generation = options.generation();
      const parents = new Set<string>();
      for (const { before, after } of receipt.changes) {
        if (before) {
          parents.add(parentDirectory(before));
          if (after) tree.remapPath(before, after);
          else tree.removePath(before);
        }
        if (after) {
          const parent = parentDirectory(after);
          parents.add(parent);
          tree.ensureDirectoryExpanded(parent);
        }
      }
      await Promise.all([...parents].map((parent) => tree.refreshDirectory(parent)));
      if (options.workspace() !== workspace || options.generation() !== generation) return;
      tree.state.selectedPaths = receipt.entries.map((entry) => entry.path);
      options.setError(null);
    },
    warning: (warning) => {
      options.report(warning, "project-explorer:file-operation-partial");
      options.setError(warning);
    },
  });

  function canReplay(direction: "undo" | "redo"): boolean {
    return (direction === "undo" ? history.canUndo : history.canRedo)
      && operations.canStart([{ path: "", kind: "tree" }]);
  }

  async function runClaimed(label: string, request?: ProjectFileRequest, direction?: "undo" | "redo"): Promise<ProjectFileReceipt | null> {
    options.closeMenu();
    const claims = request ? projectFileRequestClaims(request, options.workspace()) : [{ path: "", kind: "tree" as const }];
    const operation = operations.begin(label, claims);
    if (!operation) return null;
    try {
      return request ? await history.execute(request) : await history[direction!]();
    } catch (error) {
      options.report(error, "project-explorer:file-operation-failed");
      if (operations.isCurrent(operation)) options.setError(error instanceof Error ? error.message : String(error));
      return null;
    } finally { options.finish(operation); }
  }

  async function invokeName(command: string, args: Record<string, unknown>): Promise<ProjectTreeEntry> {
    const request: ProjectFileRequest = command === "rename_project_entry"
      ? { type: "rename", path: String(args.path), name: String(args.name) }
      : { type: "create", parent: String(args.parent ?? ""), name: String(args.name), kind: args.kind as "file" | "directory" };
    const receipt = await history.execute(request);
    if (!receipt?.entries[0]) throw new Error("File operation did not produce an entry.");
    return receipt.entries[0];
  }

  return {
    history,
    canReplay,
    invokeName,
    runMutation: (request: ProjectFileRequest, label: string) => runClaimed(label, request),
    replayHistory: async (direction: "undo" | "redo"): Promise<void> => {
      if (canReplay(direction)) await runClaimed(direction === "undo" ? "Undo" : "Redo", undefined, direction);
    },
  };
}
