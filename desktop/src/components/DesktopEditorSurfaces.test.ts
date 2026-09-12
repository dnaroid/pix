import { describe, expect, it } from "vitest";
import workbenchViewModelSource from "../app/desktop-workbench-view-model.svelte.ts?raw";
import diffSource from "./GitDiffPane.svelte?raw";
import previewSource from "./PreviewPane.svelte?raw";
import titlebarSource from "./DesktopTitlebar.svelte?raw";
import workbenchSurfaceSource from "./DesktopWorkbenchSurface.svelte?raw";

describe("desktop editor work surfaces", () => {
  it("renders Preview and Git Diff as top-level workbench tabs instead of modal or nested editor tabs", () => {
    expect(titlebarSource).toContain("<WorkbenchTabs {...workbench} />");
    expect(workbenchViewModelSource).toContain("preview: activePreview ?");
    expect(workbenchViewModelSource).toContain("gitDiff: gitDiffPreview ?");
    expect(workbenchSurfaceSource).not.toContain("<WorkspaceEditorTabs");
    expect(workbenchSurfaceSource).toContain("<PreviewPane");
    expect(workbenchSurfaceSource).toContain("<GitDiffPane");
    expect(previewSource).not.toContain("<dialog");
    expect(diffSource).not.toContain("<dialog");
  });

  it("keeps preview editing state close-aware while using the full editor region", () => {
    expect(previewSource).toContain("export function requestClose()");
    expect(previewSource).toContain("onDirtyChange?.(dirty)");
    expect(previewSource).not.toContain("Resize preview");
  });

  it("gives the editor host an explicit full-height grid so the conversation composer stays bottom-anchored", () => {
    expect(workbenchSurfaceSource).toContain("relative grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-1 overflow-hidden bg-background");
    expect(workbenchSurfaceSource).toContain("col-start-1 row-start-1 min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]");
  });
});

