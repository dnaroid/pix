// @ts-expect-error Node fs import in Vitest runner
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeOggToWav, MAX_OGG_SOURCE_BYTES } from "./ogg-audio-decode";

describe("packaged Ogg compatibility decoders", () => {
  it.each([
    ["tone-vorbis.ogg", 16000, 1], ["tone-opus.opus", 48000, 2],
  ] as const)("decodes %s into playable 16-bit PCM WAV", async (name, rate, channels) => {
    const bytes = readFileSync(new URL(`../../test-fixtures/audio/${name}`, import.meta.url));
    const wav = await decodeOggToWav(bytes);
    const view = new DataView(wav);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 16))).toBe("WAVEfmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(channels);
    expect(view.getUint32(24, true)).toBe(rate);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(wav.byteLength - 44);
    const duration = (wav.byteLength - 44) / (channels * 2 * rate);
    expect(duration).toBeCloseTo(0.1, 1);
    expect(new Int16Array(wav, 44).some((sample) => Math.abs(sample) > 100)).toBe(true);
  });

  it("rejects invalid data and oversized input without starting a decoder", async () => {
    await expect(decodeOggToWav(new Uint8Array(0))).rejects.toThrow("Invalid Ogg");
    await expect(decodeOggToWav(new Uint8Array(MAX_OGG_SOURCE_BYTES + 1))).rejects.toThrow("32 MiB");
    const other = new Uint8Array(64);
    other.set(new TextEncoder().encode("OggS"));
    await expect(decodeOggToWav(other)).rejects.toThrow("Only Ogg Vorbis and Ogg Opus");
  });
});
