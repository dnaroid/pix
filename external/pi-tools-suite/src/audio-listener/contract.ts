import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

// Phase-one contract only: no tool/role is exposed until the native feasibility gate passes.
export const LISTENER_PROTOCOL_VERSION = 1;
export const DEFAULT_CAPTURE_SECONDS = 30;
export const MAX_AUDIO_SECONDS = 120;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;

const language = Type.String({ minLength: 2, maxLength: 64 });
const jobId = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_-]+$" });
const seconds = Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });

const fileSource = Type.Object({
	kind: Type.Literal("file"),
	path: Type.String({ minLength: 1, maxLength: 4096 }),
	startSeconds: Type.Optional(seconds),
	endSeconds: Type.Optional(seconds),
	// Without an index the host must reject ambiguous multi-track input, not guess.
	audioTrack: Type.Optional(Type.Integer({ minimum: 0, maximum: 255 })),
}, { additionalProperties: false });

const captureSource = Type.Object({
	kind: Type.Union([Type.Literal("system"), Type.Literal("microphone")]),
	durationSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_AUDIO_SECONDS })),
}, { additionalProperties: false });

// Consent, credentials, owner/session IDs and model URLs deliberately are not agent inputs.
export const listenerRequestSchema = Type.Union([
	Type.Object({ operation: Type.Literal("capabilities") }, { additionalProperties: false }),
	Type.Object({
		operation: Type.Literal("start"),
		language,
		source: Type.Union([fileSource, captureSource]),
	}, { additionalProperties: false }),
	Type.Object({
		operation: Type.Union([Type.Literal("status"), Type.Literal("stop"), Type.Literal("cancel")]),
		jobId,
	}, { additionalProperties: false }),
]);

export type ListenerRequest = Static<typeof listenerRequestSchema>;
export type ListenerStart = Extract<ListenerRequest, { operation: "start" }>;
export type ListenerEngine = "deepgram" | "apple" | "vosk";
export type ListenerErrorCode =
	| "invalid_request" | "language_required" | "unsupported_host" | "busy"
	| "not_found" | "consent_required" | "permission_denied" | "cancelled" | "timeout"
	| "invalid_media" | "ambiguous_track" | "limit_exceeded" | "capture_failed"
	| "deepgram_failed" | "system_unavailable" | "model_unavailable"
	| "download_failed" | "checksum_failed" | "unsafe_archive" | "decode_failed" | "stt_failed";

export class ListenerError extends Error {
	constructor(public readonly code: ListenerErrorCode, message: string) {
		super(message);
		this.name = "ListenerError";
	}
}

export type ListenerJobState =
	| "awaiting_consent" | "preparing" | "downloading" | "recording"
	| "stopping" | "decoding" | "transcribing" | "completed" | "cancelled" | "failed";

export interface ListenerSegment {
	/** Seconds relative to the original file (or beginning of this capture). */
	start: number;
	end: number;
	text: string;
	/** Only supplied when returned by the engine; never compared across engines. */
	confidence?: number;
	speaker?: string;
}

export interface ListenerResult {
	jobId: string;
	source: ListenerStart["source"];
	engine: ListenerEngine;
	model: string;
	language: string;
	segments: ListenerSegment[];
	warnings: string[];
	/** Host-generated paths, never arbitrary destinations supplied by the agent. */
	artifacts: string[];
}

export function parseListenerRequest(value: unknown): ListenerRequest {
	if (!Check(listenerRequestSchema, value)) {
		throw new ListenerError("invalid_request", "Invalid listener operation or parameters.");
	}
	if (value.operation !== "start") return value;
	const normalizedLanguage = normalizeListenerLanguage(value.language);
	if (value.source.kind !== "file") {
		return {
			...value,
			language: normalizedLanguage,
			source: { ...value.source, durationSeconds: value.source.durationSeconds ?? DEFAULT_CAPTURE_SECONDS },
		};
	}
	const { source } = value;
	// A path is only a request: the native host must authorize/read a regular file and
	// enforce byte/duration/codec limits after opening it. No URL decoding or shell expansion.
	if (!source.path.startsWith("/") || source.path.includes("\0") || source.path.trim() === "") {
		throw new ListenerError("invalid_request", "A local absolute file path is required.");
	}
	const start = source.startSeconds ?? 0;
	if (!Number.isFinite(start) || (source.endSeconds !== undefined && (
		!Number.isFinite(source.endSeconds) || source.endSeconds <= start
		|| source.endSeconds - start > MAX_AUDIO_SECONDS
	))) {
		throw new ListenerError("invalid_request", "The audio range must be positive and at most 120 seconds.");
	}
	return { ...value, language: normalizedLanguage, source: { ...source, startSeconds: start } };
}

export function normalizeListenerLanguage(value: string): string {
	const base = value.trim().split("-")[0].toLowerCase();
	if (!base || ["auto", "und", "unknown", "mul", "zxx"].includes(base)) {
		throw new ListenerError("language_required", "Choose the spoken language before starting listener.");
	}
	try {
		const [canonical] = Intl.getCanonicalLocales(value.trim());
		if (!canonical) throw new Error("empty");
		return canonical;
	} catch {
		throw new ListenerError("invalid_request", "Use an explicit BCP-47 language tag.");
	}
}
