export const MAX_GLB_BYTES = 64 * 1024 * 1024;

export function isGlbPath(path: string): boolean {
  return /\.glb$/iu.test(path);
}

/** Validate before GLTFLoader can follow any resource references. */
export function validateGlb(bytes: ArrayBuffer): void {
  if (bytes.byteLength > MAX_GLB_BYTES) throw new Error("GLB exceeds the 64 MiB preview limit.");
  if (bytes.byteLength < 20) throw new Error("Invalid GLB header.");
  const view = new DataView(bytes);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2
    || view.getUint32(8, true) !== bytes.byteLength) throw new Error("Expected a complete GLB 2.0 file.");
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || jsonLength > bytes.byteLength - 20) {
    throw new Error("Invalid GLB JSON chunk.");
  }
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength)));
  if (!json || typeof json !== "object" || json.asset?.version !== "2.0") {
    throw new Error("Expected glTF 2.0 content.");
  }
  // Reject URI references everywhere, including extension-owned resources.
  const pending: { value: unknown; depth: number }[] = [{ value: json, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (!value || typeof value !== "object") continue;
    if (depth > 128) throw new Error("GLB metadata nesting exceeds the preview limit.");
    for (const [key, child] of Object.entries(value)) {
      if (key === "uri" && (typeof child !== "string" || !/^data:/iu.test(child))) {
        throw new Error("GLB preview requires embedded resources; external resources are disabled.");
      }
      if (child && typeof child === "object") pending.push({ value: child, depth: depth + 1 });
    }
  }
  const unsupported = ["KHR_draco_mesh_compression", "KHR_texture_basisu", "EXT_meshopt_compression"];
  if (json.extensionsRequired?.some((name: string) => unsupported.includes(name))) {
    throw new Error("This GLB requires an unsupported compression decoder.");
  }
}

/** Streaming cap also catches missing/incorrect Content-Length and file growth. */
export async function readGlbResponse(response: Response, validate = true, limit = MAX_GLB_BYTES): Promise<ArrayBuffer> {
  if (!response.ok) throw new Error(`Unable to read GLB (${response.status}).`);
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("GLB exceeds the 64 MiB preview limit.");
  }
  if (!response.body) throw new Error("Empty GLB response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error("GLB exceeds the 64 MiB preview limit or asset range bound.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (validate) validateGlb(bytes.buffer);
  return bytes.buffer;
}
