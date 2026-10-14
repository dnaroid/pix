import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { extractImageContents } from "../rendering/message-content.js";
import { isMessageEditRewindPosition } from "../session/message-edit-rewind.js";

export type EditedUserMessage = { text: string; displayText?: string; images: ImageContent[] };

/** Capture exact branch identity when loading the composer; no navigation yet. */
export function prepareUserMessageEdit(runtime: AgentSessionRuntime, entryId: string) {
	const manager = runtime.session.sessionManager;
	const target = manager.getBranch().find((entry) => entry.id === entryId);
	if (!target || target.type !== "message" || target.message.role !== "user") throw new Error("This message is no longer on the active branch.");
	if (manager.getLeafId() === target.id) throw new Error("This message has no response yet. Wait for the response before editing it.");
	const content = target.message.content;
	const images = extractImageContents(content);
	let text = typeof content === "string" ? content : content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
	// The editor creates its own removable image chips/markers.
	if (images.length) text = text.replace(/\[Image \d+\]/g, "").trimEnd();
	return { entryId: target.id, parentId: target.parentId, leaf: manager.getLeafId(), file: manager.getSessionFile(), text, images };
}
export type PreparedUserMessageEdit = ReturnType<typeof prepareUserMessageEdit>;

export async function commitUserMessageEdit(options: {
	runtime: AgentSessionRuntime;
	pending: PreparedUserMessageEdit;
	edit: EditedUserMessage;
	isCurrent: () => boolean;
	onRewound?: () => void;
	reserve: () => () => void;
	reloadHistory: () => void;
	resend: (edit: EditedUserMessage) => void;
}): Promise<boolean> {
	const session = options.runtime.session;
	const manager = session.sessionManager;
	const pending = options.pending;
	if (!options.isCurrent() || manager.getSessionFile() !== pending.file || manager.getLeafId() !== pending.leaf) throw new Error("The conversation changed while editing. Cancel and select the message again.");
	const release = options.reserve();
	try {
		let markedRewound = false;
		const markRewound = () => {
			if (!markedRewound) { markedRewound = true; options.onRewound?.(); }
		};
		let navigation;
		try {
			navigation = await session.navigateTree(pending.entryId);
		} finally {
			// A cancelled/rejected extension can still have moved the branch.
			if (manager.getSessionFile() !== pending.file || manager.getLeafId() !== pending.leaf) markRewound();
		}
		if (navigation.cancelled) return false;
		markRewound();
		if (!options.isCurrent() || manager.getSessionFile() !== pending.file || !isMessageEditRewindPosition(manager, pending.parentId)) throw new Error("The conversation changed before resending.");
		options.reloadHistory();
		// Transfer reservation to the normal scoped prompt runner synchronously.
		release();
		options.resend(options.edit);
		return true;
	} finally { release(); }
}
