import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PI_FAVORITE_MODEL_REFS } from "../src/app/constants.js";

describe("default model catalog", () => {
	it("contains every default favorite model", async () => {
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const missing = PI_FAVORITE_MODEL_REFS.filter((ref) => {
			const separator = ref.indexOf("/");
			return separator < 1 || !runtime.getModel(ref.slice(0, separator), ref.slice(separator + 1));
		});

		assert.deepEqual(missing, []);
	});
});
