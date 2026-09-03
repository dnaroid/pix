import { createInterface } from "node:readline";

const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const respond = (command, data = {}) => output({ type: "response", id: command.id, success: true, data });

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	const command = JSON.parse(line);
	switch (command.type) {
		case "get_state":
			respond(command, {
				sessionId: "fake-pi-session",
				sessionFile: "/tmp/fake-pi-session.jsonl",
				thinkingLevel: "off",
				isStreaming: false,
			});
			break;
		case "get_available_models":
			respond(command, { models: [] });
			break;
		case "get_available_thinking_levels":
			respond(command, { levels: ["off"] });
			break;
		case "prompt":
			respond(command);
			setImmediate(() => {
				output({ type: "agent_start" });
				output({
					type: "message_update",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, total: 0 },
					},
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "fake reply" },
				});
				output({
					type: "agent_end",
					messages: [{ role: "assistant", content: [], stopReason: "stop" }],
					willRetry: false,
				});
				output({ type: "agent_settled" });
			});
			break;
		case "abort":
			respond(command);
			break;
		default:
			output({ type: "response", id: command.id, success: false, error: `unsupported ${command.type}` });
	}
});
