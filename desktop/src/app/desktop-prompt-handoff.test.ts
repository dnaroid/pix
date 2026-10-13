import { describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
import type { AcpClient } from "../lib/acp-client";
import { composerActivity } from "../lib/composer-activity";
import { appendLocalUserMessage, emptyTranscript } from "../lib/transcript";
import { createActiveSessionState } from "./active-session-state.svelte";
import { createComposerDraftStore } from "./composer-drafts";
import { createDesktopPromptActionServices } from "./desktop-prompt-action-services";
import { createPromptRunLifecycle } from "./prompt-run-lifecycle.svelte";
import { createSessionHistory } from "./session-history.svelte";
import { SESSION_HANDOFF_COMPLETE } from "./session-handoff-prompts";

describe("desktop prompt handoff integration", () => {
  it("preserves the source transcript and draft, replaces its tab, and submits continuation in the fresh session", async () => {
    const state = createActiveSessionState();
    state.setSessionId("source");
    state.setActiveTranscriptForSession("source", appendLocalUserMessage(emptyTranscript, "Original objective", "original"));
    let draftText = "Independent unfinished draft";
    const drafts = createComposerDraftStore({
      workspace: () => "/project", promptText: () => draftText, promptAttachments: () => [],
      setPromptText: (text) => { draftText = text; }, replacePromptAttachments: vi.fn(),
    });
    const client = {
      newSession: vi.fn().mockResolvedValue({ sessionId: "fresh" }),
      loadSession: vi.fn().mockResolvedValue({ configOptions: [] }),
      branchUserMessages: vi.fn().mockResolvedValue([]),
      prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    } as unknown as AcpClient;
    const replaceTab = vi.fn();
    const markReady = vi.fn();
    const retarget = vi.fn();
    const history = createSessionHistory({
      client: () => client, state, workspace: () => "/project",
      ensureRuntime: vi.fn(), runtimeReady: () => true,
      scheduleScrollToLatest: vi.fn(), recoverUnavailableSession: vi.fn(),
      reportError: (error) => { throw error; },
    });
    const sourceHistoryGeneration = history.generation;
    const runs = createPromptRunLifecycle({
      client: () => client, activeSessionId: () => state.sessionId,
      reportError: (error) => { throw error; }, bindPromptSessionEntry: vi.fn(),
      finalizeTranscriptActivity: vi.fn(), flushAutoQueue: vi.fn(),
    });
    let finishContinuation!: (response: { stopReason: "end_turn" }) => void;
    vi.mocked(client.prompt).mockImplementation((sessionId) => sessionId === "source"
      ? Promise.resolve({ stopReason: "end_turn" })
      : new Promise((resolve) => { finishContinuation = resolve; }));
    const runPromptRequestWithResult = vi.fn(runs.runPromptRequestWithResult);
    const release = vi.fn();
    native.invoke.mockResolvedValue({ kind: "text", file: { path: "handoff.md", content: `Objective\n${SESSION_HANDOFF_COMPLETE}` } });
    let message = 0;
    const services = createDesktopPromptActionServices({
      client: () => client, workspace: () => "/project", state,
      sessionMutationRunning: () => false, handoffAllowed: () => true,
      retargetSessionAnchors: retarget, messageEditActive: () => false,
      attachments: { generation: 0 },
      sessions: {
        autocomplete: {},
        history, runtime: { isReady: () => true, captureOwnership: () => () => true, markReady },
        catalog: { ensureProvisional: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined) },
        tabs: { replace: replaceTab, rememberActive: vi.fn() },
      },
      transitions: { composerDrafts: drafts, draft: {}, sessionTabs: {} },
      prompt: {
        runtime: { isRunning: runs.isRunning, agentState: () => "idle", queueItemsBySession: new Map(),
          holdAutoQueue: () => release, runPromptRequestWithResult },
        queue: {},
      },
      conversation: {}, navigation: {},
      nextLocalMessageId: () => `handoff-${++message}`, scrollToLatest: vi.fn().mockResolvedValue(undefined),
      reportError: (error: unknown) => { throw error; },
    } as any);

    const handoff = services.handoff.start();
    await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledWith("fresh", expect.any(Array), []));
    // Exercise the actual history and prompt lifecycle while continuation is
    // pending: a mocked history store would miss the stuck loading flag.
    expect(history.generation).toBeGreaterThan(sourceHistoryGeneration);
    expect(history.loading).toBe(false);
    expect(history.needsHydration("fresh")).toBe(false);
    expect(runs.isRunning("source")).toBe(false);
    expect(runs.isRunning("fresh")).toBe(true);
    const activity = () => composerActivity(state.transcript, {
      sessionId: state.sessionId, running: runs.isRunning(state.sessionId!),
      ready: state.runtimeReady, historyLoading: history.loading, draft: false,
      controlState: "idle", waitingForInput: false,
    });
    expect(activity()?.action).toBe("Working");
    finishContinuation({ stopReason: "end_turn" });
    await handoff;
    expect(runs.isRunning("fresh")).toBe(false);
    expect(activity()).toBeUndefined();
    const path = native.invoke.mock.calls[0]![1].path;
    expect(native.invoke).toHaveBeenCalledWith("read_preview_file", { workspace: "/project", path });
    expect(replaceTab).toHaveBeenCalledWith("source", "fresh");
    expect(retarget).toHaveBeenCalledWith("source", "fresh");
    expect(markReady).toHaveBeenCalledWith("fresh", []);
    expect(state.sessionId).toBe("fresh");
    expect(state.sessionTranscript("source")?.items).toEqual([
      expect.objectContaining({ text: "Original objective" }),
      expect.objectContaining({ text: expect.stringContaining(path) }),
    ]);
    expect(state.transcript.items).toEqual([expect.objectContaining({ text: expect.stringContaining(path) })]);
    expect(runPromptRequestWithResult.mock.calls.map((call) => call[1])).toEqual(["source", "fresh"]);
    expect(draftText).toBe("");
    drafts.restore("source");
    expect(draftText).toBe("Independent unfinished draft");
    expect(release).toHaveBeenCalledOnce();
  });
});
