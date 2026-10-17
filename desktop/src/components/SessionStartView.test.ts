import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import type { SessionInfo } from "@agentclientprotocol/sdk";
import SessionStartView from "./SessionStartView.svelte";
import appSource from "../App.svelte?raw";
import presentationStateSource from "../app/desktop-presentation-state.svelte.ts?raw";
import draftSource from "../app/draft-session.svelte.ts?raw";
import historySource from "../app/session-history.svelte.ts?raw";
import promptSubmitSource from "../app/prompt-submit.ts?raw";
import workbenchBuilderSource from "../app/desktop-workbench-prop-builders.ts?raw";
import workbenchSurfaceSource from "./DesktopWorkbenchSurface.svelte?raw";
import composerSource from "./PromptComposer.svelte?raw";
import source from "./SessionStartView.svelte?raw";
import rowSource from "./SavedSessionRow.svelte?raw";
import transcriptPaneSource from "./TranscriptPane.svelte?raw";

describe("SessionStartView", () => {
  it("resolves highlighted ancestry from current rows and keeps pointer/focus separate", () => {
    expect(source).toContain("displayedSessions.find((row) => row.session.sessionId === (hoveredId ?? focusedId))");
    expect(source).toContain('if (source === "pointer")');
    expect(source).toContain("if (active || hoveredId === id)");
    expect(source).toContain("else if (active || focusedId === id)");
  });
  it("lists saved conversations without a redundant New conversation action", () => {
    expect(source).toContain("Search saved conversations…");
    expect(source).toContain("onSelect(row.session.sessionId)");
    expect(source).not.toContain(">New conversation<");
    expect(rowSource).toContain("row.depth === 0 && sessionIsFork(row.session)");
    expect(rowSource).toContain("GitFork");
    expect(rowSource).not.toContain("Sub-agent ·");
    expect(source).toContain("flatSessionRow(session)");
    expect(source).toContain('previewInlineSearch("sessions", query, candidateSessions)');
    expect(source).toContain('queryInlineSearch("sessions", searchClient, workspace, submitted, request.signal, publish)');
    expect(source).toContain("expandedSessionRows(buildSessionTree(candidateSessions), collapsed)");
  });

  it("hides sub-agent viewer sessions unless the toggle is enabled", () => {
    expect(source).toContain("let showSubagents = $state(false)");
    expect(source).toContain("showSubagents ? sessions : sessions.filter((session) => !isSubagentSession(session))");
    expect(source).toContain("{#if hasSubagentSessions}");
    expect(source).toContain("bind:checked={showSubagents}");
  });

  it("renders search and sub-agent toggle in one compact toolbar without headings or a search button", () => {
    const html = render(SessionStartView, { props: {
      sessions: [{ sessionId: "viewer", cwd: "/project", title: "Review", _meta: {
        "pix.subagent": { runDir: "/project/.pi/subagents/run", agentId: "reviewer", parentSessionId: "parent" },
      } }], workspace: "/project", onSelect: () => {},
    } }).body;
    const search = html.indexOf('id="saved-session-search"');
    const toggle = html.indexOf("data-show-subagent-sessions");
    expect(search).toBeGreaterThanOrEqual(0);
    expect(toggle).toBeGreaterThan(search);
    expect(html).not.toContain('<button');
    expect(source).toContain("resetPages(); cancelSearch();");
    expect(html).not.toContain("Open a conversation");
    expect(html).not.toContain("or start typing below");
    expect(html).toContain('aria-label="Open saved conversation"');
    expect(source).toContain("flex flex-wrap items-center gap-2");
  });

  it("fills the transcript height while keeping header/search fixed and session rows scrollable", () => {
    expect(source).toContain("mx-auto grid h-full min-h-0 w-full max-w-[620px]");
    expect(source).not.toContain("max-h-[300px]");
    expect(source).toContain("grid-rows-[auto_minmax(0,1fr)]");
    expect(source).toContain("min-h-0 overflow-y-auto");
    expect(rowSource).toContain("h-7 border-b");
    expect(rowSource).toContain("shrink-0 font-mono text-xs");
  });

  it("renders only 30 saved sessions on first paint and keeps an accessible load-more control", () => {
    const sessions: SessionInfo[] = Array.from({ length: 87 }, (_, index) => ({
      sessionId: `id-${index}`,
      cwd: "/project",
      title: `Conversation ${index}`,
      updatedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
    }));
    const html = render(SessionStartView, {
      props: { sessions, workspace: "/project", onSelect: () => {} },
    }).body;
    expect(html.match(/data-saved-session-row/g)).toHaveLength(30);
    expect(html).toContain("Showing 30 of 87 conversations");
    expect(html).toContain("Show 15 more");
    expect(html).toContain("Conversation 86");
    expect(html).not.toContain("Conversation 0");
    expect(source).toContain('bind:this={scrollContainer}');
    expect(source).toContain("new IntersectionObserver");
    expect(source).toContain("{ root, rootMargin:");
    expect(source).toContain("observer.disconnect()");
    expect(source).toContain("resetPages(); cancelSearch();");
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
