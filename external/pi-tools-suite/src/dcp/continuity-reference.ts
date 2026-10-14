import { createHash } from "node:crypto";
import type { DcpConfig } from "./config.js";
import { toolRecordContinuity } from "./protected-continuity.js";
import { createInputFingerprint, type CompressionContinuitySource, type CompressionProtectedFragment, type DcpState, type ToolRecord } from "./state.js";

export const continuityHash = (text: string): string => createHash("sha256").update(text).digest("hex");

// Bind inputs, outcome and structured evidence as well as output bytes. A same-ID
// result from a different branch must not satisfy a recovery address.
export function continuityRecordIdentity(record: ToolRecord): string {
	return createInputFingerprint("continuity", {
		toolName: record.toolName, inputArgs: record.inputArgs, outputText: record.outputText,
		isError: record.isError, outputDetails: record.outputDetails ?? null,
	});
}

function recordFragment(record: ToolRecord, config: DcpConfig): CompressionProtectedFragment | undefined {
	const decision = toolRecordContinuity(record, config);
	if (!decision.text) return undefined;
	return { kind: "tool", origin: `tool:${record.toolCallId}`, hash: continuityHash(decision.text), text: decision.text,
		representation: decision.mode === "receipt" || decision.mode === "digest" ? decision.mode : "exact",
		sourceHash: decision.sourceHash, sourceBytes: decision.sourceBytes, policyVersion: 3, minimumText: decision.minimumText };
}

/** Returns undefined only for a proven observation that needs no action receipt. */
export function resolveContinuitySource(source: CompressionContinuitySource, state: DcpState, config: DcpConfig): CompressionProtectedFragment | undefined {
	if (source.kind === "raw") {
		const record = state.toolCalls.get(source.toolCallId);
		if (record?.outputText !== undefined && continuityRecordIdentity(record) === source.identityHash) return recordFragment(record, config);
	} else {
		const fragment = state.compressionBlocks.find((block) => block.id === source.blockId)?.protectedFragments?.find(
			(item) => item.origin === source.origin && item.hash === source.fragmentHash && continuityHash(item.text) === source.fragmentHash,
		);
		// References always point at leaves, not other references: no recursive
		// growth, cycles or rebinding through mutable roll-up intermediates.
		if (fragment && fragment.representation !== "reference" && fragment.kind === "tool") return fragment;
	}
	throw new Error("DCP continuity source unavailable or changed; outcome UNKNOWN. Recover the original session before relying on or repeating any covered action.");
}

export function expandContinuityReference(fragment: CompressionProtectedFragment, state: DcpState, config: DcpConfig): CompressionProtectedFragment[] {
	if (fragment.representation !== "reference") return [fragment];
	if (!fragment.continuitySources?.length) throw new Error("DCP continuity reference has no recovery addresses");
	return fragment.continuitySources.flatMap((source) => {
		const resolved = resolveContinuitySource(source, state, config);
		return resolved ? [resolved] : [];
	});
}

export function continuitySourceFor(fragment: CompressionProtectedFragment, state: DcpState, config: DcpConfig): CompressionContinuitySource | undefined {
	if (fragment.kind !== "tool" || fragment.policyVersion !== 3 || !["receipt", "digest"].includes(fragment.representation ?? "")) return undefined;
	const id = /^tool:(.+)$/.exec(fragment.origin)?.[1];
	const record = id ? state.toolCalls.get(id) : undefined;
	if (record?.outputText !== undefined && fragment.sourceHash === continuityHash(record.outputText)) {
		const current = recordFragment(record, config);
		if (current && current.representation !== "exact" && (fragment.text === current.text || fragment.text === current.minimumText)) {
			return { kind: "raw", toolCallId: record.toolCallId, identityHash: continuityRecordIdentity(record) };
		}
	}
	for (const block of state.compressionBlocks) {
		if (block.protectedFragments?.some((item) => item.origin === fragment.origin && item.hash === fragment.hash && continuityHash(item.text) === fragment.hash && item.representation !== "reference")) {
			return { kind: "block", blockId: block.id, origin: fragment.origin, fragmentHash: fragment.hash };
		}
	}
	return undefined;
}

export function makeContinuityReference(sources: CompressionContinuitySource[], blockId: number): CompressionProtectedFragment {
	const unique = [...new Map(sources.map((source) => [JSON.stringify(source), source])).values()];
	const text = `### Session continuity reference\n${unique.length} historical action records remain in the original session (not a second archive).\nRecover: session action=read entry_id="dcp:b${blockId}"; follow nextCursor.\nOutcomes may be UNKNOWN: do not repeat covered actions or treat historical tests as current verification before recovering their inputs, outcomes, paths and operation IDs. Explicit pins remain inline.`;
	return { kind: "tool", origin: "session:continuity", hash: continuityHash(text), text, representation: "reference", policyVersion: 4, continuitySources: unique };
}

export function validContinuityReference(value: Record<string, unknown>, blockId: number): boolean {
	if (value.representation !== "reference") return value.continuitySources === undefined;
	if (value.kind !== "tool" || value.policyVersion !== 4 || value.origin !== "session:continuity" || !Array.isArray(value.continuitySources) || !value.continuitySources.length) return false;
	const valid = value.continuitySources.every((source: unknown) => {
		if (!source || typeof source !== "object") return false;
		const s = source as Record<string, unknown>;
		return s.kind === "raw"
			? typeof s.toolCallId === "string" && s.toolCallId.length > 0 && typeof s.identityHash === "string" && /^continuity::sha256:[a-f0-9]{64}$/.test(s.identityHash)
			: s.kind === "block" && Number.isSafeInteger(s.blockId) && (s.blockId as number) > 0 && (s.blockId as number) < blockId && typeof s.origin === "string" && s.origin.length > 0 && typeof s.fragmentHash === "string" && /^[a-f0-9]{64}$/.test(s.fragmentHash);
	});
	if (!valid) return false;
	const canonical = makeContinuityReference(value.continuitySources as CompressionContinuitySource[], blockId);
	return canonical.text === value.text && canonical.hash === value.hash;
}
