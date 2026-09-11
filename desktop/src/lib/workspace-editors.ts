export type WorkspaceEditorId = "conversation" | "preview" | "git-diff";

export type WorkspaceEditorKind = "conversation" | "file" | "diff";

export interface WorkspaceEditorTab {
  readonly id: WorkspaceEditorId;
  readonly label: string;
  readonly title?: string;
  readonly kind: WorkspaceEditorKind;
  readonly closable: boolean;
  readonly dirty?: boolean;
  readonly busy?: boolean;
}

/** Pick the editor that should receive focus after closing the current tab. */
export function workspaceEditorCloseFallback(
  tabs: readonly WorkspaceEditorTab[],
  closingId: WorkspaceEditorId,
): WorkspaceEditorId {
  const index = tabs.findIndex((tab) => tab.id === closingId);
  if (index < 0) return "conversation";
  return tabs[index + 1]?.id ?? tabs[index - 1]?.id ?? "conversation";
}

/** Never retain an active editor id after its backing surface has disappeared. */
export function normalizeWorkspaceEditor(
  activeId: WorkspaceEditorId,
  tabs: readonly WorkspaceEditorTab[],
): WorkspaceEditorId {
  return tabs.some((tab) => tab.id === activeId) ? activeId : "conversation";
}

