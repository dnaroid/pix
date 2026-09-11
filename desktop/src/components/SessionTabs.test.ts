import { describe, expect, it } from "vitest";
import appSource from "../App.svelte?raw";
import source from "./SessionTabs.svelte?raw";

describe("SessionTabs desktop interaction", () => {
  it("uses a roving ARIA tablist with New Conversation as the only trailing titlebar action", () => {
    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain("aria-selected={active}");
    expect(source).toContain('aria-controls="conversation-workspace"');
    expect(source).toContain("sessionTabFocusIndex(index, event.key, sessions.length)");
    expect(source).toContain('aria-label="New conversation"');
    expect(source).not.toContain("data-session-picker");
    expect(source).not.toContain("ChevronDown");
    expect(source).toContain("max-w-[calc(100%-32px)]");
    expect(source).toContain('data-session-new');
    expect(source).toContain('class="mb-0.5 grid h-7 w-6');
    expect(source).toContain('class="min-w-3 flex-1 self-stretch" data-tauri-drag-region');
    expect(appSource).toContain("sessions={titlebarSessions}");
    expect(appSource).toContain("activeSessionId={activeConversationTabId}");
  });

  it("keeps pointer close outside the normal Tab sequence and supports Delete plus middle-click close", () => {
    expect(source).toContain('tabindex="-1"');
    expect(source).toContain('event.key !== "Delete"');
    expect(source).toContain("event.button !== 1");
    expect(source).toContain("onmousedown={(event) => handleTabMouseDown(event, session.sessionId)}");
    expect(source).not.toContain("onauxclick");
    expect(source).not.toContain("disabled={disabled || running}");
  });

  it("requires confirmation before closing a running conversation", () => {
    expect(appSource).toContain("if (runningSessionIds.has(sessionId))");
    expect(appSource).toContain("window.confirm");
    expect(appSource).toContain("Closing this tab will stop the active run. Close it?");
    expect(source).toContain("if (!closed) return;");
  });
});
