import { describe, expect, it } from "vitest";
import panelSource from "./IdxPanel.svelte?raw";
import runtimeSource from "./idx-panel-runtime-controller.svelte.ts?raw";
import querySource from "./idx-panel-query-controller.svelte.ts?raw";
import auditSource from "./idx-panel-audit-controller.svelte.ts?raw";

describe("IdxPanel managed installation", () => {
  it("offers managed IDX installation when IDX is unavailable", () => {
    expect(panelSource).toContain("overview && !overview.available");
    expect(panelSource).toContain("Install IDX");
    expect(panelSource).toContain("Installing IDX…");
    expect(panelSource).toContain("onclick={() => void installIdx()}");
    expect(panelSource).toContain("Nothing is installed globally.");
  });

  it("reuses the Desktop managed installer and refreshes the overview afterwards", () => {
    expect(runtimeSource).toContain('import { installManagedIdx } from "../lib/desktop-bootstrap"');
    expect(runtimeSource).toContain("await installManagedIdx()");
    expect(runtimeSource).toContain("await refreshOverview()");
    expect(runtimeSource).toContain("get installingIdx() { return installingIdx; }");
  });

  it("keeps periodic overview polling spaced after completion and visually quiet", () => {
    expect(runtimeSource).toContain('import { startCompletionSpacedPoll } from "../lib/completion-spaced-poll"');
    expect(runtimeSource).toContain("const stopOverviewPoll = startCompletionSpacedPoll({");
    expect(runtimeSource).toContain("task: refreshOverview");
    expect(runtimeSource).toContain("stopOverviewPoll();");
    expect(runtimeSource).not.toContain("window.setInterval(() => {");
    expect(panelSource).toContain('loading ? "animate-spin" : ""');
    expect(panelSource).not.toContain('loading || overviewRefreshRunning ? "animate-spin" : ""');
  });

  it("does not restart the full workspace load when the same workspace prop is invalidated again", () => {
    expect(runtimeSource).toContain("let observedWorkspace: string | undefined;");
    expect(runtimeSource).toContain("if (requestWorkspace === observedWorkspace) return;");
    expect(runtimeSource).toContain("observedWorkspace = requestWorkspace;");
  });
});

describe("IDX v2 panel contract", () => {
  it("offers document search, context and an explicit read-only task audit without removed ask/wiki controls", () => {
    expect(panelSource).toContain('["knowledge", "Documents"]');
    expect(panelSource).toContain('["context", "Context"]');
    expect(panelSource).not.toContain('["ask", "Ask"]');
    expect(panelSource).toContain("value={auditState.pathsInput}");
    expect(panelSource).toContain("auditController.setPathsInput(event.currentTarget.value)");
    expect(panelSource).toContain("<IdxOutput text={auditOutput}");
    expect(panelSource).not.toContain("wikiStatus");
    expect(panelSource).not.toContain("runKnowledgeAction");
    expect(querySource).not.toContain('kind: "ask"');
    expect(querySource).not.toContain("includeSecondary");
    expect(auditSource).toContain('invoke<IdxCommandResult>("idx_audit", { request: { workspace, paths } })');
  });

  it("offers an OpenRouter embedding flag for initialization and doctor reinitialization", () => {
    expect(panelSource).toContain("--embedding openrouter");
    expect(panelSource).toContain('startOperation("init", { openrouterEmbeddings })');
    expect(panelSource).toContain('startOperation("doctor", { openrouterEmbeddings })');
    expect(runtimeSource).toContain("openrouterEmbeddings: operationOptions.openrouterEmbeddings === true");
  });
});
