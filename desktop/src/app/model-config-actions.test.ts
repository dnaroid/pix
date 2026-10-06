import { describe, expect, it, vi } from "vitest";
import { createModelConfigActions } from "./model-config-actions";
import type { ModelConfigOptions } from "./model-config-options";
import type { ModelDraftConfig } from "./model-draft-config.svelte";
import type { ModelPickerState } from "./model-picker-state.svelte";

function setup(refresh = async () => {}) {
  let active = false;
  let workspace = "/project";
  const focusComposer = vi.fn();
  const options = {
    workspace: () => workspace,
    draftSessionTabActive: () => active,
    openDraftSessionTab: async () => { active = true; },
    focusComposer,
  } as unknown as ModelConfigOptions;
  const applySelection = vi.fn();
  const draft = {
    autoRoutingAvailable: true,
    configOptions: [],
    refresh,
    applySelection,
  } as unknown as ModelDraftConfig;
  const picker = { draft: false, open: true, close: () => { picker.open = false; } };
  const actions = createModelConfigActions(options, draft, picker as unknown as ModelPickerState);
  return {
    actions, focusComposer, applySelection, picker,
    leaveDraft: () => { active = false; },
    changeWorkspace: () => { workspace = "/other"; },
  };
}

describe("Auto model confirmation focus", () => {
  it("restores draft composer focus only after configuration is ready", async () => {
    let resolve!: () => void;
    const state = setup(() => new Promise<void>((done) => { resolve = done; }));
    const pending = state.actions.applySelection("pix:auto", "off");
    await Promise.resolve();
    expect(state.picker.open).toBe(false);
    expect(state.focusComposer).not.toHaveBeenCalled();
    resolve();
    await pending;
    expect(state.applySelection).toHaveBeenCalledWith("pix:auto", "off");
    expect(state.focusComposer).toHaveBeenCalledOnce();
    expect(state.applySelection.mock.invocationCallOrder[0]!).toBeLessThan(state.focusComposer.mock.invocationCallOrder[0]!);
  });

  it.each(["session", "workspace", "picker"])("ignores late completion after changing %s", async (destination) => {
    let resolve!: () => void;
    const state = setup(() => new Promise<void>((done) => { resolve = done; }));
    const pending = state.actions.applySelection("pix:auto", "off");
    await Promise.resolve();
    if (destination === "session") state.leaveDraft();
    if (destination === "workspace") state.changeWorkspace();
    if (destination === "picker") state.picker.open = true;
    resolve();
    await pending;
    expect(state.applySelection).not.toHaveBeenCalled();
    expect(state.focusComposer).not.toHaveBeenCalled();
  });

  it("does not focus on a failed configuration load", async () => {
    const state = setup(async () => { throw new Error("load failed"); });
    await expect(state.actions.applySelection("pix:auto", "off")).rejects.toThrow("load failed");
    expect(state.focusComposer).not.toHaveBeenCalled();
  });
});
