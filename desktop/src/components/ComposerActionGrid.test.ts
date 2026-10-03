import { describe, expect, it } from "vitest";
import activity from "./PromptComposerActivityRow.svelte?raw";
import queue from "./QueuedMessagesPanel.svelte?raw";
import composer from "./PromptComposer.svelte?raw";
import controls from "./PromptComposerControls.svelte?raw";

describe("composer action grid", () => {
  it("uses the same three 28px columns with 4px gaps in every row", () => {
    for (const source of [activity, queue, composer]) {
      expect(source).toContain("grid w-23 shrink-0 grid-cols-3 items-center gap-1");
    }
    for (const source of [activity, queue, controls]) {
      expect(source.match(/h-7 w-7/g)).toHaveLength(3);
      expect(source).not.toContain("h-6 w-6");
    }
  });

  it("insets unframed activity actions to match the framed rows", () => {
    // Queue and composer frames have an 8px inset plus their 1px border.
    expect(activity).toContain("pr-[9px]");
    expect(queue).toContain("border-input bg-panel-strong px-2");
    expect(composer).toContain('"px-2 py-1.5"');
    expect(activity.match(/col-start-2/g)).toHaveLength(1);
    expect(activity.match(/col-start-3/g)).toHaveLength(2);
  });
});
