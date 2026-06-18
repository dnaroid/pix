import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { SESSION_NAME_TOOL_DESCRIPTION } from "../tool-descriptions.js";

type SessionNameParams = {
	name?: string;
};

function formatCurrentName(name: string | undefined): string {
	return name ? `Current session name: ${name}` : "No session name is set.";
}

export default function sessionName(pi: ExtensionAPI): void {
	pi.registerTool({
		...SESSION_NAME_TOOL_DESCRIPTION,
		parameters: Type.Object({
			name: Type.Optional(Type.String({ description: "New session name to set. Omit to read the current session name." })),
		}),
		async execute(_toolCallId: string, params: SessionNameParams) {
			const nextName = params.name?.trim();

			if (!nextName) {
				return {
					content: [{ type: "text", text: formatCurrentName(pi.getSessionName()) }],
					details: { changed: false, sessionName: pi.getSessionName() ?? null },
				};
			}

			pi.setSessionName(nextName);
			return {
				content: [{ type: "text", text: `Session name set: ${nextName}` }],
				details: { changed: true, sessionName: nextName },
			};
		},
	});
}
