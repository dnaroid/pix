import { describe, expect, it, vi } from "vitest";
import { buildWorkbenchEditorProps, buildWorkbenchInspectorProps } from "./desktop-workbench-prop-builders";

function inspectorOptions(sessionId: string | null, open = true) {
  return {
    activeSessionId: () => sessionId,
    activeTitle: () => "Session",
    activeSessionActivity: () => undefined,
    activeTodoSnapshot: () => undefined,
    activeSubagentSnapshot: () => undefined,
    activeRuntimeStatus: () => undefined,
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
      isEditableProjectMarkdown: () => false,
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
});
