import { describe, expect, it } from "vitest";
import panelSource from "./RegistryPanel.svelte?raw";
import sidebarSource from "./WorkspaceSidebar.svelte?raw";

describe("RegistryPanel refresh lifecycle", () => {
  it("refreshes only from an explicit user action", () => {
    expect(panelSource).not.toContain("onMount");
    expect(sidebarSource).toContain('title="Refresh registry"');
    expect(sidebarSource).toContain("onclick={onRegistryRefresh}");
  });
});
