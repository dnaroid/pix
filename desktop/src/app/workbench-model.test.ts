import type { SessionInfo } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { buildSessionWorkbenchTabs } from "./workbench-model";

function build(sessions: SessionInfo[]) {
  return buildSessionWorkbenchTabs({
    sessions,
    draftSessionTabId: "draft",
    activeConversationTabId: null,
    runningSessionIds: new Set(),
    sessionActivityBySessionId: new Map(),
    pendingElicitationSessionIds: new Set(),
    disabled: false,
    realSessionCount: sessions.length,
  });
}

describe("session workbench model", () => {
  it("marks only ACP sessions carrying Pix fork metadata as forks", () => {
    const [forked, regular] = build([
      { sessionId: "forked", cwd: "/tmp/project", _meta: { "pix.isFork": true } },
      { sessionId: "regular", cwd: "/tmp/project" },
    ]);

    expect(forked?.fork).toBe(true);
    expect(regular?.fork).toBe(false);
  });
});
