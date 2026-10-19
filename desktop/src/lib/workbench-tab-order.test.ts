import { describe, expect, it } from "vitest";
import { moveWorkbenchTab, orderedWorkbenchTabs } from "./workbench-tab-order";
import type { WorkbenchTab, WorkbenchTabId } from "./workbench-tabs";

const tabs = (...ids: WorkbenchTabId[]) => ids.map((id) => ({ id })) as WorkbenchTab[];
const ids = (value: readonly WorkbenchTab[]) => value.map((tab) => tab.id);

describe("window-local workbench tab order", () => {
  it("moves mixed session and utility tabs without changing objects or membership", () => {
    const original = tabs("session:a", "preview", "session:b", "terminal");
    const order = moveWorkbenchTab(original, "session:a", "terminal");
    const result = orderedWorkbenchTabs(original, order);
    expect(ids(result)).toEqual(["preview", "session:b", "session:a", "terminal"]);
    expect(result[2]).toBe(original[0]);
    expect(ids(original)).toEqual(["session:a", "preview", "session:b", "terminal"]);
    expect(moveWorkbenchTab(result, "preview", null)).toEqual(["session:b", "session:a", "terminal", "preview"]);
  });

  it("keeps explicit order across metadata updates and inserts new tabs beside their opener", () => {
    const original = tabs("session:a", "session:b");
    const order = moveWorkbenchTab(original, "session:b", "session:a");
    const updated = tabs("session:a", "preview", "terminal", "session:b");
    expect(ids(orderedWorkbenchTabs(updated, order))).toEqual(["session:b", "session:a", "preview", "terminal"]);
    expect(ids(orderedWorkbenchTabs(original, order))).toEqual(["session:b", "session:a"]);
  });

  it("prunes closed/duplicate ids and leaves invalid or no-op moves alone", () => {
    const original = tabs("session:a", "preview", "session:b");
    expect(ids(orderedWorkbenchTabs(original, ["terminal", "session:b", "session:b", "session:a"])))
      .toEqual(["session:b", "session:a", "preview"]);
    for (const [source, before] of [["terminal", null], ["preview", "terminal"], ["preview", "preview"]] as const) {
      expect(moveWorkbenchTab(original, source, before)).toEqual(ids(original));
    }
    expect(ids(orderedWorkbenchTabs(original, []))).toEqual(ids(original));
  });
});
