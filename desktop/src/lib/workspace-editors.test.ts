import { describe, expect, it } from "vitest";
import {
  normalizeWorkspaceEditor,
  workspaceEditorCloseFallback,
  type WorkspaceEditorTab,
} from "./workspace-editors";

const tabs: WorkspaceEditorTab[] = [
  { id: "conversation", label: "Conversation", kind: "conversation", closable: false },
  { id: "preview", label: "README.md", kind: "file", closable: true },
  { id: "git-diff", label: "Diff", kind: "diff", closable: true },
];

describe("workspace editor tabs", () => {
  it("moves focus to the next editor when possible after close", () => {
    expect(workspaceEditorCloseFallback(tabs, "preview")).toBe("git-diff");
    expect(workspaceEditorCloseFallback(tabs, "git-diff")).toBe("preview");
  });

  it("falls back to the conversation when the active editor disappears", () => {
    expect(normalizeWorkspaceEditor("preview", [tabs[0]!])).toBe("conversation");
    expect(normalizeWorkspaceEditor("git-diff", tabs)).toBe("git-diff");
  });
});

