import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { registerPromptSanitizer } from "../src/prompt-sanitizer.js";

for (const opaque of [false, true]) test(`installed SDK omits docs on initial and rebuilt requests (opaque=${opaque})`, async () => {
	const root = mkdtempSync(join(tmpdir(), "prompt-sanitizer-sdk-"));
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
		let sawUpstreamDocs = false;
		const loader = new DefaultResourceLoader({
			cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
			extensionFactories: [(pi) => {
				pi.registerTool({ name: "rebuild_probe", label: "Probe", description: "Test tool", parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) });
				pi.on("before_agent_start", (event) => {
					sawUpstreamDocs = event.systemPrompt.includes("Pi documentation");
					if (opaque) return { systemPrompt: `${event.systemPrompt}\n<available_skills>preserve skills</available_skills>` };
					event.systemPromptOptions.sections.extra = "preserve custom section";
				});
				registerPromptSanitizer(pi);
			}],
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		const model = fauxProvider({ provider: "prompt-sanitizer" }).getModel();
		const contexts: any[] = [];
		const responses = [fauxAssistantMessage(fauxToolCall("rebuild_probe", {}, { id: "probe" }), { stopReason: "toolUse" }), fauxAssistantMessage("done"), fauxAssistantMessage("next turn")];
		const modelRuntime = {
			streamSimple: (_model: unknown, context: unknown) => {
				contexts.push(structuredClone(context));
				const response = responses.shift()!;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => { stream.push({ type: "done", reason: response.stopReason as "stop" | "toolUse", message: response }); stream.end(response); });
				return stream;
			},
			getModels: () => [model], getModel: () => model, getProviders: () => [],
			getAvailableSnapshot: () => [model], hasConfiguredAuth: () => true, isUsingOAuth: () => false,
		} as any;
		({ session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager,
			sessionManager: SessionManager.inMemory(root), model, modelRuntime, thinkingLevel: "off" }));
		await session.bindExtensions({});
		await session.prompt("run probe");
		await session.prompt("next turn");
		expect(sawUpstreamDocs).toBe(true); // Regression fixture uses actual SDK boilerplate.
		expect(contexts).toHaveLength(3);
		for (const context of contexts) {
			const systems = context.messages.filter((message: any) => message.role === "system");
			const text = JSON.stringify(systems);
			expect(text).not.toContain("Pi documentation");
			expect(text).not.toContain("Always read pi .md");
			expect(text).toContain(opaque ? "preserve skills" : "preserve custom section");
			expect(systems.flatMap((message: any) => message.toolsAdded ?? []).some((tool: any) => tool.name === "rebuild_probe")).toBe(true);
		}
	} finally {
		session?.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});
