import { describe, expect, it } from "vitest";
import { isGlbPath, MAX_GLB_BYTES, readGlbResponse, validateGlb } from "./glb";

function glb(json: object): ArrayBuffer {
  const text = JSON.stringify(json);
  const encoded = new TextEncoder().encode(text + " ".repeat((4 - text.length % 4) % 4));
  const bytes = new Uint8Array(20 + encoded.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, encoded.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.set(encoded, 20);
  return bytes.buffer;
}

describe("GLB validation and bounded reading", () => {
  it("recognizes GLB case-insensitively, not GLTF or query strings", () => {
    expect(isGlbPath("models/chair.GLB")).toBe(true);
    expect(isGlbPath("chair.gltf")).toBe(false);
    expect(isGlbPath("chair.glb?remote=true")).toBe(false);
  });

  it("accepts embedded GLB 2.0", async () => {
    const bytes = glb({ asset: { version: "2.0" }, images: [{ uri: "data:image/png;base64,AA==" }] });
    expect(() => validateGlb(bytes)).not.toThrow();
    expect(await readGlbResponse(new Response(bytes))).toEqual(bytes);
  });

  it.each(["https://example.org/image.png", "texture.png", "file:///private/secret.png", "blob:foreign"])(
    "rejects external resource %s before parsing", (uri) => {
      expect(() => validateGlb(glb({ asset: { version: "2.0" }, images: [{ uri }] }))).toThrow("external resources");
      expect(() => validateGlb(glb({ asset: { version: "2.0" }, extensions: { example: { uri } } }))).toThrow("external resources");
    },
  );

  it.each(["KHR_draco_mesh_compression", "KHR_texture_basisu", "EXT_meshopt_compression"])(
    "reports unavailable decoder %s", (extension) => {
      expect(() => validateGlb(glb({ asset: { version: "2.0" }, extensionsRequired: [extension] }))).toThrow("compression decoder");
    },
  );

  it("rejects truncation, wrong magic/version, mismatched length and JSON chunk bounds", () => {
    expect(() => validateGlb(new ArrayBuffer(1))).toThrow("header");
    for (const [offset, value] of [[0, 0], [4, 1], [8, 4], [12, 1000000], [16, 0]] as const) {
      const bytes = glb({ asset: { version: "2.0" } });
      new DataView(bytes).setUint32(offset, value, true);
      expect(() => validateGlb(bytes)).toThrow();
    }
  });

  it("rejects deeply nested metadata without recursive traversal", () => {
    let nested: object = {};
    for (let i = 0; i < 140; i++) nested = { nested };
    expect(() => validateGlb(glb({ asset: { version: "2.0" }, extras: nested }))).toThrow("nesting");
  });

  it("rejects an oversized Content-Length and cancels the response", async () => {
    const response = new Response(new Uint8Array(1), { headers: { "content-length": String(MAX_GLB_BYTES + 1) } });
    await expect(readGlbResponse(response)).rejects.toThrow("64 MiB");
    expect(response.body!.locked).toBe(false);
  });

  it("caps streams even when Content-Length is missing or false and cancels them", async () => {
    let canceled = false;
    const chunk = new Uint8Array(1);
    Object.defineProperty(chunk, "byteLength", { value: MAX_GLB_BYTES + 1 });
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(chunk); },
      cancel() { canceled = true; },
    }), { headers: { "content-length": "1" } });
    await expect(readGlbResponse(response)).rejects.toThrow("64 MiB");
    expect(canceled).toBe(true);
    expect(response.body!.locked).toBe(false);
  });
});
