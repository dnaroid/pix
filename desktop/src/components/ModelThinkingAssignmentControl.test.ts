import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import ModelThinkingAssignmentControl from "./ModelThinkingAssignmentControl.svelte";
import modelSource from "./ModelThinkingAssignmentControl.svelte?raw";
import pickerSource from "./ModelThinkingPicker.svelte?raw";
import SupervisorMandateDialog from "./SupervisorMandateDialog.svelte";
import type { SupervisorMandateResponse } from "../../../acp/src/acp/supervisor-contract";
import { btwModelPickerConfig } from "../app/btw-model";
import { modelThinkingConfigState } from "../lib/model-thinking";

const models: SessionConfigOption[] = [
  {
    id: "model", name: "Model", type: "select", currentValue: "provider/fast",
    options: [
      { value: "provider/fast", name: "Fast", _meta: { "pix.thinkingLevels": ["off", "medium", "high"] } },
      { value: "provider/strong", name: "Strong", _meta: { "pix.thinkingLevels": ["off", "low", "high"] } },
    ],
  },
  {
    id: "thought_level", name: "Thinking", type: "select", currentValue: "medium",
    options: [{ value: "off", name: "Off" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }],
  },
];

function html(value: string) {
  return render(ModelThinkingAssignmentControl, { props: {
    label: "Assigned model", triggerLabel: "Assigned task model and effort", help: "", selectionDescription: "",
    value, configOptions: models, visibleModelRefs: ["provider/strong"],
    rememberedThinkingByModel: { "provider/strong": "high" },
    onVisibleModelsChange: () => {},
  } }).body;
}

describe("task model and effort selection", () => {
  it("defaults to the session model without assigning it to the task", () => {
    expect(html("")).toContain("Use session default");
    expect(html("")).not.toContain('aria-label="Use session default model"');
    expect(html("")).toContain('aria-label="Assigned task model and effort"');
    expect(html("")).toContain('aria-haspopup="dialog"');
    expect(html("")).not.toContain("<datalist");
  });

  it("displays an assigned model and selected effort and allows clearing it", () => {
    const rendered = html("provider/strong:high");
    expect(rendered).toContain("Strong");
    expect(rendered).toContain("high");
    expect(rendered).toContain('aria-label="Use session default model"');
    expect(rendered).toContain('title="provider/strong:high"');
  });

  it("reuses the actual model catalog picker, favourites and per-model supported effort", () => {
    const reselected = modelThinkingConfigState(btwModelPickerConfig(models, "provider/strong", "high"));
    expect(reselected.currentModel?.ref).toBe("provider/strong");
    expect(reselected.currentThinking).toBe("high");
    expect(reselected.currentModel?.thinkingLevels).toEqual(["off", "low", "high"]);
    for (const text of [
      "<ModelThinkingPicker", "btwModelPickerConfig(configOptions", "{visibleModelRefs}",
      "{rememberedThinkingByModel}", "{onVisibleModelsChange}", "applyUnchanged",
      'value = `${ref}:${effort}`',
    ]) expect(modelSource).toContain(text);
    expect(pickerSource).toContain('const pickerModels = $derived(visibilityMode');
    expect(pickerSource).toContain('modelIsVisible(model)');
    expect(pickerSource).toContain('role="radiogroup" aria-label="Thinking level"');
  });
});

describe("supervisor worker model and effort selection", () => {
  function mandateHtml(workerModelRef?: string, configOptions = models) {
    const mandate: SupervisorMandateResponse = {
      enabled: false, paused: false, maxConcurrent: 5, maxReworkRounds: 5,
      stalledAfterMinutes: 15, policy: "", workerModelRef,
      managed: 0, manual: 0, running: 0, reworkRounds: 0,
    };
    return render(SupervisorMandateDialog, { props: {
      mandate, configOptions, workspace: "/fixture", saving: false, rememberedThinkingByModel: {},
      onVisibleModelsChange: () => {}, onsave: () => {}, oncancel: () => {}, reportError: () => {},
    } }).body;
  }

  it("shows the shared picker trigger instead of a text field inside the mandate", () => {
    const rendered = mandateHtml();
    expect(rendered).toContain('aria-label="Default worker model and effort"');
    expect(rendered).toContain("Use session default");
    expect(rendered).not.toContain('type="text"');
  });

  it("shows the saved model and effort, even if it is no longer in the catalog", () => {
    expect(mandateHtml("provider/strong:high")).toContain("Strong");
    const unavailable = mandateHtml("provider/removed:high", []);
    expect(unavailable).toContain("provider/removed");
    expect(unavailable).toContain(">high</span>");
    expect(unavailable).toContain('aria-label="Use session default model"');
  });
});
