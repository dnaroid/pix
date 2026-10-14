import { createHash } from "node:crypto";
import type { DcpConfig } from "./config.js";
import { DEFAULT_DCP_CONFIG } from "./defaults.js";
import type { CompressionProtectedFragment, DcpState } from "./state.js";
import { continuitySourceFor, expandContinuityReference, makeContinuityReference } from "./continuity-reference.js";

/** Drop optional evidence, never action identity, outcomes, pins or legacy facts. */
export function budgetProtectedToolFragments(
	fragments: CompressionProtectedFragment[],
	state: DcpState,
	config: DcpConfig,
): CompressionProtectedFragment[] {
	// Prepared fragments can already contain a capsule. Rebind its visible
	// recovery address to the block being created, and never stack capsules.
	const hadReference = fragments.some((fragment) => fragment.representation === "reference");
	const previousSources = fragments.flatMap((fragment) => fragment.continuitySources ?? []);
	fragments = fragments.flatMap((fragment) => expandContinuityReference(fragment, state, config));
	const configured = config.compress.maxProtectedToolContinuityBytes;
	const maxBytes = typeof configured === "number" && Number.isFinite(configured) && configured > 0
		? Math.max(1_024, Math.floor(configured))
		: DEFAULT_DCP_CONFIG.compress.maxProtectedToolContinuityBytes;
	const size = (fragment: CompressionProtectedFragment) => fragment.kind === "tool" ? Buffer.byteLength(fragment.text, "utf8") : 0;
	if (!hadReference && fragments.reduce((sum, fragment) => sum + size(fragment), 0) <= maxBytes) return fragments;
	const result = fragments.map((fragment) => {
		if (fragment.kind !== "tool" || fragment.policyVersion !== 3 || !fragment.minimumText ||
			!['receipt', 'digest'].includes(fragment.representation ?? '') ||
			Buffer.byteLength(fragment.minimumText, "utf8") >= size(fragment)) return fragment;
		return { ...fragment, text: fragment.minimumText, hash: createHash("sha256").update(fragment.minimumText).digest("hex") };
	});
	if (!hadReference && result.reduce((sum, fragment) => sum + size(fragment), 0) <= maxBytes) return result;
	const sources = [...previousSources];
	const inline = fragments.filter((fragment) => {
		const source = continuitySourceFor(fragment, state, config);
		if (!source) return true;
		sources.push(source);
		return false;
	});
	// Pins and unproven legacy facts never become references. All addressable
	// action facts remain recoverable from raw session/journal leaf records.
	const referenced = sources.length ? [...inline, makeContinuityReference(sources, state.nextBlockId)] : result;
	const bytes = referenced.reduce((sum, fragment) => sum + size(fragment), 0);
	if (bytes > maxBytes) {
		throw new Error(`Protected tool continuity safety floor requires ${bytes} bytes, above the ${maxBytes}-byte block budget; select a smaller range or release explicit pins. Action facts cannot be discarded safely.`);
	}
	return referenced;
}
