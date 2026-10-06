import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type SessionNameParams = {
	name?: string;
};

function formatCurrentName(name: string | undefined): string {
	return name ? `Current session name: ${name}` : "No session name is set.";
}

export function createSessionNameHandler(pi: ExtensionAPI) {
	return async (_toolCallId: string, params: SessionNameParams) => {
		const nextName = params.name?.trim();

		if (!nextName) {
			return {
				content: [{ type: "text" as const, text: formatCurrentName(pi.getSessionName()) }],
				details: { changed: false, sessionName: pi.getSessionName() ?? null },
			};
		}

		pi.setSessionName(nextName);
		return {
			content: [{ type: "text" as const, text: `Session name set: ${nextName}` }],
			details: { changed: true, sessionName: nextName },
		};
	};
}
