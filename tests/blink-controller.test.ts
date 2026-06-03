import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppBlinkController } from "../src/app/screen/blink-controller.js";

describe("AppBlinkController", () => {
	it("uses status-line renders for status-only blinking", () => {
		let fullRenderCount = 0;
		let statusLineRenderCount = 0;
		const controller = new AppBlinkController({
			requestRender: () => {
				fullRenderCount += 1;
			},
			renderStatusLine: () => {
				statusLineRenderCount += 1;
			},
		});

		controller.setActive("status-dot", true, { scope: "status-line", initialVisible: false });
		tick(controller);

		assert.equal(controller.visible("status-dot"), true);
		assert.equal(statusLineRenderCount, 1);
		assert.equal(fullRenderCount, 0);

		controller.dispose();
	});

	it("deduplicates mixed blink consumers to one full render", () => {
		let fullRenderCount = 0;
		let statusLineRenderCount = 0;
		const controller = new AppBlinkController({
			requestRender: () => {
				fullRenderCount += 1;
			},
			renderStatusLine: () => {
				statusLineRenderCount += 1;
			},
		});

		controller.setActive("status-dot", true, { scope: "status-line", initialVisible: false });
		controller.setActive("tab-attention", true, { scope: "full", initialVisible: true });
		tick(controller);

		assert.equal(controller.visible("status-dot"), true);
		assert.equal(controller.visible("tab-attention"), false);
		assert.equal(fullRenderCount, 1);
		assert.equal(statusLineRenderCount, 0);

		controller.dispose();
	});
});

function tick(controller: AppBlinkController): void {
	(controller as unknown as { tick(): void }).tick();
}
