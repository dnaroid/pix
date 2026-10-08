import { describe, expect, it, vi } from "vitest";
import type { DeepgramDictationCallbacks, DeepgramDictationState } from "./deepgram";
import { insertSearchTranscript, SearchVoiceController, type SearchDictation } from "./search-voice-controller";

function harness() {
  const callbacks = { onState: vi.fn(), onFinal: vi.fn(), onInterim: vi.fn(), onError: vi.fn() };
  const recordings: Array<{ events: DeepgramDictationCallbacks; port: SearchDictation; finish: () => void }> = [];
  const controller = new SearchVoiceController(events => {
    let state: DeepgramDictationState = "idle";
    let finish = () => {};
    const port: SearchDictation = {
      currentState: () => state,
      start: vi.fn(async () => { state = "listening"; events.onState(state); }),
      stop: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })),
      dispose: vi.fn(async () => { state = "idle"; }),
    };
    recordings.push({ events, port, finish: () => finish() });
    return port;
  }, callbacks);
  return { controller, callbacks, recordings };
}

describe("search voice ownership", () => {
  it("delivers transcripts during normal stop, without submitting a search", async () => {
    const { controller, recordings, callbacks } = harness();
    await controller.toggle();
    const stopped = controller.stop();
    recordings[0]!.events.onFinal("find task");
    recordings[0]!.finish();
    expect(await stopped).toBe(true);
    expect(callbacks.onFinal).toHaveBeenCalledExactlyOnceWith("find task");
  });
  it("rejects late finals, interims, errors and states after typing or scope replacement", async () => {
    const { controller, recordings, callbacks } = harness();
    await controller.toggle();
    controller.cancel();
    await controller.toggle();
    callbacks.onState.mockClear();
    callbacks.onInterim.mockClear();
    recordings[0]!.events.onFinal("stale");
    recordings[0]!.events.onInterim("stale");
    recordings[0]!.events.onError("stale");
    recordings[0]!.events.onState("listening");
    expect(callbacks.onFinal).not.toHaveBeenCalled();
    expect(callbacks.onInterim).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onState).not.toHaveBeenCalled();
    recordings[1]!.events.onFinal("current");
    expect(callbacks.onFinal).toHaveBeenCalledExactlyOnceWith("current");
    expect(recordings[0]!.port.dispose).toHaveBeenCalledOnce();
  });
  it("invalidates an awaiting submit if the recording is cancelled", async () => {
    const { controller, recordings } = harness();
    await controller.toggle();
    const stopped = controller.stop();
    controller.cancel();
    recordings[0]!.finish();
    expect(await stopped).toBe(false);
  });
  it("does not create another recording when the microphone toggles to stop", async () => {
    const { controller, recordings } = harness();
    await controller.toggle();
    const toggled = controller.toggle();
    expect(recordings).toHaveLength(1);
    expect(recordings[0]!.port.stop).toHaveBeenCalledOnce();
    recordings[0]!.finish();
    await toggled;
  });
  it("disposes microphone ownership and ignores callbacks after dialog teardown", async () => {
    const { controller, recordings, callbacks } = harness();
    await controller.toggle();
    callbacks.onState.mockClear();
    controller.dispose();
    recordings[0]!.events.onFinal("late");
    recordings[0]!.events.onState("idle");
    await controller.toggle();
    expect(callbacks.onFinal).not.toHaveBeenCalled();
    expect(callbacks.onState).not.toHaveBeenCalled();
    expect(recordings[0]!.port.dispose).toHaveBeenCalledOnce();
    expect(recordings).toHaveLength(1);
  });
  it("fences a pending microphone start after cancellation and a new recording", async () => {
    const { controller, recordings, callbacks } = harness();
    await controller.toggle();
    controller.cancel();
    let resolveStart = () => {};
    const pendingStart = new Promise<void>(resolve => { resolveStart = resolve; });
    // Simulate a late token/permission grant even though its owner was cancelled.
    const create = (events: DeepgramDictationCallbacks): SearchDictation => ({
      currentState: () => "starting",
      start: async () => { await pendingStart; events.onState("listening"); events.onFinal("late grant"); },
      stop: async () => {},
      dispose: async () => {},
    });
    const delayed = new SearchVoiceController(create, callbacks);
    const starting = delayed.toggle();
    delayed.dispose();
    await controller.toggle();
    callbacks.onState.mockClear();
    resolveStart();
    await starting;
    expect(callbacks.onState).not.toHaveBeenCalled();
    expect(callbacks.onFinal).not.toHaveBeenCalled();
    recordings[1]!.events.onFinal("current");
    expect(callbacks.onFinal).toHaveBeenCalledExactlyOnceWith("current");
  });
});

describe("search transcript insertion", () => {
  it("replaces selection, normalizes whitespace and preserves the remaining query", () => {
    expect(insertSearchTranscript("find old task", " new\n open ", 5, 8)).toEqual({ query: "find new open task", caret: 13 });
    expect(insertSearchTranscript("task", "open", 0, 0)).toEqual({ query: "open task", caret: 5 });
  });
  it("respects the query limit without discarding existing text", () => {
    const inserted = insertSearchTranscript("x".repeat(2040), "extra long transcript", 2040, 2040);
    expect(inserted.query).toHaveLength(2048);
    expect(inserted.query.startsWith("x".repeat(2040))).toBe(true);
    expect(insertSearchTranscript("x".repeat(2048), "overflow", 2048, 2048).query).toHaveLength(2048);
  });
  it("ignores empty transcripts", () => {
    expect(insertSearchTranscript("task", " \n ", 2, 2)).toEqual({ query: "task", caret: 2 });
  });
});
