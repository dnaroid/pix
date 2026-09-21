import { describe, expect, it } from "vitest";
import panelSource from "./IdxPanel.svelte?raw";
import runtimeSource from "./idx-panel-runtime-controller.svelte.ts?raw";

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
});
