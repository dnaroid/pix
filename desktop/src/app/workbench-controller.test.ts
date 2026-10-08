import { describe, expect, it, vi } from "vitest";
import { workbenchSessionTabId, type WorkbenchTabId } from "../lib/workbench-tabs";
import { createWorkbenchController } from "./workbench-controller";
import { shouldActivateConversationTab } from "./desktop-root-effects.svelte";

describe("workbench close navigation", () => {
  it.each([false, true])("does not overwrite navigation during pending consent (navigated=%s)", async (navigated) => {
    const closingId = workbenchSessionTabId("closing");
    const nextId = workbenchSessionTabId("next");
    const otherId = workbenchSessionTabId("other");
    let activeId: WorkbenchTabId | null = closingId;
    let resolve!: (closed: boolean) => void;
    const consent = new Promise<boolean>((done) => { resolve = done; });
    const setActiveTabId = vi.fn((id: WorkbenchTabId | null) => { activeId = id; });
    const controller = createWorkbenchController({
      tabs: () => ["closing", "next", "other"].map((sessionId) => ({ id: workbenchSessionTabId(sessionId), kind: "session", sessionId, label: sessionId,
        title: "Closing", panelId: "conversation", closable: true, disabled: false,
        running: false, draft: false, fork: false, statusKind: "idle" })),
      activeTabId: () => activeId, activeConversationTabId: () => nextId,
      setActiveTabId, handleSessionTabClick: vi.fn(), closeSessionTab: async (_id, _fallback, onClosing) => {
        const accepted = await consent;
        if (accepted) onClosing?.();
        return accepted;
      },
      previewPane: () => null, closePreview: vi.fn(), closeGitDiff: vi.fn(),
      closeLspInstall: vi.fn(), closeTerminal: vi.fn(),
      retargetPreviewAnchor: vi.fn(), retargetGitAnchor: vi.fn(),
    });
    const pending = controller.close(closingId, nextId);
    if (navigated) activeId = otherId;
    resolve(true);
    await expect(pending).resolves.toBe(true);
    expect(activeId).toBe(navigated ? otherId : nextId);
    if (navigated) expect(setActiveTabId).not.toHaveBeenCalled();
  });
  it("commits an auxiliary fallback before reactive normalization of a removed session", async () => {
    const closingId = workbenchSessionTabId("closing");
    const nextId = workbenchSessionTabId("next");
    const previewId = "preview:file" as WorkbenchTabId;
    let activeId: WorkbenchTabId | null = closingId;
    let removed = false;
    const session = { id: closingId, kind: "session", sessionId: "closing", label: "Closing",
      title: "Closing", panelId: "conversation", closable: true, disabled: false,
      running: false, draft: false, fork: false, statusKind: "idle" } as const;
    const preview = { ...session, id: previewId, kind: "preview", dirty: false } as const;
    const controller = createWorkbenchController({
      tabs: () => removed ? [preview] : [session, preview],
      activeTabId: () => activeId, activeConversationTabId: () => nextId,
      setActiveTabId: (id) => { activeId = id; }, handleSessionTabClick: vi.fn(),
      closeSessionTab: async (_id, _fallback, onClosing) => {
        onClosing?.();
        removed = true;
        // Model root-effects normalization of the removed conversation tab.
        const activeTab = [preview].find((tab) => tab.id === activeId);
        if (shouldActivateConversationTab(activeTab)) activeId = nextId;
        await Promise.resolve();
        return true;
      },
      previewPane: () => null, closePreview: vi.fn(), closeGitDiff: vi.fn(),
      closeLspInstall: vi.fn(), closeTerminal: vi.fn(),
      retargetPreviewAnchor: vi.fn(), retargetGitAnchor: vi.fn(),
    });
    await expect(controller.close(closingId, previewId)).resolves.toBe(true);
    expect(activeId).toBe(previewId);
  });

  it.each(["preview", "git-diff", "terminal"] as const)("preserves a visible %s surface when the underlying conversation changes", (kind) => {
    expect(shouldActivateConversationTab({ kind } as never)).toBe(false);
    expect(shouldActivateConversationTab({ kind: "session" } as never)).toBe(true);
    expect(shouldActivateConversationTab(undefined)).toBe(true);
  });
});
