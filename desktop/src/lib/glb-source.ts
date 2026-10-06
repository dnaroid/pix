import { MAX_GLB_BYTES, readGlbResponse, validateGlb } from "./glb";

// An unrestricted Tauri asset GET buffers the entire file in native memory.
// Single ranges use its bounded read path (currently at most 1000 KiB).
const RANGE_BYTES = 1000 * 1024;
export async function readGlbSource(source: string, signal: AbortSignal): Promise<ArrayBuffer> {
  let output: Uint8Array<ArrayBuffer> | undefined;
  let offset = 0;
  do {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const response = await fetch(source, {
      signal, credentials: "omit", headers: { Range: `bytes=${offset}-${offset + RANGE_BYTES - 1}` },
    });
    if (response.status !== 206) {
      // Already in-memory attachment sources have no native file read.
      if (offset === 0 && /^(data:|blob:)/iu.test(source)) return readGlbResponse(response);
      await response.body?.cancel();
      throw new Error("GLB preview requires bounded asset range reads.");
    }
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers.get("content-range") ?? "");
    const start = Number(range?.[1]), end = Number(range?.[2]), total = Number(range?.[3]);
    if (!range || !Number.isSafeInteger(total) || total > MAX_GLB_BYTES || total < 1
      || start !== offset || end < start || end >= total || end - start + 1 > RANGE_BYTES
      || (output && output.length !== total)) {
      await response.body?.cancel();
      throw new Error(total > MAX_GLB_BYTES ? "GLB exceeds the 64 MiB preview limit." : "Invalid GLB asset range response.");
    }
    const bytes = await readGlbResponse(response, false, end - start + 1);
    if (bytes.byteLength !== end - start + 1) throw new Error("Incomplete GLB asset range response.");
    output ??= new Uint8Array(total);
    output.set(new Uint8Array(bytes), offset);
    offset = end + 1;
  } while (offset < output.length);
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  validateGlb(output.buffer);
  return output.buffer;
}
