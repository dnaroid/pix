import { describe, expect, it } from "vitest";

import {
  buildDeepgramWebSocketUrl,
  chooseDeepgramRecorderMimeType,
  DeepgramDictationController,
  parseDeepgramMessage,
  type DeepgramDictationState,
} from "./deepgram";

describe("deepgram dictation helpers", () => {
  it("prefers Opus recorder formats in browser compatibility order", () => {
    const supported = new Set(["audio/webm", "audio/ogg;codecs=opus"]);
    expect(chooseDeepgramRecorderMimeType((mimeType: string) => supported.has(mimeType))).toBe("audio/webm");
    expect(chooseDeepgramRecorderMimeType(() => false)).toBeUndefined();
  });

  it("builds a Nova-3 streaming URL for the configured dictation language", () => {
    const url = new URL(buildDeepgramWebSocketUrl("nova-3", "ru"));
    expect(url.origin).toBe("wss://api.deepgram.com");
    expect(url.pathname).toBe("/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("language")).toBe("ru");
    expect(url.searchParams.get("interim_results")).toBe("true");
    expect(url.searchParams.get("punctuate")).toBe("true");
    expect(url.searchParams.get("smart_format")).toBe("true");
    expect(url.searchParams.has("encoding")).toBe(false);
  });

  it("parses Nova-3 interim and final Results frames and ignores other frames", () => {
    expect(parseDeepgramMessage(JSON.stringify({
      type: "Results",
      is_final: false,
      channel: { alternatives: [{ transcript: " live   draft " }] },
    }))).toEqual({ text: "live draft", isFinal: false });
    expect(parseDeepgramMessage(JSON.stringify({
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: " final words " }] },
    }))).toEqual({ text: "final words", isFinal: true });
    expect(parseDeepgramMessage(JSON.stringify({ type: "Metadata" }))).toBeUndefined();
    expect(parseDeepgramMessage("bad json")).toBeUndefined();
    expect(parseDeepgramMessage(new Blob())).toBeUndefined();
  });

  it("streams MediaRecorder chunks with a temporary bearer token and finalizes the last interim", async () => {
    const events: string[] = [];
    const socket = new FakeSocket();
    const recorder = new FakeRecorder();
    let readySounds = 0;
    let cueDisposals = 0;
    const track = { stopped: false, stop() { this.stopped = true; } };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    let requestedToken = 0;
    let socketProtocols: string[] = [];
    const controller = new DeepgramDictationController(
      {
        onState: (state: DeepgramDictationState) => events.push(`state:${state}`),
        onFinal: (text: string) => events.push(`final:${text}`),
        onInterim: (text: string | undefined) => events.push(`interim:${text ?? ""}`),
        onError: (message: string) => { if (message) events.push(`error:${message}`); },
      },
      async () => {
        requestedToken += 1;
        return {
          accessToken: "temporary.jwt",
          expiresIn: 60,
          model: "nova-3",
          language: "ru",
        };
      },
      {
        getUserMedia: async () => stream,
        createSocket: ((url: string, protocols: string[]) => {
          expect(new URL(url).searchParams.get("model")).toBe("nova-3");
          expect(new URL(url).searchParams.get("language")).toBe("ru");
          socketProtocols = protocols;
          return socket as unknown as WebSocket;
        }),
        createRecorder: (() => recorder as unknown as MediaRecorder),
        delay: async () => {},
        createReadyCue: () => ({
          play: () => { expect(recorder.state).toBe("recording"); readySounds += 1; },
          dispose: () => { cueDisposals += 1; },
        }),
      },
    );

    await controller.start();
    expect(requestedToken).toBe(1);
    expect(socketProtocols).toEqual(["bearer", "temporary.jwt"]);
    expect(recorder.startedWith).toBe(250);
    expect(controller.currentState()).toBe("listening");
    expect(readySounds).toBe(1);

    const chunk = new Blob(["audio"]);
    recorder.emit("dataavailable", { data: chunk });
    expect(socket.sent[0]).toBe(chunk);
    socket.emit("message", { data: deepgramResult("draft", false) });
    socket.emit("message", { data: deepgramResult("done", true) });
    socket.emit("message", { data: deepgramResult("tail", false) });

    await controller.stop();

    expect(events).toContain("interim:draft");
    expect(events).toContain("final:done");
    expect(events).toContain("final:tail");
    expect(socket.sent.at(-2)).toBeInstanceOf(Blob);
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "Finalize" }));
    expect(socket.closed).toBe(true);
    expect(recorder.state).toBe("inactive");
    expect(track.stopped).toBe(true);
    expect(controller.currentState()).toBe("idle");
    expect(readySounds).toBe(1);
    expect(cueDisposals).toBe(1);
  });

  it("cancels a recording while the Deepgram socket is still connecting", async () => {
    const socket = new FakeSocket(0);
    const track = { stopped: false, stop() { this.stopped = true; } };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    let recorderCreations = 0;
    let readySounds = 0;
    let cueDisposals = 0;
    const controller = new DeepgramDictationController(
      {
        onState: () => {},
        onFinal: () => {},
        onInterim: () => {},
        onError: () => {},
      },
      async () => ({ accessToken: "temporary.jwt", expiresIn: 60 }),
      {
        getUserMedia: async () => stream,
        createSocket: (() => socket as unknown as WebSocket),
        createRecorder: (() => {
          recorderCreations += 1;
          return new FakeRecorder() as unknown as MediaRecorder;
        }),
        delay: async () => {},
        createReadyCue: () => ({ play: () => { readySounds += 1; }, dispose: () => { cueDisposals += 1; } }),
      },
    );

    const starting = controller.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.currentState()).toBe("starting");
    await controller.stop();
    await starting;

    expect(socket.closed).toBe(true);
    expect(track.stopped).toBe(true);
    expect(recorderCreations).toBe(0);
    expect(readySounds).toBe(0);
    expect(cueDisposals).toBe(1);
    expect(controller.currentState()).toBe("idle");
  });

  it("cancels a start while the token request is still pending", async () => {
    let resolveToken!: (token: { accessToken: string; expiresIn: number }) => void;
    let mediaRequests = 0;
    const controller = new DeepgramDictationController(
      {
        onState: () => {},
        onFinal: () => {},
        onInterim: () => {},
        onError: () => {},
      },
      async () => await new Promise((resolve) => { resolveToken = resolve; }),
      {
        getUserMedia: async () => {
          mediaRequests += 1;
          return { getTracks: () => [] } as unknown as MediaStream;
        },
      },
    );

    const starting = controller.start();
    await Promise.resolve();
    await controller.stop();
    resolveToken({ accessToken: "temporary.jwt", expiresIn: 60 });
    await starting;

    expect(mediaRequests).toBe(0);
    expect(controller.currentState()).toBe("idle");
  });

  for (const outcome of ["start", "stop", "dispose", "error"] as const) {
    it(`waits for actual recorder readiness and handles ${outcome} without a late cue`, async () => {
      const recorder = new FakeRecorder();
      recorder.autoStartEvent = false;
      const socket = new FakeSocket();
      let readySounds = 0;
      let cueDisposals = 0;
      const controller = new DeepgramDictationController(
        { onState: () => {}, onFinal: () => {}, onInterim: () => {}, onError: () => {} },
        async () => ({ accessToken: "temporary.jwt", expiresIn: 60 }),
        {
          getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
          createSocket: () => socket as unknown as WebSocket,
          createRecorder: () => recorder as unknown as MediaRecorder,
          delay: async () => {},
          createReadyCue: () => ({ play: () => { readySounds += 1; }, dispose: () => { cueDisposals += 1; } }),
        },
      );
      await controller.start();
      expect(controller.currentState()).toBe("starting");
      expect(readySounds).toBe(0);
      if (outcome === "stop") await controller.stop();
      else if (outcome === "dispose") await controller.dispose();
      else if (outcome === "error") recorder.emit("error", { error: new Error("failed") });
      recorder.emit("start", {});
      expect(readySounds).toBe(outcome === "start" ? 1 : 0);
      await controller.dispose();
      expect(cueDisposals).toBe(1);
    });
  }

  for (const failure of ["prepare", "play"] as const) {
    it(`does not fail dictation when cue ${failure} fails`, async () => {
      const controller = new DeepgramDictationController(
        { onState: () => {}, onFinal: () => {}, onInterim: () => {}, onError: () => {} },
        async () => ({ accessToken: "temporary.jwt", expiresIn: 60 }),
        {
          getUserMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
          createSocket: () => new FakeSocket() as unknown as WebSocket,
          createRecorder: () => new FakeRecorder() as unknown as MediaRecorder,
          createReadyCue: () => {
            if (failure === "prepare") throw new Error("unavailable");
            return { play: () => { throw new Error("unavailable"); }, dispose: () => {} };
          },
        },
      );
      await controller.start();
      expect(controller.currentState()).toBe("listening");
      await controller.dispose();
    });
  }

  it("releases the cue without playing on token failure", async () => {
    let readySounds = 0;
    let cueDisposals = 0;
    const controller = new DeepgramDictationController(
      { onState: () => {}, onFinal: () => {}, onInterim: () => {}, onError: () => {} },
      async () => { throw new Error("token failed"); },
      { createReadyCue: () => ({ play: () => { readySounds += 1; }, dispose: () => { cueDisposals += 1; } }) },
    );
    await controller.start();
    expect(controller.currentState()).toBe("idle");
    expect(readySounds).toBe(0);
    expect(cueDisposals).toBe(1);
  });

  it("does not restart when toggle is pressed during stop finalization", async () => {
    let tokenRequests = 0;
    let releaseFinalize!: () => void;
    const finalizeGate = new Promise<void>((resolve) => { releaseFinalize = resolve; });
    const track = { stopped: false, stop() { this.stopped = true; } };
    const controller = new DeepgramDictationController(
      {
        onState: () => {},
        onFinal: () => {},
        onInterim: () => {},
        onError: () => {},
      },
      async () => {
        tokenRequests += 1;
        return { accessToken: `temporary-${tokenRequests}`, expiresIn: 60 };
      },
      {
        getUserMedia: async () => ({ getTracks: () => [track] } as unknown as MediaStream),
        createSocket: (() => new FakeSocket() as unknown as WebSocket),
        createRecorder: (() => new FakeRecorder() as unknown as MediaRecorder),
        delay: async () => await finalizeGate,
      },
    );

    await controller.start();
    const stopping = controller.stop();
    await Promise.resolve();
    const toggling = controller.toggle();
    releaseFinalize();
    await Promise.all([stopping, toggling]);

    expect(tokenRequests).toBe(1);
    expect(controller.currentState()).toBe("idle");
  });

  it("dispose releases media immediately instead of waiting for finalization callbacks", async () => {
    const events: string[] = [];
    const socket = new FakeSocket();
    const recorder = new FakeRecorder();
    const track = { stopped: false, stop() { this.stopped = true; } };
    const controller = new DeepgramDictationController(
      {
        onState: (state: DeepgramDictationState) => events.push(`state:${state}`),
        onFinal: (text: string) => events.push(`final:${text}`),
        onInterim: (text: string | undefined) => events.push(`interim:${text ?? ""}`),
        onError: () => {},
      },
      async () => ({ accessToken: "temporary.jwt", expiresIn: 60 }),
      {
        getUserMedia: async () => ({ getTracks: () => [track] } as unknown as MediaStream),
        createSocket: (() => socket as unknown as WebSocket),
        createRecorder: (() => recorder as unknown as MediaRecorder),
        delay: async () => await new Promise<void>(() => {}),
      },
    );

    await controller.start();
    socket.emit("message", { data: deepgramResult("stale interim", false) });
    const result = await Promise.race([
      controller.dispose().then(() => "disposed" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 40)),
    ]);

    expect(result).toBe("disposed");
    expect(track.stopped).toBe(true);
    expect(socket.closed).toBe(true);
    expect(events).not.toContain("final:stale interim");
    expect(controller.currentState()).toBe("idle");
  });
});

class FakeSocket {
  readyState: number;
  sent: unknown[] = [];
  closed = false;
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  constructor(readyState = 1) {
    this.readyState = readyState;
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", { code: 1000, reason: "test close" });
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeRecorder {
  state: RecordingState = "inactive";
  autoStartEvent = true;
  startedWith: number | undefined;
  private readonly listeners = new Map<string, Set<(event: any) => void>>();

  start(timeslice?: number): void {
    this.state = "recording";
    this.startedWith = timeslice;
    if (this.autoStartEvent) this.emit("start", {});
  }

  stop(): void {
    this.emit("dataavailable", { data: new Blob(["final-audio"]) });
    this.state = "inactive";
    this.emit("stop", {});
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const bucket = this.listeners.get(type) ?? new Set();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function deepgramResult(text: string, isFinal: boolean): string {
  return JSON.stringify({
    type: "Results",
    is_final: isFinal,
    channel: { alternatives: [{ transcript: text }] },
  });
}
