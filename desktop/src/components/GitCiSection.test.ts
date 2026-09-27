import { describe, expect, it } from "vitest";
import projectServicesSource from "../app/desktop-project-services.ts?raw";
// @ts-expect-error Node fs import in Vitest runner
import { readFileSync } from "node:fs";
import sectionSource from "./GitCiSection.svelte?raw";
import panelSource from "./GitPanel.svelte?raw";
import toolsSource from "./GitRepositoryTools.svelte?raw";

describe("Git CI setup UI", () => {
  it("shows copyable install/auth guidance with provider documentation links", () => {
    expect(sectionSource).toContain("gitCiSetupGuide(ci.snapshot)");
    expect(sectionSource).toContain("writeText(command)");
    expect(sectionSource).toContain("Installation guide");
    expect(sectionSource).toContain("Authentication guide");
    expect(sectionSource).toContain("After setup completes, use Refresh to retry CI detection.");
  });

  it("refreshes Git state when the native CI target reports a changed HEAD", () => {
    expect(projectServicesSource).toContain("onTargetStale: () => void git.refresh()");
  });
  it("draws one rotating chevron per disclosure and hides WebKit's native summary marker", () => {
    const stylesSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(stylesSource).toMatch(/@layer base \{[\s\S]*summary::-webkit-details-marker \{ display: none; \}/);
    for (const source of [sectionSource, toolsSource]) {
      expect(source).not.toContain("ChevronDown class=\"h-3.5 w-3.5\" aria-hidden=\"true\" />");
      expect(source).toMatch(/group-open\/\w+:rotate-90/);
    }
  });

  it("keeps Update project, Push and Fetch in the Source Control toolbar", () => {
    expect(panelSource).toContain('role="toolbar" aria-label="Source Control actions"');
    expect(panelSource).toContain('aria-label="Update project"');
    expect(panelSource).toContain('workflow.onRepositoryAction("update")');
    expect(panelSource).toContain('workflow.onRepositoryAction("fetch")');
    expect(toolsSource).not.toContain("Pull (ff-only)");
    expect(toolsSource).toContain('aria-label="Recent commits"');
  });
});
