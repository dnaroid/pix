import { once } from "node:events";
import { createInterface } from "node:readline";

// Same scale as the failing image-heavy session, without private user content.
const image = "aGVsbG8=".repeat(128 * 1024);
const messages = Array.from({ length: 74 }, (_, index) => ({
	role: "user",
	content: [
		{ type: "text", text: `message ${index}: Привет 😀\u2028\u2029` },
		{ type: "image", data: image, mimeType: "image/png" },
	],
	timestamp: index,
}));

async function output(value) {
	const bytes = Buffer.from(JSON.stringify(value) + "\n");
	for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
		if (!process.stdout.write(bytes.subarray(offset, offset + 64 * 1024))) await once(process.stdout, "drain");
	}
}

// Serialize writes so concurrent requests cannot interleave JSONL records.
let outputQueue = output({ type: "extension_ui_request", id: "startup", method: "notify", message: "ready", notifyType: "info" });
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	const command = JSON.parse(line);
	outputQueue = outputQueue.then(async () => {
		if (command.type === "abort") {
			// Exit with an unfinished JSONL record and an outstanding request.
			process.stdout.write('{"type":"response","data":"partial', () => process.exit(2));
			return;
		}
		let data;
		if (command.type === "get_messages") {
			data = { messages };
		} else if (command.type === "get_entries") {
			data = {
				entries: messages.map((message, index) => ({ type: "message", id: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null, message })),
				leafId: "entry-73",
			};
		} else {
			data = { sessionId: "large-fixture", isStreaming: false, thinkingLevel: "off" };
		}
		await output({ type: "response", id: command.id, success: true, data });
	}).catch((error) => { console.error(error); process.exit(1); });
});
