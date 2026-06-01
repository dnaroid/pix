import { THINKING_LEVELS } from "./constants.js";
import type { ThinkingLevel } from "./types.js";

export function parseModelRef(value: string): { provider: string; modelId: string; thinkingLevel?: ThinkingLevel } {
	const [modelPart, thinkingPart] = value.split(":", 2);
	if (!modelPart) throw new Error("Model reference cannot be empty");

	const slashIndex = modelPart.indexOf("/");
	if (slashIndex <= 0 || slashIndex === modelPart.length - 1) {
		throw new Error("Model must use provider/model format");
	}

	let thinkingLevel: ThinkingLevel | undefined;
	if (thinkingPart) {
		if (!isThinkingLevel(thinkingPart)) {
			throw new Error(`Unknown thinking level: ${thinkingPart}`);
		}
		thinkingLevel = thinkingPart;
	}

	return {
		provider: modelPart.slice(0, slashIndex),
		modelId: modelPart.slice(slashIndex + 1),
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
	};
}

export function parseScopedModelRef(value: string): { provider: string; modelId: string; thinkingLevel?: ThinkingLevel } | undefined {
	const slashIndex = value.indexOf("/");
	if (slashIndex <= 0 || slashIndex === value.length - 1) return undefined;

	const provider = value.slice(0, slashIndex);
	let modelId = value.slice(slashIndex + 1);
	let thinkingLevel: ThinkingLevel | undefined;
	const colonIndex = modelId.lastIndexOf(":");
	if (colonIndex > 0) {
		const suffix = modelId.slice(colonIndex + 1);
		if (isThinkingLevel(suffix)) {
			modelId = modelId.slice(0, colonIndex);
			thinkingLevel = suffix;
		}
	}

	return {
		provider,
		modelId,
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
	};
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return THINKING_LEVELS.includes(value as ThinkingLevel);
}


export function stripProviderFromModelRef(value: string): string {
	const slashIndex = value.indexOf("/");
	return slashIndex >= 0 && slashIndex < value.length - 1 ? value.slice(slashIndex + 1) : value;
}

