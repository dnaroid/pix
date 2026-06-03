import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractImageContents, renderContent, renderUserMessageContent, submittedUserDisplayText } from "../src/app/message-content.js";
import type { ImageContent } from "../src/input-editor.js";

describe("message-content", () => {
	it("renders mixed content and labels images", () => {
		const image: ImageContent = { type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" };

		assert.equal(renderContent(["hello", image, { text: "world" }, { thinking: "plan" }, 42]), [
			"hello",
			"[Image: image/png]",
			"world",
			"plan",
			"42",
		].join("\n"));
	});

	it("renders user message arrays with appended image labels", () => {
		const image: ImageContent = { type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" };

		assert.equal(renderUserMessageContent(["Look [Image 1]", image, { text: "done" }]), [
			"Look ",
			"done",
			"[Image]",
		].join("\n"));
		assert.equal(renderUserMessageContent("plain text"), "plain text");
	});

	it("extracts images and falls back to prompt text only when needed", () => {
		const image: ImageContent = { type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" };
		const mixed = [image, { type: "text", text: "nope" }, null];

		assert.deepEqual(extractImageContents(mixed), [image]);
		assert.equal(submittedUserDisplayText("  keep  ", "prompt", [image]), "  keep");
		assert.equal(submittedUserDisplayText("   ", "prompt", [image]), "[Image]");
		assert.equal(submittedUserDisplayText("   ", "prompt", []), "prompt");
	});
	it("renders image-only user content and empty arrays safely", () => {
		const image = { type: "image" as const, data: Buffer.from("png").toString("base64"), mimeType: "image/png" };

		assert.equal(renderUserMessageContent([image]), "[Image]");
		assert.equal(renderUserMessageContent([]), "");
		assert.deepEqual(extractImageContents([image, { type: "text", text: "ignored" }]), [image]);
	});

});
