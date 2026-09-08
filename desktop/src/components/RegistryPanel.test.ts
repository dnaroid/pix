import { describe, expect, it } from "vitest";
import source from "./RegistryPanel.svelte?raw";

describe("RegistryPanel refresh lifecycle", () => {
  it("refreshes only from an explicit user action", () => {
    expect(source).not.toContain("onMount");
    expect(source).toContain("onclick={onRefresh}");
  });
});
