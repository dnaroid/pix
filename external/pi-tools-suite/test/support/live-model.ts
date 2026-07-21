import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export type LiveModelContext = {
	model: NonNullable<ReturnType<ModelRegistry["find"]>>;
	modelRegistry: ModelRegistry;
};

export function resolveLiveModelRef(...envNames: string[]): string {
	for (const name of envNames) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return process.env.PI_TOOLS_SUITE_E2E_MODEL?.trim() || "zai/glm-5-turbo";
}

export async function createLiveModelContext(modelRef: string): Promise<LiveModelContext> {
	const separator = modelRef.indexOf("/");
	if (separator <= 0 || separator === modelRef.length - 1) {
		throw new Error(`Expected model ref in provider/model form, got ${modelRef}`);
	}

	const provider = modelRef.slice(0, separator);
	const modelId = modelRef.slice(separator + 1);
	// Keep this runtime import behind the live-eval gate. Bun on Windows validates
	// named ESM exports even for skipped tests, while the installed SDK may be
	// exposed through CommonJS interop there.
	const imported = await import("@earendil-works/pi-coding-agent");
	const fallback = (imported as unknown as { default?: typeof imported }).default;
	const ModelRuntime = imported.ModelRuntime ?? fallback?.ModelRuntime;
	const ModelRegistryRuntime = imported.ModelRegistry ?? fallback?.ModelRegistry;
	if (!ModelRuntime || !ModelRegistryRuntime) {
		throw new Error("Prompt eval SDK does not expose ModelRuntime and ModelRegistry");
	}
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: true });
	const modelRegistry = new ModelRegistryRuntime(modelRuntime);
	const model = modelRegistry.find(provider, modelId);
	if (!model) throw new Error(`Prompt eval model is not registered: ${modelRef}`);

	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false) throw new Error(`Prompt eval model auth is unavailable for ${modelRef}: ${auth.error}`);
	return { model, modelRegistry };
}
