import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import { test } from "bun:test";
import { prepareRequest } from "../../src/claude-code-provider/src/context-serializer.ts";
import { providerArgs } from "../../src/claude-code-provider/src/claude-args.ts";
import { largePng } from "./support/large-png.ts";

test("native images retain bytes, role correlation and order without @file expansion", async () => {
  assert.ok(largePng.length > 262144);
  const image = { type: "image" as const, mimeType: "image/png", data: largePng.toString("base64") };
  const jpeg = { type: "image" as const, mimeType: "image/jpeg", data: Buffer.from("jpeg fixture").toString("base64") };
  const prepared = await prepareRequest({ messages: [
    { role: "user", content: [image], timestamp: 1 },
    { role: "toolResult", toolCallId: "read-1", toolName: "Read", isError: false, content: [jpeg, image], timestamp: 2 },
    { role: "user", content: [{ type: "text", text: "Use @/not-an-attachment and both images" }], timestamp: 3 },
  ] });
  try {
    assert.equal(prepared.imageCount, 3);
    assert.equal(prepared.nativeImages.length, 2);
    assert.deepEqual(prepared.nativeImages.map((image) => image.attachment), prepared.attachmentPaths);
    const { prompt } = providerArgs(prepared, "opus", "high");
    // This is the exact envelope sent on stdin, not the logical Pi payload hook.
    const wire: { message: { content: typeof prompt } } = JSON.parse(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }));
    const native = wire.message.content.filter((block) => block.type === "image");
    assert.deepEqual(native.map((block) => block.source), [
      { type: "base64", media_type: "image/png", data: image.data },
      { type: "base64", media_type: "image/jpeg", data: jpeg.data },
    ]);
    assert.deepEqual(Buffer.from(native[0].source.data, "base64"), largePng);
    const text = prompt.filter((block) => block.type === "text").map((block) => block.text).join("\n");
    assert.ok(!text.includes("@"), "no generated or user @references reach the CLI expander");
    const records = prepared.transcriptBlocks.map((block) => JSON.parse(block));
    assert.equal(records[1].content[0].attachment, records[2].content[1].attachment);
    assert.equal(records[2].content[0].attachment, basename(prepared.nativeImages[1].attachment));
    assert.equal(prompt.filter((block) => "cache_control" in block).length, 1);
    assert.ok(prompt.slice(prepared.transcriptBlocks.length).every((block) => !("cache_control" in block)));
  } finally {
    await rm(prepared.directory, { recursive: true, force: true });
  }
});
