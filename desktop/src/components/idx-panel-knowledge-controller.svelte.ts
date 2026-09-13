import { invoke } from "@tauri-apps/api/core";
import { idxCombinedOutput, type IdxCommandResult } from "../lib/idx";

export type IdxKnowledgeClassification = "spec" | "spec-like" | "meta-index" | "design-only" | "guide" | "other";
export type IdxKnowledgeBehaviorType = "as-is" | "change" | "mixed" | "unknown";
export type IdxKnowledgeLifecycle = "active" | "proposed" | "historical" | "superseded" | "unknown";
export type IdxKnowledgeConfidence = "high" | "medium" | "low" | "unknown";
export type IdxKnowledgeRelationKind = "implements" | "tests" | "related" | "supersedes" | "superseded-by";
export type IdxKnowledgeRelationAction = "add" | "remove";
export type IdxKnowledgeAction = "show" | "record" | "verify" | "relate" | "remove" | "impact";

interface IdxPanelKnowledgeControllerOptions {
  readonly workspace: () => string;
  readonly indexReady: () => boolean;
  readonly operationRunning: () => boolean;
  readonly refreshOverview: () => Promise<void>;
  readonly setError: (message: string | null) => void;
  readonly onOpenProjectFile: (path: string) => void | Promise<void>;
}

export function createIdxPanelKnowledgeController(options: IdxPanelKnowledgeControllerOptions) {
  const state = $state({
    path: "",
    classification: "spec" as IdxKnowledgeClassification,
    behaviorType: "as-is" as IdxKnowledgeBehaviorType,
    lifecycle: "active" as IdxKnowledgeLifecycle,
    confidence: "high" as IdxKnowledgeConfidence,
    summary: "",
    topics: "",
    sourceReviewed: false,
    evidenceReviewed: false,
    relationKind: "implements" as IdxKnowledgeRelationKind,
    relationAction: "add" as IdxKnowledgeRelationAction,
    relationTargets: "",
    action: null as IdxKnowledgeAction | null,
    result: undefined as IdxCommandResult | undefined,
  });

  function selectPath(path: string, open = false): void {
    state.path = path;
    state.sourceReviewed = false;
    state.evidenceReviewed = false;
    if (open) void options.onOpenProjectFile(path);
  }

  async function run(action: IdxKnowledgeAction): Promise<void> {
    const workspace = options.workspace();
    if (!workspace || !options.indexReady() || state.action || options.operationRunning()) return;
    const path = state.path.trim() || undefined;
    if (action !== "impact" && !path) {
      options.setError("Choose a knowledge document first.");
      return;
    }
    if (action === "remove" && !window.confirm(`Remove IDX knowledge metadata for ${path}?\n\nThe source file will not be deleted.`)) return;
    state.action = action;
    state.result = undefined;
    options.setError(null);
    const request = {
      workspace,
      action,
      path,
      classification: state.classification,
      behaviorType: state.behaviorType,
      lifecycle: state.lifecycle,
      confidence: state.confidence,
      summary: state.summary.trim() || undefined,
      topics: delimitedItems(state.topics),
      sourceReviewed: state.sourceReviewed,
      evidenceReviewed: state.evidenceReviewed,
      metadataOnlyConfirmed: action === "remove",
      relationKind: state.relationKind,
      relationAction: state.relationAction,
      targetPaths: delimitedItems(state.relationTargets),
      paths: [],
      semantic: true,
    };
    try {
      state.result = await invoke<IdxCommandResult>("idx_knowledge", { request });
      await options.refreshOverview();
    } catch (caught) {
      options.setError(errorMessage(caught));
    } finally {
      state.action = null;
    }
  }

  return {
    state,
    get output() { return idxCombinedOutput(state.result); },
    selectPath,
    run,
  };
}

export function delimitedItems(value: string): string[] {
  return value.split(/(?:\r?\n|,)/u).map((item) => item.trim()).filter(Boolean);
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}
