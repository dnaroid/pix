import { describe, expect, it } from "vitest";
import workbenchBuilderSource from "../app/desktop-workbench-prop-builders.ts?raw";
import diffSource from "./GitDiffPane.svelte?raw";
import previewSource from "./PreviewPane.svelte?raw";
import previewEditorControllerSource from "./preview-editor-controller.svelte.ts?raw";
import previewFileSearchControllerSource from "./preview-file-search-controller.svelte.ts?raw";
import titlebarSource from "./DesktopTitlebar.svelte?raw";
import workbenchSurfaceSource from "./DesktopWorkbenchSurface.svelte?raw";

describe("desktop editor work surfaces", () => {
  it("renders Preview and Git Diff as top-level workbench tabs instead of modal or nested editor tabs", () => {
    expect(titlebarSource).toContain("<WorkbenchTabs {...workbench} />");
    expect(workbenchBuilderSource).toContain("preview: activePreview ?");
    expect(workbenchBuilderSource).toContain("gitDiff: gitDiffPreview ?");
    expect(workbenchSurfaceSource).not.toContain("<WorkspaceEditorTabs");
    expect(workbenchSurfaceSource).toContain("<PreviewPane");
    expect(workbenchSurfaceSource).toContain("<GitDiffPane");
    expect(previewSource).not.toContain("<dialog");
    expect(diffSource).not.toContain("<dialog");
  });

  it("exposes a copy action for the exact Git review resolution prompt", () => {
    expect(diffSource).toContain("Copy prompt");
    expect(diffSource).toContain('copyPromptConfirmed ? "Copied" : "Copy prompt"');
    expect(diffSource).toContain('aria-live="polite"');
    expect(diffSource).toContain("const copyPromptDisabled = $derived(!canResolve || reviewLoading || resolveLoading || reviewStale)");
    expect(diffSource).toContain("disabled={copyPromptDisabled}");
    expect(workbenchBuilderSource).toContain("gitAssist.copyReviewResolutionPrompt()");
  });

  it("keeps preview editing state close-aware while using the full editor region", () => {
    expect(previewSource).toContain("export function requestClose()");
    expect(previewSource).toContain("editorController.canClose()");
    expect(previewEditorControllerSource).toContain("options.onDirtyChange()?.(dirty())");
    expect(previewSource).not.toContain("Resize preview");
  });

  it("keeps any editable project text file in edit mode, including line-range previews", () => {
    expect(workbenchBuilderSource).toContain('editable: activePreview.kind === "file" && isWorkspaceProjectFilePath(activePreview.file.path)');
    expect(previewEditorControllerSource).not.toContain("markdown: () => boolean");
    expect(previewSource).toContain("{#if editing}");
    expect(previewSource).not.toContain("{#if renderAsMarkdown && editing}");
  });

  it("makes read-only Preview file surfaces selectable for copy", () => {
    expect(previewSource.match(/preview-text-surface/g)?.length).toBe(2);
  });

  it("keeps keyboard copy explicit inside the Preview textarea", () => {
    expect(previewSource).toContain("function handleEditorCopy(event: ClipboardEvent)");
    expect(previewSource).toContain('event.clipboardData.setData("text/plain"');
    expect(previewSource).toContain("oncopy={handleEditorCopy}");
  });

  it("gives the editor host an explicit full-height grid so the conversation composer stays bottom-anchored", () => {
    expect(workbenchSurfaceSource).toContain("relative grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-1 overflow-hidden bg-background");
    expect(workbenchSurfaceSource).toContain("col-start-1 row-start-1 min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]");
  });

  it("provides find-in-file in Preview with active-tab Ctrl/Cmd+F and match navigation", () => {
    expect(workbenchBuilderSource).toContain('active: options.activeWorkbenchTabId() === "preview"');
    expect(previewSource).toContain('aria-label="Find in file"');
    expect(previewSource).toContain("data-preview-file-search");
    expect(previewSource).toContain("searchController.handleWindowKeydown");
    expect(previewSource).toContain("searchController.previous");
    expect(previewSource).toContain("searchController.next");
    expect(previewFileSearchControllerSource).toContain('event.key.toLocaleLowerCase() === "f"');
    expect(previewFileSearchControllerSource).toContain("event.shiftKey ? -1 : 1");
    expect(previewFileSearchControllerSource).toContain("pix-preview-search-active");
    expect(previewFileSearchControllerSource).toContain("clearSearchDecorations()");
    expect(previewFileSearchControllerSource).toContain("selection.removeAllRanges()");
    expect(previewFileSearchControllerSource).toContain("element.setSelectionRange(end, end)");
    expect(previewFileSearchControllerSource).toContain("if (!query.trim()) {");
  });
});

