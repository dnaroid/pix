import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionNotification } from "@agentclientprotocol/sdk";
import { emptyTranscript, type TranscriptState } from "../lib/transcript";
import { createSessionUpdateBatcher } from "./session-update-batcher";

const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;

function runFrame(): void {
  const entry = frames.entries().next().value;
  if (!entry) throw new Error("No scheduled frame");
  frames.delete(entry[0]);
  entry[1](0);
}

function notification(text: string, sessionId = "active"): SessionNotification {
  return {
    sessionId,
    update: { sessionUpdate: "agent_message_chunk", messageId: "reply", content: { type: "text", text } },
  };
}

function fixture() {
  let transcript: TranscriptState = emptyTranscript;
  const transcripts = new Map<string, TranscriptState>();
  const cancellation = { requested: false };
  const state = {
    sessionId: "active",
    get transcript() { return transcript; },
    sessionTranscript: (id: string) => transcripts.get(id),
    setSessionTranscript: vi.fn((id: string, next: TranscriptState) => { transcripts.set(id, next); }),
    setTranscript: vi.fn((next: TranscriptState) => { transcript = next; }),
  };
  const options = {
    state,
    promptEndedAt: vi.fn<(id: string) => number | undefined>(() => undefined),
    promptRunning: () => false,
    promptCancellation: vi.fn((id: string) => id === "active" ? cancellation : undefined),
    clearPromptEndedAt: vi.fn(),
    followsLatest: () => true,
    scheduleScrollToLatest: vi.fn(),
  };
  return { state, options, transcripts, cancellation, batcher: createSessionUpdateBatcher(options) };
}

describe("session update frame queue", () => {
  beforeEach(() => {
    frameId = 0;
    frames.clear();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      const id = frameId++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("splits a backlog across frames without losing or reordering text", () => {
    const { state, batcher } = fixture();
    const chunks = Array.from({ length: 2000 }, (_, index) => `${index},`);
    for (const chunk of chunks) batcher.enqueue(notification(chunk));
    expect(frames.size).toBe(1);
    runFrame();
    expect(frames.size).toBe(1);
    expect(state.transcript.items[0]).toMatchObject({ type: "message" });
    expect(state.transcript.items[0]).not.toMatchObject({ text: chunks.join("") });
    while (frames.size) runFrame();
    expect(state.transcript.items[0]).toMatchObject({ text: chunks.join("") });
    expect(state.setTranscript.mock.calls.length).toBeGreaterThan(1);
  });

  it("cuts off queued and late answer/thinking chunks only for the stopped session", () => {
    const { batcher, options, cancellation, state, transcripts } = fixture();
    batcher.enqueue(notification("visible"));
    runFrame();
    for (let index = 0; index < 300; index += 1) batcher.enqueue(notification("buffered"));
    batcher.enqueue({ sessionId: "active", update: {
      sessionUpdate: "agent_thought_chunk", messageId: "thought", content: { type: "text", text: "buffered thinking" },
    } });
    cancellation.requested = true;
    batcher.enqueue(notification("late"));
    batcher.enqueue(notification("other session", "background"));
    while (frames.size) runFrame();
    expect(state.transcript.items).toHaveLength(1);
    expect(state.transcript.items[0]).toMatchObject({ text: "visible" });
    expect(transcripts.get("background")?.items[0]).toMatchObject({ text: "other session" });

    options.promptCancellation.mockReturnValue({ requested: false });
    batcher.enqueue(notification("new run"));
    runFrame();
    expect(state.transcript.items[0]).toMatchObject({ text: "visiblenew run" });
  });

  it("keeps system notices and tool settlement after Stop", () => {
    const { batcher, cancellation, state } = fixture();
    cancellation.requested = true;
    batcher.enqueue({ sessionId: "active", update: {
      sessionUpdate: "agent_message_chunk", messageId: "pix-system:notice:1", content: { type: "text", text: "notice" },
    } });
    batcher.enqueue({ sessionId: "active", update: {
      sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read", kind: "read", status: "in_progress",
    } });
    batcher.enqueue({ sessionId: "active", update: {
      sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "failed",
    } });
    runFrame();
    expect(state.transcript.items[0]).toMatchObject({ text: "notice" });
    expect(state.transcript.items[1]).toMatchObject({ status: "failed" });
  });

  it("does not revive stopped buffered chunks when a new run starts before paint", () => {
    const { batcher, cancellation, options, state } = fixture();
    batcher.enqueue(notification("old run"));
    cancellation.requested = true;
    batcher.enqueue(notification("late old run"));
    options.promptCancellation.mockReturnValue({ requested: false });
    batcher.enqueue(notification("new run"));
    runFrame();
    expect(state.transcript.items).toHaveLength(1);
    expect(state.transcript.items[0]).toMatchObject({ text: "new run" });
  });

  it("retains the completion boundary until the final queued chunk", () => {
    const { batcher, options } = fixture();
    options.promptEndedAt.mockReturnValue(1234);
    for (let index = 0; index < 300; index += 1) batcher.enqueue(notification("x"));
    runFrame();
    expect(options.clearPromptEndedAt).not.toHaveBeenCalled();
    while (frames.size) runFrame();
    expect(options.clearPromptEndedAt).toHaveBeenCalledExactlyOnceWith("active");
  });

  it("invalidates old callbacks on reset but accepts a new connection's updates", () => {
    const { batcher, state } = fixture();
    batcher.enqueue(notification("old connection"));
    const staleFrame = frames.values().next().value!;
    batcher.reset();
    expect(frames.size).toBe(0);
    batcher.enqueue(notification("new connection"));
    staleFrame(0);
    expect(state.setTranscript).not.toHaveBeenCalled();
    runFrame();
    expect(state.transcript.items[0]).toMatchObject({ text: "new connection" });
  });

  it("discards a closed session's pending updates without losing other sessions", () => {
    const { batcher, transcripts, options } = fixture();
    batcher.enqueue(notification("closed"));
    batcher.enqueue(notification("retained", "background"));
    batcher.discardSession("active");
    runFrame();
    expect(transcripts.has("active")).toBe(false);
    expect(transcripts.get("background")?.items[0]).toMatchObject({ text: "retained" });
    expect(options.scheduleScrollToLatest).not.toHaveBeenCalled();
  });

  it("ignores notifications and callbacks after disposal", () => {
    const { batcher, state } = fixture();
    batcher.enqueue(notification("pending"));
    const staleFrame = frames.values().next().value!;
    batcher.dispose();
    batcher.enqueue(notification("too late"));
    staleFrame(0);
    expect(frames.size).toBe(0);
    expect(state.setSessionTranscript).not.toHaveBeenCalled();
  });
});
