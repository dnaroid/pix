import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NavigationCommandActions } from "../src/app/commands/command-navigation-actions.js";
import type { CommandControllerHost } from "../src/app/commands/command-host.js";

describe("NavigationCommandActions.runResumeCommand", () => {
	it("synchronizes the draft selector query while a resume load is already running", async () => {
		const events: string[] = [];
		const host = ({
			options: { cwd: "/tmp" },
			runtime: () => undefined,
			getResumeLoading: () => true,
			setResumeMenuMode: (mode: string) => events.push(`mode:${mode}`),
			openDirectPopupMenu: (_menu: string, options: { preserveStatus?: boolean; placement?: string }) => {
				events.push(`open:${options.preserveStatus === true}:${options.placement}`);
			},
			setDirectPopupMenuQuery: (query: string) => events.push(`query:${query}`),
			openResumeMenuWithQuery: (query: string) => events.push(`items:${query}`),
			setStatus: (status: string) => events.push(`status:${status}`),
			render: () => events.push("render"),
		} as unknown) as CommandControllerHost;

		await new NavigationCommandActions(host).runResumeCommand({
			preserveStatus: true,
			placement: "draft-surface",
			draft: true,
		});

		assert.deepEqual(events, [
			"mode:draft",
			"open:true:draft-surface",
			"query:",
			"items:",
			"render",
		]);
	});
});
