import type { DeepgramDictationCallbacks, DeepgramDictationState } from "./deepgram";

export interface SearchDictation {
  currentState(): DeepgramDictationState;
  start(): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

/** Owns a recording, so cancelled search input cannot receive late transcripts. */
export class SearchVoiceController {
  private recording?: SearchDictation;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly create: (callbacks: DeepgramDictationCallbacks) => SearchDictation,
    private readonly callbacks: DeepgramDictationCallbacks,
  ) {}

  async toggle(): Promise<void> {
    if (this.disposed) return;
    if (this.recording && this.recording.currentState() !== "idle") {
      await this.stop();
      return;
    }
    this.cancel();
    const generation = this.generation;
    const current = () => !this.disposed && generation === this.generation;
    this.recording = this.create({
      onState: state => { if (current()) this.callbacks.onState(state); },
      onFinal: text => { if (current()) this.callbacks.onFinal(text); },
      onInterim: text => { if (current()) this.callbacks.onInterim(text); },
      onError: error => { if (current()) this.callbacks.onError(error); },
    });
    await this.recording.start();
  }

  async stop(): Promise<boolean> {
    const generation = this.generation;
    await this.recording?.stop();
    return !this.disposed && generation === this.generation;
  }

  cancel(): void {
    this.generation++;
    const previous = this.recording;
    this.recording = undefined;
    void previous?.dispose();
    if (!this.disposed) {
      this.callbacks.onState("idle");
      this.callbacks.onInterim("");
    }
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }
}

export function insertSearchTranscript(query: string, transcript: string, start: number, end: number): { query: string; caret: number } {
  const text = transcript.trim().replace(/\s+/g, " ");
  if (!text) return { query, caret: start };
  const before = query.slice(0, start);
  const after = query.slice(end);
  const prefix = before && !/\s$/.test(before) ? " " : "";
  const suffix = after && !/^\s/.test(after) ? " " : "";
  const room = Math.max(0, 2048 - before.length - after.length - prefix.length - suffix.length);
  const inserted = text.slice(0, room);
  if (!inserted) return { query, caret: start };
  return { query: before + prefix + inserted + suffix + after, caret: before.length + prefix.length + inserted.length + suffix.length };
}
