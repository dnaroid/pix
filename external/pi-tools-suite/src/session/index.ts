import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createSessionNameHandler } from "../session-name/index.js";
import { createRecoveryHandlers } from "../session-recovery/index.js";
import { SESSION_TOOL_DESCRIPTION } from "../tool-descriptions.js";
import { SESSION_PARAMETERS, validateSessionParams } from "./parameters.js";

export default function session(pi: ExtensionAPI): void {
	const handlers = { name: createSessionNameHandler(pi), ...createRecoveryHandlers() };
	pi.registerTool({
		...SESSION_TOOL_DESCRIPTION,
		parameters: SESSION_PARAMETERS,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const error = validateSessionParams(params);
			if (error) return { content: [{ type: "text", text: error }], isError: true, details: { valid: false } };
			switch (params.action) {
				case "name": return handlers.name(toolCallId, params);
				case "overview": return handlers.overview(toolCallId, params, signal, onUpdate, ctx);
				case "read": return handlers.read(toolCallId, params, signal, onUpdate, ctx);
				case "search": return handlers.search(toolCallId, params, signal, onUpdate, ctx);
				case "recovery": return handlers.recovery(toolCallId, params, signal, onUpdate, ctx);
			}
		},
	});
}
