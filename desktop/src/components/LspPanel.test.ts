import { describe, expect, it } from "vitest";
import { render } from "svelte/server";
import source from "./LspPanel.svelte?raw";
import LspPanel from "./LspPanel.svelte";

describe("LSP panel", () => {
  it("does not imply that disconnected status can create a session or start servers", () => {
    const { body } = render(LspPanel, { props: { client: null, sessionId: null } });
    expect(body).toContain("Language servers");
    expect(body).toContain("Open a conversation session to monitor project language servers");
    expect(body).not.toContain("Start servers");
  });

  it("omits the introductory lifecycle explanation", () => {
    const { body } = render(LspPanel, { props: { client: null, sessionId: null } });
    expect(body).not.toContain("Language servers are shared by connected sessions");
    expect(body).not.toContain("Running processes stay available for reuse");
  });

  it("only requests status and exposes no process or trust controls", () => {
    expect(source).toContain('targetClient.lspControl(targetSession, "status")');
    expect(source).not.toContain('act(');
    expect(source).not.toContain('title="Stop"');
    expect(source).not.toContain('title="Start"');
    expect(source).not.toContain('title="Restart"');
    expect(source).not.toContain('Trust project configuration</button>');
    expect(source).toContain('No running language servers for this project.');
  });

  it("does not subscribe the session-change effect to the request busy flag", () => {
    expect(source).toContain("untrack(() => void refresh(targetClient, targetSession, targetGeneration))");
    expect(source).toContain("clearInterval(timer)");
    expect(source).toContain("generation === targetGeneration && client === targetClient && sessionId === targetSession");
  });

  it("explains trust at the edit boundary rather than offering a panel action", () => {
    expect(source).toContain('{#if snapshot.trustRequired}<p');
    expect(source).toContain('Project configuration trust will be requested when a matching file is edited.');
  });
});
