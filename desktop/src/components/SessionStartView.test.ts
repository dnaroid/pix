import { describe, expect, it } from "vitest";
import appSource from "../App.svelte?raw";
import composerSource from "./PromptComposer.svelte?raw";
import source from "./SessionStartView.svelte?raw";

describe("SessionStartView", () => {
  it("lists saved conversations without a redundant New conversation action", () => {
    expect(source).toContain("Search saved conversations…");
    expect(source).toContain("onSelect(session.sessionId)");
    expect(source).not.toContain(">New conversation<");
  });

  it("fills the transcript height while keeping header/search fixed and session rows scrollable", () => {
    expect(source).toContain("mx-auto grid h-full min-h-0 w-full max-w-[620px]");
    expect(source).not.toContain("max-h-[300px]");
    expect(source).toContain("grid-rows-[auto_minmax(0,1fr)]");
    expect(source).toContain("min-h-0 overflow-y-auto");
    expect(source).toContain("grid h-7 w-full grid-cols-[minmax(0,1fr)_auto]");
    expect(source).toContain("shrink-0 font-mono text-[9px]");
  });

  it("is shown only for the UI-only draft tab and excludes sessions already represented by tabs", () => {
    expect(appSource).toContain("const sessionStartOpen = $derived(");
    expect(appSource).toContain('const DRAFT_SESSION_TAB_ID = "pix:desktop-draft-session"');
    expect(appSource).toContain("const titlebarSessions = $derived(");
    expect(appSource).toContain("const openIds = new Set(tabSessions.map((session) => session.sessionId))");
    expect(appSource).toContain("sessions.filter((session) => !openIds.has(session.sessionId))");
    expect(appSource).toContain("<SessionStartView");
  });

  it("disappears as soon as the composer draft is changed", () => {
    expect(appSource).toContain("onDraftChange={promoteSessionStart}");
    expect(composerSource).toContain("onDraftChange();");
  });

  it("does not create an ACP session until the draft is actually submitted", () => {
    const openStart = appSource.indexOf("async function openSessionStartTab");
    const materializeStart = appSource.indexOf("async function materializeDraftSession", openStart);
    const submitStart = appSource.indexOf("async function submitPrompt", materializeStart);
    expect(openStart).toBeGreaterThanOrEqual(0);
    expect(materializeStart).toBeGreaterThan(openStart);
    expect(appSource.slice(openStart, materializeStart)).not.toContain(".newSession(");
    expect(appSource.slice(materializeStart, submitStart)).toContain("requestClient.newSession(requestWorkspace)");
    expect(appSource).toContain("sessionId = await materializeDraftSession()");
    expect(appSource).toContain("draftSession={draftSessionTabActive}");
  });

  it("recovers old empty-session records without surfacing the unavailable-history error", () => {
    expect(appSource).toContain("session history ${sessionId} is unavailable");
    expect(appSource).toContain("activateDraftSessionTab({ resetComposer: true })");
    expect(appSource).toContain("requestClient.deleteSession(sessionId).catch(() => undefined)");
  });
});
