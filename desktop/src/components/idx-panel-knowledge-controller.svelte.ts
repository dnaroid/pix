import { invoke } from "@tauri-apps/api/core";
import type { IdxCommandResult } from "../lib/idx";
import { parseIdxKnowledgeReport, type IdxKnowledgeReport } from "../lib/idx-knowledge";

interface KnowledgeOptions {
  workspace: () => string;
  operationRunning: () => boolean;
}

/** Explicit disclosure requests only: no full-report work in the sparse health poll. */
export function createIdxPanelKnowledgeController(options: KnowledgeOptions) {
  const state = $state({ running: false, report: undefined as IdxKnowledgeReport | undefined, error: "" });
  let resultWorkspace = $state("");
  let generation = 0;
  let disposed = false;

  function invalidate(): void {
    generation++;
    resultWorkspace = "";
    state.running = false;
    state.report = undefined;
    state.error = "";
  }

  async function run(): Promise<void> {
    const workspace = options.workspace();
    if (disposed || !workspace || state.running || options.operationRunning()) return;
    const requestGeneration = ++generation;
    resultWorkspace = workspace;
    state.running = true;
    state.error = "";
    state.report = undefined;
    const current = () => !disposed && generation === requestGeneration && options.workspace() === workspace;
    try {
      const result = await invoke<IdxCommandResult>("idx_knowledge_status", { workspace });
      if (current()) state.report = parseIdxKnowledgeReport(result);
    } catch (error) {
      if (current()) state.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === requestGeneration) state.running = false;
    }
  }

  return {
    state,
    get report() { return resultWorkspace === options.workspace() ? state.report : undefined; },
    get error() { return resultWorkspace === options.workspace() ? state.error : ""; },
    invalidate,
    run,
    dispose() { disposed = true; invalidate(); },
  };
}
