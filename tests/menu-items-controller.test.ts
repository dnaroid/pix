import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppMenuItemsController } from "../src/app/menu-items-controller.js";

describe("AppMenuItemsController queue menu", () => {
	it("uses one universal cancellation item for queued messages", () => {
		const controller = new AppMenuItemsController({
			runtime: () => undefined,
			getBuiltinSlashCommands: () => [],
			getEntries: () => [],
			getResumeSessions: () => [],
		});
		const items = controller.getQueueMessageMenuItems();

		assert.deepEqual(items.map((item) => item.value), ["cancel", "edit", "send-now"]);
		assert.equal(items[0]?.label, "Cancel send");
		assert.equal(items[0]?.description, "Remove this message from the queue");
	});
});
