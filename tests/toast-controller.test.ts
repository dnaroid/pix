import assert from "node:assert/strict";
import test from "node:test";
import { AppToastController } from "../src/app/rendering/toast-controller.js";

test("AppToastController scopes visible toasts to the active tab/session", () => {
	let activeScope = "tab-a";
	let renders = 0;
	const controller = new AppToastController({
		activeScope: () => activeScope,
		render: () => { renders += 1; },
	});

	controller.showToast("from A", "info", { durationMs: 60_000 });
	activeScope = "tab-b";
	controller.showToast("from B", "warning", { durationMs: 60_000 });

	assert.deepEqual(controller.visibleStates().map((toast) => toast.message), ["from B"]);
	activeScope = "tab-a";
	assert.deepEqual(controller.visibleStates().map((toast) => toast.message), ["from A"]);
	assert.equal(renders, 2);

	controller.clearToastTimers();
});

test("AppToastController keeps explicit extension-context toasts in their source scope", () => {
	let activeScope = "tab-a";
	const controller = new AppToastController({
		activeScope: () => activeScope,
		render: () => undefined,
	});

	controller.showToast("extension B", "info", { durationMs: 60_000, scopeKey: "tab-b" });
	assert.deepEqual(controller.visibleStates().map((toast) => toast.message), []);

	activeScope = "tab-b";
	assert.deepEqual(controller.visibleStates().map((toast) => toast.message), ["extension B"]);
	controller.clearToastTimers();
});
