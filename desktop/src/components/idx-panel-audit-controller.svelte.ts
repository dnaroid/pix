import { invoke } from "@tauri-apps/api/core";
import { idxAuditPaths, idxCombinedOutput, idxValidAuditPaths, type IdxCommandResult } from "../lib/idx";

interface AuditOptions {
  workspace: () => string;
  indexReady: () => boolean;
  operationRunning: () => boolean;
  setError: (message: string | null) => void;
}

export function createIdxPanelAuditController(options: AuditOptions) {
  const state = $state({ pathsInput: "", running: false, result: undefined as IdxCommandResult | undefined });
  let resultWorkspace = $state("");
  let resultPaths = $state("");
  let generation = 0;

  $effect(() => {
    options.workspace();
    return () => {
      generation++;
      state.running = false;
      resultWorkspace = "";
      resultPaths = "";
      state.result = undefined;
    };
  });

  function setPathsInput(value: string): void {
    if (state.pathsInput === value) return;
    generation++;
    state.running = false;
    resultPaths = "";
    state.result = undefined;
    state.pathsInput = value;
  }

  async function run(): Promise<void> {
    const workspace = options.workspace();
    const paths = idxAuditPaths(state.pathsInput);
    if (!workspace || !options.indexReady() || state.running || options.operationRunning()) return;
    if (!idxValidAuditPaths(paths)) {
      options.setError("Enter project-relative changed paths (one per line or comma-separated).");
      return;
    }
    const requestGeneration = ++generation;
    const pathsKey = paths.join("\n");
    state.running = true;
    state.result = undefined;
    resultWorkspace = workspace;
    resultPaths = pathsKey;
    options.setError(null);
    try {
      const result = await invoke<IdxCommandResult>("idx_audit", { request: { workspace, paths } });
      if (generation === requestGeneration && options.workspace() === workspace && idxAuditPaths(state.pathsInput).join("\n") === pathsKey) state.result = result;
    } catch (caught) {
      if (generation === requestGeneration && options.workspace() === workspace && idxAuditPaths(state.pathsInput).join("\n") === pathsKey)
        options.setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (generation === requestGeneration) state.running = false;
    }
  }

  return {
    state,
    get pathsValid() { return idxValidAuditPaths(idxAuditPaths(state.pathsInput)); },
    get output() { return resultWorkspace === options.workspace() && resultPaths === idxAuditPaths(state.pathsInput).join("\n") ? idxCombinedOutput(state.result) : ""; },
    get activeResult() { return resultWorkspace === options.workspace() && resultPaths === idxAuditPaths(state.pathsInput).join("\n") ? state.result : undefined; },
    setPathsInput,
    run,
  };
}
