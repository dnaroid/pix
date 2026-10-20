import { decodeOggToWav, MAX_OGG_SOURCE_BYTES } from "./ogg-audio-decode";

async function readAudio(source: string): Promise<Uint8Array> {
  const response = await fetch(source);
  if (!response.ok || !response.body) throw new Error("Could not read local Ogg audio.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_OGG_SOURCE_BYTES) throw new Error("Ogg audio exceeds the 32 MiB compatibility limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return data;
}

self.onmessage = async (event: MessageEvent<string>) => {
  try {
    const wav = await decodeOggToWav(await readAudio(event.data));
    self.postMessage({ wav }, { transfer: [wav] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Ogg audio decoding failed." });
  }
};
