import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

test("image-only queue compatibility text is consumed by the real SDK with its image intact", async () => {
	const scratch = fileURLToPath(new URL("../../.pi/artifacts/sdk-image-steering/", import.meta.url));
	await mkdir(scratch, { recursive: true });
	const cwd = await mkdtemp(join(scratch, "case-"));
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
	});
	await loader.reload();
	const model = { ...fauxProvider({ provider: "image-steering-contract" }).getModel(), input: ["text", "image"] as ("text" | "image")[] };
	let started!: () => void;
	const pending = new Promise<void>((resolve) => { started = resolve; });
	let finishFirst!: () => void;
	let requests = 0;
	const modelRuntime = {
		streamSimple: () => {
			const stream = createAssistantMessageEventStream();
			const finish = () => {
				const response = fauxAssistantMessage("Done");
				stream.push({ type: "done", reason: "stop", message: response });
				stream.end(response);
			};
			if (requests++ === 0) { finishFirst = finish; started(); }
			else queueMicrotask(finish);
			return stream;
		},
		getModels: () => [model], getModel: () => model, getProviders: () => [], getAvailableSnapshot: () => [model],
		hasConfiguredAuth: () => true, isUsingOAuth: () => false,
	} as any;
	const { session } = await createAgentSession({
		cwd, agentDir: cwd, settingsManager, resourceLoader: loader,
		sessionManager: SessionManager.create(cwd, join(cwd, "sessions")), model, modelRuntime, thinkingLevel: "off",
	});
	try {
		await session.bindExtensions({});
		const run = session.prompt("Work");
		await pending;
		const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
		await session.steer("(image message)", [image]);
		assert.deepEqual(session.getSteeringMessages(), ["(image message)"]);
		finishFirst();
		await run;
		assert.equal(requests, 2);
		assert.deepEqual(session.getSteeringMessages(), []);
		const delivered = session.messages.filter((message) => message.role === "user");
		assert.equal(delivered.length, 2);
		assert.deepEqual(delivered[1]?.content, [{ type: "text", text: "(image message)" }, image]);
	} finally {
		session.dispose();
		await rm(cwd, { recursive: true, force: true });
	}
});
