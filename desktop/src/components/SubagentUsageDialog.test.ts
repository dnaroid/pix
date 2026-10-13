import { describe, expect, it } from "vitest";
import source from "./SubagentUsageDialog.svelte?raw";
import statusBar from "./RuntimeStatusBarItems.svelte?raw";

describe("subagent statistics dialog contract", () => {
  it("only shows the header button for a loaded snapshot with recorded subagent calls", () => {
    expect(statusBar).toMatch(/\{#if sessionUsage\?\.subagents\?\.agents\.length\}\s*<button[^>]*aria-label="Show subagent statistics"[^>]*>[\s\S]*?<\/button>\s*\{\/if\}/);
    expect(statusBar).not.toContain('disabled={!sessionUsage}');
  });
  it("places a fixed blue role icon beside the role and shared provider logos before models", () => {
    expect(source).toContain('<Icon class="h-4 w-4 shrink-0 text-tool-search" aria-hidden="true" />{agent.subagentType');
    expect(source).not.toContain('<Icon class="mt-0.5');
    expect(source).toContain('modelProviderBrand(item.provider)');
    expect(source).toContain('<ModelProviderIcon provider={item.provider} />');
    expect(source).toContain('<ModelProviderIcon provider={agent.configuredModel} />');
    expect(source).not.toContain('<ModelProviderIcon provider={model.provider} />');
    expect(source).not.toContain('subagentStatusTone');
  });
  it("opens from the session-usage header and uses native modal focus/escape/backdrop lifecycle", () => {
    expect(statusBar).toContain('aria-label="Show subagent statistics"');
    expect(statusBar).toContain("<SubagentUsageDialog");
    expect(statusBar).toContain("if (subagentUsageOpen) return;");
    expect(source).toContain("<dialog");
    expect(source).toContain("activateModalDialog(dialog, () => closeButton)");
    expect(source).toContain("oncancel=");
    expect(source).toContain("event.target === event.currentTarget");
  });
  it("offers task disclosures, tool-start counts, served models and per-run billing", () => {
    expect(source).toContain("<summary");
    expect(source).toContain("<ChevronRight");
    expect(source).toContain("group-open/agent:rotate-90");
    expect(source).toContain('aria-label="Tool calls"');
    expect(source).toContain("{#if agent.tools?.length}");
    expect(source).not.toContain("Tool calls started");
    expect(source).not.toContain("Recorded models");
    expect(source).not.toContain("Configured model:");
    expect(source).toContain("Usage not recorded");
    expect(source).not.toContain("Tool calls not recorded for this run.");
    expect(source).not.toContain("No recorded tool calls.");
    expect(source).toContain("agent.totals.totalTokens");
    expect(source).toContain("subagentUsageCost(agent.totals)");
  });
  it("keeps run links without displaying changed files or coverage gaps", () => {
    expect(source).not.toContain("Changed files");
    expect(source).not.toContain("stats.changes");
    expect(source).toContain('path={agent.runDir} kind="directory"');
    expect(source).toContain("onNavigate={onClose}");
  });
  it("shows only the run list, without statuses, session summaries or explanatory banners", () => {
    expect(source).toContain("{#each stats.agents as agent (agent.key)}");
    for (const removed of [
      "agent.status", "totalRow", "stats.main", "stats.other", "stats.unattributed",
      "usage.totals", "Subagents / main agent", "subagentUsageRatio",
      "Whole-session snapshot", "Ratios can exceed", "~ marks estimated",
    ]) expect(source).not.toContain(removed);
  });
});
