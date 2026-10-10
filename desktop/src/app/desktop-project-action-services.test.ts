import { describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import type { AcpClient } from "../lib/acp-client";
import { emptyTranscript } from "../lib/transcript";
import { createDesktopProjectActionServices } from "./desktop-project-action-services";
import { DRAFT_SESSION_TAB_ID } from "./draft-session.svelte";

describe("desktop project task session activation", () => {
  it("foregrounds a new task session instead of leaving the draft active", async () => {
    const task = {
      id: "task-1",
      title: "Fix the task session transition",
      type: "bug" as const,
      status: "todo" as const,
      priority: "medium" as const,
      createdAt: "2026-09-27T18:00:00.000Z",
      updatedAt: "2026-09-27T18:00:00.000Z",
    };
    const client = {
      newSession: vi.fn().mockResolvedValue({ sessionId: "task-session" }),
    } as unknown as AcpClient;
    const draft = {
      open: true,
      active: true,
      deactivate: vi.fn(() => { draft.active = false; }),
    };
    const switchComposerDraft = vi.fn();
    const showSession = vi.fn();
    const rememberActive = vi.fn();
    const ensureProvisional = vi.fn();
    const saveTasks = vi.fn().mockResolvedValue(true);
    const runPromptRequest = vi.fn().mockResolvedValue(undefined);
    const state = {
      sessionId: null as string | null,
      transcript: emptyTranscript,
      saveActiveTranscript: vi.fn(),
      setSessionId: vi.fn((sessionId: string | null) => { state.sessionId = sessionId; }),
      initializeActiveConversation: vi.fn(),
      setActiveTranscriptForSession: vi.fn(),
    };

    const services = createDesktopProjectActionServices({
      client: () => client,
      workspace: () => "/project",
      canUseSession: () => true,
      sessionMutationRunning: () => false,
      state: state as any,
      sessions: {
        runtime: {
          ensure: vi.fn().mockResolvedValue(undefined),
          isReady: () => true,
          getConfigOptions: () => [],
        },
        catalog: { ensureProvisional, refresh: vi.fn() },
        tabs: { show: showSession, rememberActive },
      } as any,
      transitions: {
        draft,
        composerDrafts: { switchTo: switchComposerDraft },
        sessionTabs: { closeSessionSelector: vi.fn(), loadSession: vi.fn() },
      } as any,
      project: {
        tasks: {
          saving: false,
          loadFailed: false,
          document: { version: 1, tasks: [task] },
          save: saveTasks,
          newId: () => "task-2",
        },
      } as any,
      prompt: { runtime: { runPromptRequest } } as any,
      attachmentDraftKey: () => "draft-key",
      attachmentGeneration: () => 0,
      waitForAttachmentDraftSettled: async () => {},
      promptText: () => "",
      promptAttachments: () => [],
      setPromptText: () => {},
      invalidateAttachmentDraft: () => {},
      openTasksPanel: () => {},
      closeProjectSelector: () => {},
      setOperationRunning: () => {},
      setErrorMessage: () => {},
      forgetRuntime: () => {},
      prepareTranscriptAttachment: async () => {},
      imagePromptSupported: () => true,
      nextLocalMessageId: () => "message-1",
      scrollToLatest: async () => {},
      reportError: (error: unknown) => { throw error; },
    });

    await services.actions.runTask(task);
    expect(native.invoke).toHaveBeenCalledWith("read_project_task_attachments", {
      workspace: "/project", id: "task-1",
    });

    expect(draft.deactivate).toHaveBeenCalledOnce();
    expect(draft.open).toBe(true);
    expect(draft.active).toBe(false);
    expect(switchComposerDraft).toHaveBeenCalledWith(DRAFT_SESSION_TAB_ID, "task-session");
    expect(showSession).toHaveBeenCalledWith("task-session");
    expect(rememberActive).toHaveBeenCalledWith("/project", "task-session");
    expect(ensureProvisional).toHaveBeenCalledWith("task-session", "/project");
    expect(state.sessionId).toBe("task-session");
    expect(saveTasks).toHaveBeenCalledWith(expect.objectContaining({
      tasks: [expect.objectContaining({
        id: "task-1",
        status: "in-progress",
        sessionId: "task-session",
      })],
    }));
    expect(runPromptRequest).toHaveBeenCalledWith(
      client,
      "task-session",
      expect.any(Array),
      [],
      "message-1",
    );
  });

});
