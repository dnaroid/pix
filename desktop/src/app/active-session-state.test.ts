import { describe, expect, it } from "vitest";
import { emptyTranscript, appendLocalSystemMessage } from "../lib/transcript";
import { createActiveSessionState } from "./active-session-state.svelte";

describe("active session state", () => {
  it("keeps active transcript and per-session cache synchronized when requested", () => {
    const state = createActiveSessionState();
    state.setSessionId("session-a");
    const transcript = appendLocalSystemMessage(emptyTranscript, "hello", "local:1");

    state.setTranscriptFor("session-a", transcript);

    expect(state.transcript).toBe(transcript);
    expect(state.sessionTranscript("session-a")).toBe(transcript);
  });

  it("does not replace the active transcript when updating another session cache", () => {
    const state = createActiveSessionState();
    state.setSessionId("session-a");
    const active = appendLocalSystemMessage(emptyTranscript, "active", "local:1");
    const background = appendLocalSystemMessage(emptyTranscript, "background", "local:2");
    state.setTranscript(active);

    state.setTranscriptFor("session-b", background);

    expect(state.transcript).toBe(active);
    expect(state.sessionTranscript("session-b")).toBe(background);
  });

  it("resets workspace conversation content without changing session identity or runtime readiness", () => {
    const state = createActiveSessionState();
    state.setSessionId("session-a");
    state.setRuntimeReady(true);
    state.setConfigOptions([{ id: "model", name: "Model", type: "select", currentValue: "a", options: [] }]);
    state.setActiveTranscriptForSession(
      "session-a",
      appendLocalSystemMessage(emptyTranscript, "active", "local:1"),
    );

    state.resetWorkspaceConversation();

    expect(state.sessionId).toBe("session-a");
    expect(state.runtimeReady).toBe(true);
    expect(state.transcript).toBe(emptyTranscript);
    expect(state.configOptions).toEqual([]);
    expect(state.sessionTranscript("session-a")).toBeUndefined();
  });

  it("initializes active conversation state with optional empty-transcript caching", () => {
    const state = createActiveSessionState();
    state.setSessionId("session-a");

    state.initializeActiveConversation("session-a", [], true, false);
    expect(state.runtimeReady).toBe(true);
    expect(state.sessionTranscript("session-a")).toBeUndefined();

    state.initializeActiveConversation("session-a", [], false, true);
    expect(state.runtimeReady).toBe(false);
    expect(state.sessionTranscript("session-a")).toBe(emptyTranscript);
  });
});
