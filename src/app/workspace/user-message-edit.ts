import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { extractImageContents } from "../rendering/message-content.js";

export type EditedUserMessage = { text: string; images: ImageContent[] };
export type MessageEditUi = {
	editor(title: string, prefill?: string): Promise<string | undefined>;
	select(title: string, options: string[]): Promise<string | undefined>;
};

export async function requestUserMessageEdit(ui: MessageEditUi, text: string, images: readonly ImageContent[]) {
	const markers: string[] = [];
	const editableText = text.replace(/^\[Pix attachment: (file:\/\/[^\]]+)\][ \t]*$/gm, (marker) => {
		markers.push(marker); return "";
	});
	const edited = await ui.editor("Edit message · Enter to continue · Esc to cancel", editableText);
	if (edited === undefined) return undefined;
	const keptImages = images.map((image, index) => ({ image, index }));
	let keptMarkers = markers.map((marker, index) => ({ marker, index }));
	for (;;) {
		const choices = [
			...(edited.trim() || keptImages.length || keptMarkers.length ? ["Save and resend"] : []),
			...keptImages.map(({ index }) => `Remove image ${index + 1}`),
			...keptMarkers.map(({ marker, index }) => `Remove file ${index + 1}: ${marker}`),
			"Cancel",
		];
		const choice = await ui.select("Resend here · Later messages leave the active branch · Files stay unchanged", choices);
		if (!choice || choice === "Cancel") return undefined;
		if (choice === "Save and resend") {
			return { text: [edited, ...keptMarkers.map(({ marker }) => marker)].filter(Boolean).join("\n\n"), images: keptImages.map(({ image }) => image) };
		}
		const imageIndex = keptImages.findIndex(({ index }) => choice === `Remove image ${index + 1}`);
		if (imageIndex >= 0) keptImages.splice(imageIndex, 1);
		keptMarkers = keptMarkers.filter(({ marker, index }) => choice !== `Remove file ${index + 1}: ${marker}`);
	}
}

export async function editUserMessageInSession(options: {
	runtime: AgentSessionRuntime;
	entryId: string;
	isCurrent: () => boolean;
	ui: MessageEditUi;
	reserve: () => () => void;
	reloadHistory: () => void;
	resend: (edit: EditedUserMessage) => void;
}) {
	const session = options.runtime.session;
	const manager = session.sessionManager;
	const leaf = manager.getLeafId();
	const file = manager.getSessionFile();
	const target = manager.getBranch().find((entry) => entry.id === options.entryId);
	if (!target || target.type !== "message" || target.message.role !== "user") throw new Error("This message is no longer on the active branch.");
	if (leaf === target.id) throw new Error("This message has no response yet. Wait for the response before editing it.");
	const content = target.message.content;
	const text = typeof content === "string" ? content : content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
	const edit = await requestUserMessageEdit(options.ui, text, extractImageContents(content));
	if (!edit) return;
	if (!options.isCurrent() || manager.getSessionFile() !== file || manager.getLeafId() !== leaf) throw new Error("The conversation changed while editing.");
	const release = options.reserve();
	try {
		const navigation = await session.navigateTree(target.id);
		if (navigation.cancelled) return;
		if (!options.isCurrent() || manager.getSessionFile() !== file || manager.getLeafId() !== target.parentId) throw new Error("The conversation changed before resending.");
		options.reloadHistory();
		// Transfer the reservation to the normal scoped prompt runner synchronously.
		release();
		options.resend(edit);
	} finally { release(); }
}
