export type DictationReadyCue = {
  play(): void;
  dispose(): void;
};

/** Prepare during the microphone action, before async token/permission work. */
export function createDictationReadyCue(): DictationReadyCue {
  let context: AudioContext | undefined;
  let oscillator: OscillatorNode | undefined;
  let gain: GainNode | undefined;
  let played = false;

  const dispose = () => {
    if (oscillator) {
      oscillator.onended = null;
      try { oscillator.stop(); } catch { /* Already stopped. */ }
      oscillator.disconnect();
      oscillator = undefined;
    }
    gain?.disconnect();
    gain = undefined;
    const closing = context;
    context = undefined;
    if (closing && closing.state !== "closed") void closing.close().catch(() => {});
  };

  try {
    if (typeof AudioContext !== "undefined") {
      context = new AudioContext();
      // Unlock audio while user activation is still available. Never schedule
      // a late cue from this promise: it could outlive the recording.
      void context.resume().catch(dispose);
    }
  } catch {
    dispose();
  }

  return {
    dispose,
    play() {
      if (played || !context) return;
      played = true;
      if (context.state !== "running") {
        dispose();
        return;
      }
      try {
        const now = context.currentTime;
        oscillator = context.createOscillator();
        gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(880, now);
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.12, now + 0.01);
        gain.gain.linearRampToValueAtTime(0, now + 0.1);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.onended = dispose;
        oscillator.start(now);
        oscillator.stop(now + 0.1);
      } catch {
        dispose();
      }
    },
  };
}
