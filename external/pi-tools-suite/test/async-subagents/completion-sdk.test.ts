import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import registerSubagents from "../../src/async-subagents/index.js";
import { createRunDir } from "../../src/async-subagents/lib.js";

const scratch = fileURLToPath(new URL("../../../../.pi/artifacts/completion-sdk-tests/", import.meta.url));

for (const mode of ["read", "result", "partial", "transformed", "late-failure"] as const) {
	test(`real SDK settlement: ${mode}`, async () => {
		fs.mkdirSync(scratch, { recursive: true });
		const cwd = fs.mkdtempSync(path.join(scratch, "case-"));
		const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
		const runDir = createRunDir(cwd, "completion");
		const agentDir = path.join(runDir, "child");
		fs.mkdirSync(agentDir);
		for (const [name, text] of Object.entries({
			"prompt.md": "audit", pid: String(process.pid), parent_session: sessionManager.getSessionFile()!,
			"result.md": "Audit complete\nNo changes required\n",
		})) fs.writeFileSync(path.join(agentDir, name), text);
		const loader = new DefaultResourceLoader({
			cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
			extensionFactories: [registerSubagents, (pi) => {
				pi.on("tool_result", (event) => {
					if (mode === "transformed" && event.toolName === "read")
						return { content: [{ type: "text", text: "[result truncated by later extension]" }] };
				});
			}],
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		const model = fauxProvider({ provider: "completion-contract" }).getModel();
		const args: Record<string, string | number> = mode === "result" ? { action: "result", runDir, agentId: "child" }
			: { path: path.join(agentDir, "result.md"), ...(mode === "partial" ? { limit: 1 } : {}) };
		const responses = mode === "late-failure" ? [fauxAssistantMessage("Initial final answer"), fauxAssistantMessage("New failure report")]
			: [fauxAssistantMessage(fauxToolCall(mode === "result" ? "subagents" : "read", args, { id: "collect" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Final answer"), fauxAssistantMessage("Completion follow-up")];
		let requests = 0;
		const modelRuntime = {
			streamSimple: () => {
				requests++;
				// The child was adopted while running. Its final receipt appears
				// while the real parent SDK run is busy, before result collection.
				fs.writeFileSync(path.join(agentDir, "exit_code"), mode === "late-failure" ? "1" : "0");
				const response = responses.shift();
				if (!response) throw new Error("Unexpected duplicate provider request");
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: response.stopReason as "stop" | "toolUse", message: response });
					stream.end(response);
				});
				return stream;
			},
			getModels: () => [model], getModel: () => model, getProviders: () => [], getAvailableSnapshot: () => [model],
			hasConfiguredAuth: () => true, isUsingOAuth: () => false,
		} as any;
		const { session } = await createAgentSession({
			cwd, agentDir: cwd, resourceLoader: loader, settingsManager, sessionManager, model, modelRuntime, thinkingLevel: "off",
		});
		try {
			await session.bindExtensions({});
			await session.prompt("Collect the audit if necessary and report once");
			expect(requests).toBe(mode === "partial" || mode === "transformed" ? 3 : 2);
			const completions = session.messages.filter((message) => message.role === "custom" && message.customType === "async-subagents-agent-completion");
			expect(completions).toHaveLength(mode === "read" || mode === "result" ? 0 : 1);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
			session.dispose();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
}
