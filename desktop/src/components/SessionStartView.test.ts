import { describe, expect, it } from "vitest";
import appSource from "../App.svelte?raw";
import presentationStateSource from "../app/desktop-presentation-state.svelte.ts?raw";
import draftSource from "../app/draft-session.svelte.ts?raw";
import historySource from "../app/session-history.svelte.ts?raw";
import promptSubmitSource from "../app/prompt-submit.ts?raw";
import workbenchBuilderSource from "../app/desktop-workbench-prop-builders.ts?raw";
import workbenchSurfaceSource from "./DesktopWorkbenchSurface.svelte?raw";
import composerSource from "./PromptComposer.svelte?raw";
import source from "./SessionStartView.svelte?raw";
import transcriptPaneSource from "./TranscriptPane.svelte?raw";

describe("SessionStartView", () => {
  it("lists saved conversations without a redundant New conversation action", () => {
    expect(source).toContain("Search saved conversations…");
    expect(source).toContain("onSelect(row.session.sessionId)");
    expect(source).not.toContain(">New conversation<");
    expect(source).toContain("!row.treePrefix && sessionIsFork(row.session)");
    expect(source).toContain("GitFork");
    expect(source).toContain("buildSessionTree(sessions)");
    expect(source).toContain('treePrefix: ""');
  });

  it("fills the transcript height while keeping header/search fixed and session rows scrollable", () => {
    expect(source).toContain("mx-auto grid h-full min-h-0 w-full max-w-[620px]");
    expect(source).not.toContain("max-h-[300px]");
    expect(source).toContain("grid-rows-[auto_minmax(0,1fr)]");
    expect(source).toContain("min-h-0 overflow-y-auto");
    expect(source).toContain("grid h-7 w-full grid-cols-[minmax(0,1fr)_auto]");
    expect(source).toContain("shrink-0 font-mono text-xs");
  });

  it("is shown only for the UI-only draft tab and excludes sessions already represented by tabs", () => {
    expect(presentationStateSource).toContain("const sessionStartOpen = $derived(");
    expect(draftSource).toContain('export const DRAFT_SESSION_TAB_ID = "pix:desktop-draft-session"');
    expect(presentationStateSource).toContain("const titlebarSessions = $derived(");
    expect(presentationStateSource).toContain("const openIds = new Set(tabSessions.map((session) => session.sessionId))");
    expect(presentationStateSource).toContain(
      "options.sessions.catalog.sessions.filter((session) => !openIds.has(session.sessionId))",
    );
    expect(workbenchSurfaceSource).toContain("<SessionStartView {...sessionStart} />");
  });

  it("disappears as soon as the composer draft is changed", () => {
    expect(workbenchBuilderSource).toContain("onDraftChange: options.draft.promote");
    expect(composerSource).toContain("onDraftChange();");
  });

  it("shows the empty conversation prompt instead of a loading status after editing a draft", () => {
    expect(transcriptPaneSource).toContain("{#if !activeSessionId && !workspace}");
    expect(transcriptPaneSource).toContain("{:else if activeSessionId && transcript.items.length === 0 && historyLoading}");
    expect(transcriptPaneSource).toContain("What should we work on?");
    expect(transcriptPaneSource).not.toContain("Opening conversation…");
  });

  it("does not create an ACP session until the draft is actually submitted", () => {
    const openStart = draftSource.indexOf("async function openStartTab");
    const materializeStart = draftSource.indexOf("async function materialize", openStart);
    expect(openStart).toBeGreaterThanOrEqual(0);
    expect(materializeStart).toBeGreaterThan(openStart);
    expect(draftSource.slice(openStart, materializeStart)).not.toContain(".newSession(");
    const materialize = draftSource.slice(materializeStart);
    expect(materialize).toContain("await options.routeDraftModel(prompt, attachmentCount, controller.signal)");
    expect(materialize).toContain("requestClient.newSession(");
    expect(materialize.indexOf("requestClient.newSession(")).toBeGreaterThan(materialize.indexOf("await options.routeDraftModel("));
    expect(promptSubmitSource).toContain("sessionId = await options.materializeDraftSession(");
    expect(workbenchBuilderSource).toContain("draftSession: options.draft.active");
  });

  it("recovers old empty-session records without surfacing the unavailable-history error", () => {
    expect(historySource).toContain("session history ${sessionId} is unavailable");
    expect(appSource).toContain("activateDraftSessionTab({ resetComposer: true })");
    expect(appSource).toContain("requestClient.deleteSession(sessionId).catch(() => undefined)");
  });
});
