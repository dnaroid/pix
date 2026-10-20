import { OggVorbisDecoder } from "@wasm-audio-decoders/ogg-vorbis";
import { OggOpusDecoder } from "ogg-opus-decoder";

export const MAX_OGG_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_PCM_SAMPLES = 16 * 1024 * 1024; // 64 MiB of float PCM, across all channels.

interface DecodedAudio {
  channelData: Float32Array[];
  samplesDecoded: number;
  sampleRate: number;
  errors: unknown[];
}

function oggCodec(data: Uint8Array): "vorbis" | "opus" {
  if (data.length < 28 || String.fromCharCode(...data.subarray(0, 4)) !== "OggS" || data[4] !== 0) {
    throw new Error("Invalid Ogg audio header.");
  }
  const packet = 27 + data[26]!;
  const signature = String.fromCharCode(...data.subarray(packet, packet + 8));
  if (signature === "OpusHead") return "opus";
  if (signature.startsWith("\x01vorbis")) return "vorbis";
  throw new Error("Only Ogg Vorbis and Ogg Opus audio can use the compatibility decoder.");
}

/** Runs in a dedicated worker, never on the UI thread. No decoder state is shared. */
export async function decodeOggToWav(data: Uint8Array): Promise<ArrayBuffer> {
  if (data.byteLength > MAX_OGG_SOURCE_BYTES) throw new Error("Ogg audio exceeds the 32 MiB compatibility limit.");
  const decoder = oggCodec(data) === "opus" ? new OggOpusDecoder() : new OggVorbisDecoder();
  const chunks: Float32Array[][] = [];
  let samples = 0;
  let channels = 0;
  let sampleRate = 0;
  function collect(decoded: DecodedAudio): void {
    if (decoded.errors.length) throw new Error("Ogg audio contains decoding errors.");
    if (!decoded.samplesDecoded) return;
    const count = decoded.channelData.length;
    if (count < 1 || count > 8 || !Number.isInteger(decoded.sampleRate) || decoded.sampleRate <= 0
      || (channels && (count !== channels || decoded.sampleRate !== sampleRate))) {
      throw new Error("Unsupported Ogg channel or sample-rate change.");
    }
    channels = count;
    sampleRate = decoded.sampleRate;
    samples += decoded.samplesDecoded;
    if (samples * channels > MAX_PCM_SAMPLES) throw new Error("Decoded Ogg audio exceeds the 64 MiB compatibility limit.");
    if (decoded.channelData.some((channel) => channel.length !== decoded.samplesDecoded)) {
      throw new Error("Incomplete decoded Ogg audio.");
    }
    chunks.push(decoded.channelData);
  }
  try {
    await decoder.ready;
    for (let offset = 0; offset < data.length; offset += 16384) {
      collect(await decoder.decode(data.subarray(offset, offset + 16384)));
    }
    collect(await decoder.flush());
    if (!samples) throw new Error("Ogg audio contains no playable samples.");
    return pcmToWav(chunks, samples, channels, sampleRate);
  } finally {
    decoder.free();
  }
}

function pcmToWav(chunks: Float32Array[][], samples: number, channels: number, sampleRate: number): ArrayBuffer {
  const dataBytes = samples * channels * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  function text(offset: number, value: string): void {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  }
  text(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (let sample = 0; sample < chunk[0]!.length; sample++) {
      for (const channel of chunk) {
        const value = Math.max(-1, Math.min(1, channel[sample]!));
        view.setInt16(offset, value < 0 ? value * 32768 : value * 32767, true);
        offset += 2;
      }
    }
  }
  return buffer;
}
