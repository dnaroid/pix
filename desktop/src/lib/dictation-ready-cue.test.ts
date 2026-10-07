import { afterEach, describe, expect, it, vi } from "vitest";

import { createDictationReadyCue } from "./dictation-ready-cue";

class FakeAudioContext {
  static latest: FakeAudioContext;
  state = "running";
  currentTime = 4;
  destination = {};
  resume = vi.fn(async () => {});
  close = vi.fn(async () => { this.state = "closed"; });
  oscillator = {
    type: "",
    frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
    onended: null as (() => void) | null,
  };
  gain = {
    gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
    connect: vi.fn(), disconnect: vi.fn(),
  };
  constructor() { FakeAudioContext.latest = this; }
  createOscillator = vi.fn(() => this.oscillator);
  createGain = vi.fn(() => this.gain);
}

afterEach(() => vi.unstubAllGlobals());

describe("dictation readiness cue", () => {
  it("unlocks on preparation, plays one short tone and releases resources on completion", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const cue = createDictationReadyCue();
    const context = FakeAudioContext.latest;
    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.oscillator.start).not.toHaveBeenCalled();
    cue.play();
    cue.play();
    expect(context.oscillator.start).toHaveBeenCalledExactlyOnceWith(4);
    expect(context.oscillator.stop).toHaveBeenCalledWith(4.1);
    expect(context.oscillator.frequency.setValueAtTime).toHaveBeenCalledWith(880, 4);
    expect(context.gain.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 4.1);
    context.oscillator.onended?.();
    expect(context.oscillator.disconnect).toHaveBeenCalledOnce();
    expect(context.gain.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    cue.dispose();
    cue.play();
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.oscillator.start).toHaveBeenCalledOnce();
  });

  it("does not play after disposal even when audio resume completes later", async () => {
    let resume!: () => void;
    class PendingContext extends FakeAudioContext {
      override state = "suspended";
      override resume = vi.fn(() => new Promise<void>((resolve) => { resume = resolve; }));
    }
    vi.stubGlobal("AudioContext", PendingContext);
    const cue = createDictationReadyCue();
    const context = FakeAudioContext.latest;
    cue.dispose();
    resume();
    await Promise.resolve();
    cue.play();
    expect(context.oscillator.start).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("skips blocked audio instead of playing a delayed readiness cue", () => {
    vi.stubGlobal("AudioContext", FakeAudioContext);
    const cue = createDictationReadyCue();
    const context = FakeAudioContext.latest;
    context.state = "suspended";
    cue.play();
    context.state = "running";
    cue.play();
    expect(context.oscillator.start).not.toHaveBeenCalled();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("releases resources if audio resume is rejected", async () => {
    class RejectedContext extends FakeAudioContext {
      override resume = vi.fn(async () => { throw new Error("blocked"); });
    }
    vi.stubGlobal("AudioContext", RejectedContext);
    const cue = createDictationReadyCue();
    await Promise.resolve();
    cue.play();
    expect(FakeAudioContext.latest.close).toHaveBeenCalledOnce();
    expect(FakeAudioContext.latest.oscillator.start).not.toHaveBeenCalled();
  });

  it("is harmless when audio is unsupported or construction fails", () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(() => createDictationReadyCue().play()).not.toThrow();
    vi.stubGlobal("AudioContext", class { constructor() { throw new Error("unavailable"); } });
    expect(() => createDictationReadyCue().play()).not.toThrow();
  });
});
