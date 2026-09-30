import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "bun:test";
const directory = fileURLToPath(new URL("../../src/claude-code-provider/", import.meta.url));

test("real serializer accepts 21 and 100 images, retains byte and content guards", async () => {
  const { prepareRequest, prepareRequestWithLimits } = await import(pathToFileURL(join(directory, "src/context-serializer.ts")).href);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=";
  const image = { type: "image", data: png, mimeType: "image/png" };
  const context = (count, block = image) => ({ messages: Array.from({ length: count }, (_, i) => ({
    role: i % 2 ? "toolResult" : "user", content: [block], timestamp: i,
    ...(i % 2 ? { toolCallId: `read-${i}`, toolName: "Read", isError: false } : {}),
  })) });
  for (const count of [21, 100]) {
    const prepared = await prepareRequest(context(count));
    try {
      assert.equal(prepared.imageCount, count);
      assert.equal(prepared.attachmentPaths.length, 1);
      assert.equal(prepared.nativeImages.length, 1);
      assert.equal(prepared.nativeImages[0].source.data, png);
      assert.equal(prepared.imageBytes, Buffer.from(png, "base64").length);
      assert.equal(prepared.transcriptBlocks.join("\n").match(/image_attachment/g).length, count + 1);
    } finally {
      await rm(prepared.directory, { recursive: true, force: true });
    }
  }
  await assert.rejects(prepareRequestWithLimits(context(21), { images: 20 }), /At most 20 images/);
  await assert.rejects(prepareRequestWithLimits(context(1), { imageBytes: 1 }), /Image size/);
  await assert.rejects(prepareRequestWithLimits(context(1), { totalImageBytes: 1 }), /Aggregate image size/);
  await assert.rejects(prepareRequestWithLimits(context(1), { transcriptBytes: 1 }), /Serialized Pi context exceeds/);
  await assert.rejects(prepareRequest(context(1, { ...image, mimeType: "image/unknown" })), /Unsupported image type/);
  await assert.rejects(prepareRequest(context(1, { ...image, data: "invalid!" })), /not valid base64/);
});
