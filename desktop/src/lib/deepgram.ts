export type DeepgramDictationState = "idle" | "starting" | "listening";

export type DeepgramToken = {
  accessToken: string;
  expiresIn: number;
};

export type DeepgramTranscript = {
  text: string;
  isFinal: boolean;
};

export type DeepgramDictationCallbacks = {
  onState: (state: DeepgramDictationState) => void;
  onFinal: (text: string) => void;
  onInterim: (text: string | undefined) => void;
  onError: (message: string) => void;
};

type DeepgramDictationDeps = {
  requestToken: () => Promise<DeepgramToken>;
  getUserMedia: () => Promise<MediaStream>;
  createSocket: (url: string, protocols: string[]) => WebSocket;
  createRecorder: (stream: MediaStream, mimeType?: string) => MediaRecorder;
  delay: (ms: number) => Promise<void>;
};

const RECORDER_TIMESLICE_MS = 250;
const FINALIZE_GRACE_MS = 300;
const RECORDER_STOP_TIMEOUT_MS = 1_000;
const SOCKET_OPEN_TIMEOUT_MS = 10_000;
const SOCKET_OPEN = 1;
const DEFAULT_MODEL = "nova-3";
const DEFAULT_LANGUAGE = "multi";

export function browserDeepgramSupported(): boolean {
  return typeof navigator !== "undefined"
    && typeof navigator.mediaDevices?.getUserMedia === "function"
    && typeof MediaRecorder !== "undefined"
    && typeof WebSocket !== "undefined";
}

export function chooseDeepgramRecorderMimeType(
  isTypeSupported: (mimeType: string) => boolean = (mimeType) => MediaRecorder.isTypeSupported(mimeType),
): string | undefined {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
    .find((mimeType) => isTypeSupported(mimeType));
}

export function buildDeepgramWebSocketUrl(model = DEFAULT_MODEL, language = DEFAULT_LANGUAGE): string {
  const url = new URL("wss://api.deepgram.com/v1/listen");
  url.searchParams.set("model", model.trim() || DEFAULT_MODEL);
  url.searchParams.set("language", language.trim() || DEFAULT_LANGUAGE);
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("punctuate", "true");
  url.searchParams.set("smart_format", "true");
  url.searchParams.set("vad_events", "true");
  url.searchParams.set("endpointing", "300");
  url.searchParams.set("utterance_end_ms", "1000");
  return url.toString();
}

export function parseDeepgramMessage(data: unknown): DeepgramTranscript | undefined {
  if (typeof data !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.type !== "Results" || !isRecord(parsed.channel)) return undefined;
  const alternatives = parsed.channel.alternatives;
  if (!Array.isArray(alternatives) || !isRecord(alternatives[0])) return undefined;
  const transcript = alternatives[0].transcript;
  if (typeof transcript !== "string") return undefined;
  const text = normalizeTranscript(transcript);
  return text ? { text, isFinal: parsed.is_final === true } : undefined;
}

export class DeepgramDictationController {
  private readonly deps: DeepgramDictationDeps;
  private state: DeepgramDictationState = "idle";
  private stream: MediaStream | undefined;
  private recorder: MediaRecorder | undefined;
  private socket: WebSocket | undefined;
  private interim: string | undefined;
  private generation = 0;
  private stopPromise: Promise<void> | undefined;
  private disposed = false;

  constructor(
    private readonly callbacks: DeepgramDictationCallbacks,
    requestToken: () => Promise<DeepgramToken>,
    overrides: Partial<Omit<DeepgramDictationDeps, "requestToken">> = {},
  ) {
    this.deps = {
      requestToken,
      getUserMedia: async () => await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }),
      createSocket: (url, protocols) => new WebSocket(url, protocols),
      createRecorder: (stream, mimeType) => mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream),
      delay,
      ...overrides,
    };
  }

  currentState(): DeepgramDictationState {
    return this.state;
  }

  async toggle(): Promise<void> {
    if (this.disposed) return;
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }
    if (this.state !== "idle") await this.stop();
    else await this.start();
  }

  async start(): Promise<void> {
    if (this.disposed || this.state !== "idle" || this.stopPromise) return;
    const generation = this.generation + 1;
    this.generation = generation;
    this.setState("starting");
    this.callbacks.onError("");

    let stream: MediaStream | undefined;
    let socket: WebSocket | undefined;
    try {
      const token = await this.deps.requestToken();
      if (!this.isCurrent(generation)) return;
      stream = await this.deps.getUserMedia();
      if (!this.isCurrent(generation)) {
        stopStream(stream);
        return;
      }
      this.stream = stream;

      socket = this.deps.createSocket(buildDeepgramWebSocketUrl(), ["bearer", token.accessToken]);
      this.socket = socket;
      await waitForSocketOpen(socket);
      if (!this.isCurrent(generation)) {
        safeCloseSocket(socket);
        stopStream(stream);
        return;
      }

      const recorder = this.deps.createRecorder(
        stream,
        typeof MediaRecorder === "undefined" ? undefined : chooseDeepgramRecorderMimeType(),
      );
      this.recorder = recorder;
      this.bindSocket(socket, generation);
      this.bindRecorder(recorder, socket, generation);
      recorder.start(RECORDER_TIMESLICE_MS);
      this.setState("listening");
    } catch (error) {
      if (socket) safeCloseSocket(socket);
      if (stream) stopStream(stream);
      if (!this.isCurrent(generation)) return;
      this.generation += 1;
      this.stream = undefined;
      this.socket = undefined;
      this.recorder = undefined;
      this.clearInterim();
      this.setState("idle");
      this.callbacks.onError(errorMessage(error));
    }
  }

  async stop(): Promise<void> {
    if (this.disposed) return;
    if (this.stopPromise) return await this.stopPromise;
    const stopping = Promise.resolve().then(() => this.stopNow());
    this.stopPromise = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopPromise === stopping) this.stopPromise = undefined;
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    const stream = this.stream;
    const recorder = this.recorder;
    const socket = this.socket;
    this.stream = undefined;
    this.recorder = undefined;
    this.socket = undefined;
    this.interim = undefined;
    this.state = "idle";
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        // Best-effort teardown after ownership has already been invalidated.
      }
    }
    if (socket) safeCloseSocket(socket);
    if (stream) stopStream(stream);
  }

  private async stopNow(): Promise<void> {
    if (this.disposed) return;
    if (this.state === "idle" && !this.stream && !this.socket && !this.recorder) return;
    const generation = this.generation;
    const stream = this.stream;
    const socket = this.socket;
    const recorder = this.recorder;
    const wasListening = this.state === "listening";

    try {
      if (recorder && recorder.state !== "inactive") {
        await stopRecorderAndFlush(recorder);
      }
      if (this.recorder === recorder) this.recorder = undefined;

      if (wasListening && socket?.readyState === SOCKET_OPEN) {
        try {
          socket.send(JSON.stringify({ type: "Finalize" }));
        } catch {
          // The last interim is committed below if Deepgram cannot be finalized.
        }
        await this.deps.delay(FINALIZE_GRACE_MS);
      }

      if (this.generation === generation) this.commitInterim();
    } finally {
      if (this.generation === generation) this.generation += 1;
      if (this.stream === stream) this.stream = undefined;
      if (this.recorder === recorder) this.recorder = undefined;
      if (this.socket === socket) this.socket = undefined;
      if (socket) safeCloseSocket(socket);
      if (stream) stopStream(stream);
      if (!this.disposed) this.setState("idle");
    }
  }

  private bindSocket(socket: WebSocket, generation: number): void {
    socket.addEventListener("message", (event) => {
      if (!this.isCurrentSocket(socket, generation)) return;
      const transcript = parseDeepgramMessage(event.data);
      if (!transcript) return;
      if (transcript.isFinal) {
        this.clearInterim();
        this.callbacks.onFinal(transcript.text);
        return;
      }
      this.interim = transcript.text;
      this.callbacks.onInterim(transcript.text);
    });
    socket.addEventListener("error", () => {
      if (!this.isCurrentSocket(socket, generation) || this.state === "idle" || this.stopPromise) return;
      this.callbacks.onError("Deepgram WebSocket error");
      void this.stop();
    });
    socket.addEventListener("close", (event) => {
      if (!this.isCurrentSocket(socket, generation) || this.state === "idle" || this.stopPromise) return;
      const details = event.code && event.code !== 1000
        ? ` (${event.code}${event.reason ? `: ${event.reason}` : ""})`
        : "";
      this.callbacks.onError(`Deepgram connection closed${details}`);
      void this.stop();
    });
  }

  private bindRecorder(recorder: MediaRecorder, socket: WebSocket, generation: number): void {
    recorder.addEventListener("dataavailable", (event) => {
      if (!this.isCurrentRecorder(recorder, socket, generation) || event.data.size === 0) return;
      if (socket.readyState !== SOCKET_OPEN) return;
      try {
        socket.send(event.data);
      } catch (error) {
        this.callbacks.onError(errorMessage(error));
        void this.stop();
      }
    });
    recorder.addEventListener("error", (event) => {
      if (!this.isCurrentRecorder(recorder, socket, generation) || this.stopPromise) return;
      const recorderError = "error" in event && event.error instanceof Error ? event.error.message : "MediaRecorder error";
      this.callbacks.onError(recorderError);
      void this.stop();
    });
  }

  private clearInterim(): void {
    if (!this.interim) return;
    this.interim = undefined;
    this.callbacks.onInterim(undefined);
  }

  private commitInterim(): void {
    const text = this.interim;
    this.clearInterim();
    if (text) this.callbacks.onFinal(text);
  }

  private setState(state: DeepgramDictationState): void {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onState(state);
  }

  private isCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  private isCurrentSocket(socket: WebSocket, generation: number): boolean {
    return this.isCurrent(generation) && this.socket === socket;
  }

  private isCurrentRecorder(recorder: MediaRecorder, socket: WebSocket, generation: number): boolean {
    return this.isCurrentSocket(socket, generation) && this.recorder === recorder;
  }
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === SOCKET_OPEN) return;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onOpen = () => finish();
    const onError = () => finish(new Error("Deepgram WebSocket connection failed"));
    const onClose = (event: CloseEvent) => finish(new Error(
      `Deepgram WebSocket closed before connecting${event.code ? ` (${event.code}${event.reason ? `: ${event.reason}` : ""})` : ""}`,
    ));
    const timer = setTimeout(
      () => finish(new Error("Deepgram WebSocket connection timed out")),
      SOCKET_OPEN_TIMEOUT_MS,
    );
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

function safeCloseSocket(socket: WebSocket): void {
  try {
    socket.close(1000, "voice input stopped");
  } catch {
    // Best-effort cleanup.
  }
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

async function stopRecorderAndFlush(recorder: MediaRecorder): Promise<void> {
  if (recorder.state === "inactive") return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      recorder.removeEventListener("stop", onStop);
      resolve();
    };
    const onStop = (): void => finish();
    const timer = setTimeout(finish, RECORDER_STOP_TIMEOUT_MS);
    recorder.addEventListener("stop", onStop);
    try {
      recorder.stop();
    } catch {
      finish();
    }
  });
}

function normalizeTranscript(text: string): string | undefined {
  const normalized = text.trim().replace(/\s+/gu, " ");
  return normalized || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
