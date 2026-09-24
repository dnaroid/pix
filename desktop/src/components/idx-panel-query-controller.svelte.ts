import { invoke } from "@tauri-apps/api/core";
import {
  idxCombinedOutput,
  type IdxCommandResult,
  type IdxInspectCommand,
  type IdxQueryKind,
  type IdxSearchMode,
} from "../lib/idx";

interface IdxPanelQueryControllerOptions {
  readonly workspace: () => string;
  readonly indexReady: () => boolean;
  readonly operationRunning: () => boolean;
  readonly setError: (message: string | null) => void;
}

export function createIdxPanelQueryController(options: IdxPanelQueryControllerOptions) {
  const state = $state({
    queryKind: "code" as IdxQueryKind,
    queryText: "",
    queryPathPrefix: "",
    queryRunning: false,
    queryResult: undefined as IdxCommandResult | undefined,
    codeMode: "hybrid" as IdxSearchMode,
    codeMaxFiles: 5,
    codeIncludeContent: false,
    knowledgeLimit: 5,
    contextBudget: 1400,
    contextMaxSpecs: 4,
    contextMaxCode: 6,
    contextMaxTests: 4,
    askBudget: 2000,
    inspectCommand: "architecture" as IdxInspectCommand,
    inspectTarget: "",
    inspectDepth: 2,
    inspectMaxFiles: 40,
    inspectIncludeBody: false,
    inspectShowEdges: false,
    inspectTests: false,
    inspectRunning: false,
    inspectResult: undefined as IdxCommandResult | undefined,
  });
  let resultWorkspace = $state("");
  let generation = 0;
  $effect(() => {
    options.workspace();
    return () => {
      generation++;
      resultWorkspace = "";
      state.queryRunning = false;
      state.inspectRunning = false;
    };
  });

  async function runQuery(): Promise<void> {
    const text = state.queryText.trim();
    const workspace = options.workspace();
    if (!workspace || !options.indexReady() || !text || state.queryRunning || options.operationRunning()) return;
    const requestGeneration = ++generation;
    state.queryRunning = true;
    resultWorkspace = workspace;
    state.queryResult = undefined;
    state.inspectResult = undefined;
    options.setError(null);
    const pathPrefix = state.queryPathPrefix.trim() || undefined;
    const query = state.queryKind === "code"
      ? {
          kind: "code" as const,
          query: text,
          mode: state.codeMode,
          maxFiles: state.codeMaxFiles,
          pathPrefix,
          includeContent: state.codeIncludeContent,
        }
      : state.queryKind === "knowledge"
        ? {
            kind: "knowledge" as const,
            query: text,
            limit: state.knowledgeLimit,
            pathPrefix,
          }
        : state.queryKind === "context" ? {
            kind: "context" as const,
            query: text,
            budget: state.contextBudget,
            maxSpecs: state.contextMaxSpecs,
            maxCode: state.contextMaxCode,
            maxTests: state.contextMaxTests,
            pathPrefix,
          } : { kind: "ask" as const, question: text, budget: state.askBudget };
    try {
      const result = await invoke<IdxCommandResult>("idx_query", { request: { workspace, query } });
      if (generation === requestGeneration && options.workspace() === workspace) state.queryResult = result;
    } catch (caught) {
      if (generation === requestGeneration && options.workspace() === workspace) options.setError(errorMessage(caught));
    } finally {
      if (generation === requestGeneration) state.queryRunning = false;
    }
  }

  async function runInspect(): Promise<void> {
    const workspace = options.workspace();
    if (!workspace || !options.indexReady() || state.inspectRunning || state.queryRunning || options.operationRunning()) return;
    const targetRequired = state.inspectCommand === "ast" || state.inspectCommand === "explain" || state.inspectCommand === "deps";
    const target = state.inspectTarget.trim();
    if (targetRequired && !target) {
      options.setError(state.inspectCommand === "explain" ? "Enter a symbol to explain." : "Enter a file or module target.");
      return;
    }
    const requestGeneration = ++generation;
    state.inspectRunning = true;
    resultWorkspace = workspace;
    state.inspectResult = undefined;
    state.queryResult = undefined;
    options.setError(null);
    try {
      const result = await invoke<IdxCommandResult>("idx_inspect", {
        request: {
          workspace,
          command: state.inspectCommand,
          target: target || undefined,
          pathPrefix: state.queryPathPrefix.trim() || undefined,
          depth: state.inspectDepth,
          maxFiles: state.inspectMaxFiles,
          includeBody: state.inspectIncludeBody,
          showEdges: state.inspectShowEdges,
          tests: state.inspectTests,
        },
      });
      if (generation === requestGeneration && options.workspace() === workspace) state.inspectResult = result;
    } catch (caught) {
      if (generation === requestGeneration && options.workspace() === workspace) options.setError(errorMessage(caught));
    } finally {
      if (generation === requestGeneration) state.inspectRunning = false;
    }
  }

  return {
    state,
    get output() { return resultWorkspace === options.workspace() ? idxCombinedOutput(state.inspectResult) || idxCombinedOutput(state.queryResult) : ""; },
    get activeResult() { return resultWorkspace === options.workspace() ? state.inspectResult ?? state.queryResult : undefined; },
    runQuery,
    runInspect,
  };
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
