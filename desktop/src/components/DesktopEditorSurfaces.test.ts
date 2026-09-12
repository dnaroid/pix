import { describe, expect, it } from "vitest";
import appSource from "../App.svelte?raw";
import diffSource from "./GitDiffPane.svelte?raw";
import previewSource from "./PreviewPane.svelte?raw";

describe("desktop editor work surfaces", () => {
  it("renders Preview and Git Diff as top-level workbench tabs instead of modal or nested editor tabs", () => {
    expect(appSource).toContain("<WorkbenchTabs");
    expect(appSource).toContain("tabs={workbenchTabs}");
    expect(appSource).not.toContain("<WorkspaceEditorTabs");
    expect(appSource).toContain("<PreviewPane");
    expect(appSource).toContain("<GitDiffPane");
    expect(previewSource).not.toContain("<dialog");
    expect(diffSource).not.toContain("<dialog");
  });

  it("keeps preview editing state close-aware while using the full editor region", () => {
    expect(previewSource).toContain("export function requestClose()");
    expect(previewSource).toContain("onDirtyChange?.(dirty)");
    expect(previewSource).not.toContain("Resize preview");
  });

  it("gives the editor host an explicit full-height grid so the conversation composer stays bottom-anchored", () => {
    expect(appSource).toContain("relative grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-1 overflow-hidden bg-background");
    expect(appSource).toContain("col-start-1 row-start-1 min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]");
  });
});

