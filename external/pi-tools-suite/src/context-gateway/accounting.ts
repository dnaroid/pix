export type ContextGatewayPartCategory =
	| "userText"
	| "assistantProse"
	| "assistantThinking"
	| "assistantToolCallArguments"
	| "toolResultText"
	| "controlOrUnknownText";

export interface ContextGatewayPartCounter {
	parts: number;
	bytes: number;
}

export interface ContextGatewayAccountingScope {
	sessionId?: string;
	branchLeafId?: string;
	startTimestamp?: number;
	endTimestamp?: number;
	timestampSource?: string;
}

export interface ContextGatewayPartAccounting {
	version: 1;
	scope: ContextGatewayAccountingScope;
	categories: Record<ContextGatewayPartCategory, ContextGatewayPartCounter>;
	messageWrapperBytes: number;
	metadataDetailsBytes: number;
	unknownParts: number;
}

const CATEGORIES: ContextGatewayPartCategory[] = [
	"userText",
	"assistantProse",
	"assistantThinking",
	"assistantToolCallArguments",
	"toolResultText",
	"controlOrUnknownText",
];

function bytes(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function serializedBytes(value: unknown): number {
	try {
		const text = JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
		return text === undefined ? 0 : bytes(text);
	} catch {
		return 0;
	}
}

function emptyCategories(): Record<ContextGatewayPartCategory, ContextGatewayPartCounter> {
	return Object.fromEntries(CATEGORIES.map((category) => [category, { parts: 0, bytes: 0 }])) as Record<
		ContextGatewayPartCategory,
		ContextGatewayPartCounter
	>;
}

function addText(
	categories: ContextGatewayPartAccounting["categories"],
	category: ContextGatewayPartCategory,
	text: string,
): void {
	categories[category].parts += 1;
	categories[category].bytes += bytes(text);
}

export function accountContextGatewayParts(
	messages: readonly unknown[],
	scope: ContextGatewayAccountingScope = {},
): ContextGatewayPartAccounting {
	const categories = emptyCategories();
	let metadataDetailsBytes = 0;
	let messageWrapperBytes = 0;
	let unknownParts = 0;

	for (const rawMessage of messages) {
		if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) {
			unknownParts += 1;
			continue;
		}
		const message = rawMessage as Record<string, unknown>;
		const role = typeof message.role === "string" ? message.role : "unknown";
		metadataDetailsBytes += serializedBytes(message.details);
		messageWrapperBytes += serializedBytes({
			role: message.role,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			isError: message.isError,
			timestamp: message.timestamp,
		});

		if (typeof message.content === "string") {
			const category: ContextGatewayPartCategory = role === "user"
				? "userText"
				: role === "assistant"
					? "assistantProse"
					: role === "toolResult"
						? "toolResultText"
						: "controlOrUnknownText";
			addText(categories, category, message.content);
			continue;
		}

		if (!Array.isArray(message.content)) {
			if (message.content !== undefined) unknownParts += 1;
			continue;
		}

		for (const rawPart of message.content) {
			if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) {
				unknownParts += 1;
				continue;
			}
			const part = rawPart as Record<string, unknown>;
			if (part.type === "text" && typeof part.text === "string") {
				const category: ContextGatewayPartCategory = role === "user"
					? "userText"
					: role === "assistant"
						? "assistantProse"
						: role === "toolResult"
							? "toolResultText"
							: "controlOrUnknownText";
				addText(categories, category, part.text);
				continue;
			}
			if (role === "assistant" && part.type === "thinking" && typeof part.thinking === "string") {
				addText(categories, "assistantThinking", part.thinking);
				continue;
			}
			if (role === "assistant" && part.type === "toolCall") {
				categories.assistantToolCallArguments.parts += 1;
				categories.assistantToolCallArguments.bytes += serializedBytes(part.arguments);
				continue;
			}
			// Images and other structured parts are deliberately not reclassified as
			// prose. Count them as unknown until a dedicated non-text budget exists.
			unknownParts += 1;
		}
	}

	return {
		version: 1,
		scope: { ...scope },
		categories,
		messageWrapperBytes,
		metadataDetailsBytes,
		unknownParts,
	};
}
