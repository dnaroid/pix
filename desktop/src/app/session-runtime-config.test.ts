import { describe, expect, it } from "vitest";
import { createSessionRuntimeConfigState } from "./session-runtime-config.svelte";

describe("session runtime config state", () => {
  it("does not let an old A completion clear a newer A change after an A→B→A switch", () => {
    const state = createSessionRuntimeConfigState();
    const firstA = state.beginConfigChange("a", "model");
    const onlyB = state.beginConfigChange("b", "thinking");
    const secondA = state.beginConfigChange("a", "thinking");

    state.endConfigChange("a", firstA);
    expect(state.configChangeInProgress("a")).toBe(true);
    expect(state.changingConfig.get("a")).toBe("thinking");

    state.endConfigChange("b", onlyB);
    expect(state.configChangeInProgress("b")).toBe(false);
    state.endConfigChange("a", secondA);
    expect(state.configChangeInProgress("a")).toBe(false);
  });
});
