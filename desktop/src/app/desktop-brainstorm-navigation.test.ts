import { describe, expect, it, vi } from "vitest";
import { createBrainstormSessionOpener } from "./desktop-brainstorm-navigation";

function fixture() {
  let resolve!: () => void;
  const refresh = new Promise<void>((done) => { resolve = done; });
  const state = { sessionId: "origin" };
  const loadSession = vi.fn(async () => {});
  const report = vi.fn();
  const options = {
    workspace: () => "/project",
    state,
    client: () => null,
    sessions: { catalog: { refresh: () => refresh, sessions: [{ sessionId: "participant" }] } },
    transitions: { sessionTabs: { loadSession } },
    errors: { report },
  } as unknown as Parameters<typeof createBrainstormSessionOpener>[0];
  return { open: createBrainstormSessionOpener(options), resolve, state, loadSession, report, options };
}

describe("council participant navigation", () => {
  it("opens the existing participant session after catalog refresh", async () => {
    const f = fixture();
    const opening = f.open("participant");
    expect(f.loadSession).not.toHaveBeenCalled();
    f.resolve();
    await opening;
    expect(f.loadSession).toHaveBeenCalledExactlyOnceWith("participant");
    expect(f.report).not.toHaveBeenCalled();
  });

  it.each(["session", "workspace", "client"])("ignores stale navigation when %s changes during refresh", async (owner) => {
    const f = fixture();
    const opening = f.open("participant");
    if (owner === "session") f.state.sessionId = "other";
    if (owner === "workspace") f.options.workspace = () => "/other";
    if (owner === "client") f.options.client = () => ({} as ReturnType<typeof f.options.client>);
    f.resolve();
    await opening;
    expect(f.loadSession).not.toHaveBeenCalled();
    expect(f.report).not.toHaveBeenCalled();
  });

  it("reports a missing participant instead of creating a new session", async () => {
    const f = fixture();
    const opening = f.open("missing");
    f.resolve();
    await opening;
    expect(f.loadSession).not.toHaveBeenCalled();
    expect(f.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "This brainstorm session is no longer available." }));
  });
});
