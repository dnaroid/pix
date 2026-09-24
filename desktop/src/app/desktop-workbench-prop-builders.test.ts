import { describe, expect, it, vi } from "vitest";
import { buildWorkbenchEditorProps, buildWorkbenchInspectorProps } from "./desktop-workbench-prop-builders";

function inspectorOptions(sessionId: string | null, open = true) {
  return {
    activeSessionId: () => sessionId,
    activeTitle: () => "Session",
    activeSessionActivity: () => undefined,
    activeTodoSnapshot: () => undefined,
    activeSubagentSnapshot: () => undefined,
    canClearTodos: () => false,
    clearSessionTodos: vi.fn(async () => true),
    inspectorPreference: {
      open,
      setOpen: vi.fn(),
    },
  } as any;
}

describe("workbench inspector props", () => {
  it("does not render the Session inspector for a UI-only draft", () => {
    expect(buildWorkbenchInspectorProps(inspectorOptions(null)).inspector).toBeNull();
  });

  it("renders the Session inspector for a real active session when preferred open", () => {
    const props = buildWorkbenchInspectorProps(inspectorOptions("session-1"));
    expect(props.inspector?.activeSessionId).toBe("session-1");
  });
});

describe("workbench Git diff props", () => {
  it("allows workspace review while a UI-only draft has no active session", () => {
    const props = buildWorkbenchEditorProps({
      workspace: () => "/workspace",
      statusReady: () => true,
      clientAvailable: () => true,
      operationRunning: () => false,
      activeWorkbenchTabId: () => "git-diff",
      externalEditorLabel: () => "Editor",
      preview: { active: null } as any,
      projectDocuments: {} as any,
      projectWorkspace: {} as any,
      git: {
        diffPreview: { scope: "all", content: "+change", truncated: false },
        diffReview: undefined,
        reviewResult: null,
        llmActionId: null,
        resolveRunning: false,
        actionId: null,
      } as any,
      gitAssist: {
        reviewDiff: vi.fn(),
        copyReviewResolutionPrompt: vi.fn(),
        resolveReviewInNewSession: vi.fn(),
      } as any,
    });

    expect(props.gitDiff?.canReview).toBe(true);
  });

  it("allows editing project text previews but keeps home and absolute local previews read-only", () => {
    const options = {
      workspace: () => "/workspace",
      statusReady: () => true,
      clientAvailable: () => true,
      operationRunning: () => false,
      activeWorkbenchTabId: () => "preview",
      externalEditorLabel: () => "Editor",
      preview: {
        active: { id: 1, kind: "file", file: { path: "src/main.ts", content: "x" }, scrollPosition: { left: 0, top: 0 } },
        canGoBack: false,
        canGoForward: false,
        move: vi.fn(),
        validateProjectFile: vi.fn(),
        validateLocalFile: vi.fn(),
        resolveProjectMedia: vi.fn(),
        openProjectFile: vi.fn(),
        openLocalFile: vi.fn(),
        resolveLocalMedia: vi.fn(),
        rememberScroll: vi.fn(),
        setDirty: vi.fn(),
        close: vi.fn(),
      },
      projectDocuments: { save: vi.fn() },
      projectWorkspace: { openInEditor: vi.fn() },
      git: { diffPreview: null },
      gitAssist: {},
    } as any;

    expect(buildWorkbenchEditorProps(options).preview?.editable).toBe(true);
    options.preview.active = { ...options.preview.active, file: { path: "~/.config/pi/pix.jsonc", content: "{}" } };
    expect(buildWorkbenchEditorProps(options).preview?.editable).toBe(false);
    options.preview.active = { ...options.preview.active, file: { path: "/private/tmp/stdout.txt", content: "output" } };
    const local = buildWorkbenchEditorProps(options).preview;
    expect(local?.editable).toBe(false);
    expect(local?.externalEditorLabel).toBeUndefined();
  });
});
