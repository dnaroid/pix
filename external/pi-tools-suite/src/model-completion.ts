import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";

type RegisteredProviderConfig = {
	streamSimple?: (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => AssistantMessageEventStream;
};

export type ModelCompletionRegistry = {
	getRegisteredProviderConfig?(providerId: string): RegisteredProviderConfig | undefined;
};

/**
 * Complete through an extension provider's registered stream when available.
 * Pi 0.80.8+ no longer copies extension streams into pi-ai's global compat
 * registry, so falling back to compat is valid only for built-in APIs.
 */
export async function completeWithModelRegistry(
	modelRegistry: ModelCompletionRegistry | undefined,
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AssistantMessage> {
	const providerConfig = modelRegistry?.getRegisteredProviderConfig?.(model.provider);
	if (providerConfig?.streamSimple) return providerConfig.streamSimple(model, context, options).result();
	return completeSimple(model, context, options);
}
