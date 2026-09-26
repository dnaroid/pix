import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { normalizeRedundantTruncationMetadata } from "../context-gateway/metadata-normalization.js";

/**
 * Optional non-store optimization for SDK tool results.
 *
 * The module removes only truncation metadata text that is proven to duplicate
 * the already-delivered visible text. It is enabled by default because the
 * transformation preserves visible content and only removes redundant metadata.
 */
export default function truncationMetadataNormalizer(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event) => {
		const normalized = normalizeRedundantTruncationMetadata(event);
		return normalized.changed ? { details: normalized.details } : undefined;
	});
}
