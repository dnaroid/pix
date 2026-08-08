import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ModelsApiStreamOptions,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export type ModelCompletionRegistry = Partial<Pick<ModelRegistry, "complete" | "getRegisteredProviderConfig">>;

/**
 * Complete through Pi's model runtime when available so custom providers and
 * resolved auth endpoints are preserved. The older stream/compat branches are
 * retained for narrow test doubles that do not expose ModelRegistry.complete().
 */
export async function completeWithModelRegistry(
	modelRegistry: ModelCompletionRegistry | undefined,
	model: Model<Api>,
	context: Context,
	options?: ModelsApiStreamOptions<Api>,
): Promise<AssistantMessage> {
	if (modelRegistry?.complete) return modelRegistry.complete(model, context, options);

	const providerConfig = modelRegistry?.getRegisteredProviderConfig?.(model.provider);
	const simpleOptions = options as SimpleStreamOptions | undefined;
	if (providerConfig?.streamSimple) return providerConfig.streamSimple(model, context, simpleOptions).result();
	return completeSimple(model, context, simpleOptions);
}
