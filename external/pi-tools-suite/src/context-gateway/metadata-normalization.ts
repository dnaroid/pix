export interface TruncationMetadataNormalization {
	details: unknown;
	changed: boolean;
	removedBytes: number;
}

type ToolResultLike = {
	toolName?: unknown;
	content?: unknown;
	details?: unknown;
};

const KNOWN_TRUNCATION_TOOLS = new Set([
	"read",
	"bash",
	"shell",
	"shell_command",
	"ast_grep",
]);

// This allowlist is an applicability/compatibility guard, not a provenance or
// authorization boundary. `tool_result` exposes a tool name but not a trusted
// owner identity, so a replacement extension can reuse one of these names. The
// transform is therefore deliberately limited to removing an exact duplicate
// of delivered text and preserves every other details field; callers must not
// infer built-in-tool capabilities, trust, lifetime, or access rights from the
// name/shape match alone.

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deliveredText(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const parts: string[] = [];
	for (const raw of content) {
		if (!isRecord(raw)) continue;
		if (raw.type === "text" && typeof raw.text === "string") parts.push(raw.text);
	}
	return parts.length > 0 ? parts.join("") : undefined;
}

type SdkTruncationShape = Record<string, unknown> & {
	content: string;
	truncated: true;
	truncatedBy: "lines" | "bytes";
};

function hasSdkTruncationShape(value: Record<string, unknown>): value is SdkTruncationShape {
	if (value.truncated !== true || typeof value.content !== "string" || value.content.length === 0) return false;
	if (value.truncatedBy !== "lines" && value.truncatedBy !== "bytes") return false;
	for (const key of ["totalLines", "totalBytes", "outputLines", "outputBytes", "maxLines", "maxBytes"] as const) {
		const item = value[key];
		if (typeof item !== "number" || !Number.isFinite(item) || item < 0) return false;
	}
	if (typeof value.lastLinePartial !== "boolean" || typeof value.firstLineExceedsLimit !== "boolean") return false;
	return true;
}

/**
 * Remove only the known redundant truncation payload copied into tool-result
 * metadata when that payload is also the prefix of the delivered text.
 *
 * This intentionally does not normalize arbitrary `details.truncation.content`
 * fields: custom tools may use a similarly named field for unrelated data.
 */
export function normalizeRedundantTruncationMetadata(event: ToolResultLike): TruncationMetadataNormalization {
	const toolName = typeof event.toolName === "string" ? event.toolName.trim().toLowerCase() : "";
	if (!KNOWN_TRUNCATION_TOOLS.has(toolName)) return { details: event.details, changed: false, removedBytes: 0 };
	if (!isRecord(event.details)) return { details: event.details, changed: false, removedBytes: 0 };
	const truncation = event.details.truncation;
	if (!isRecord(truncation) || !hasSdkTruncationShape(truncation)) {
		return { details: event.details, changed: false, removedBytes: 0 };
	}

	const text = deliveredText(event.content);
	if (text === undefined || !text.startsWith(truncation.content)) {
		return { details: event.details, changed: false, removedBytes: 0 };
	}

	const normalizedTruncation: Record<string, unknown> = { ...truncation };
	delete normalizedTruncation.content;
	return {
		details: { ...event.details, truncation: normalizedTruncation },
		changed: true,
		removedBytes: new TextEncoder().encode(truncation.content).byteLength,
	};
}
