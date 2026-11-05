import { describe, expect, test } from "bun:test";
import { parseListenerRequest, ListenerError } from "../src/audio-listener/contract.js";
import { chooseListenerEngine, canFallbackToVosk, type ListenerCapabilities } from "../src/audio-listener/engine-policy.js";

const start = { operation: "start", language: "ru", source: { kind: "system" } };
const capabilities: ListenerCapabilities = {
	deepgramConfigured: false,
	system: { language: "ru", available: true, onDevice: true, authorization: "authorized" },
	voskLanguages: ["ru", "en"],
};
const options = { appleRemoteConsent: false, cancelled: false };

describe("listener phase-one request contract", () => {
	test("normalizes explicit language and default bounded capture without mutating input", () => {
		expect(parseListenerRequest({ ...start, language: "EN-us" })).toEqual({
			...start, language: "en-US", source: { kind: "system", durationSeconds: 30 },
		});
		expect(start.source).toEqual({ kind: "system" });
	});

	test.each([0, -1, 121, 1.5, Infinity, NaN, "30"])("rejects capture duration %s", (durationSeconds) => {
		for (const kind of ["system", "microphone"]) {
			expect(() => parseListenerRequest({ ...start, source: { kind, durationSeconds } })).toThrow(ListenerError);
		}
	});

	test.each(["system", "microphone"])("accepts only one bounded %s source without mutating input", (kind) => {
		const request = { ...start, source: { kind } };
		expect(parseListenerRequest(request)).toEqual({ ...start, source: { kind, durationSeconds: 30 } });
		expect(request.source).toEqual({ kind });
		for (const durationSeconds of [1, 30, 120]) {
			const bounded = { ...start, source: { kind, durationSeconds } };
			expect(parseListenerRequest(bounded)).toEqual(bounded);
		}
	});

	test.each(["", " ", "auto", "und", "und-Latn", "mul", "zxx", "unknown", "not a locale"])("does not guess language %s", (language) => {
		expect(() => parseListenerRequest({ ...start, language })).toThrow(ListenerError);
	});

	test.each([
		{ consent: true }, { appleRemoteConsent: true }, { ownerSessionId: "other" },
		{ apiKey: "secret" }, { modelUrl: "https://example.com/model.zip" }, { outputPath: "/tmp/out" },
	])("rejects agent-controlled privileged fields %j", (extra) => {
		expect(() => parseListenerRequest({ ...start, ...extra })).toThrow(ListenerError);
	});

	test.each([
		{ kind: "mixed" }, { kind: "system", application: "game" },
		{ kind: ["system", "microphone"] },
		{ kind: "system", microphone: true }, { kind: "microphone", system: true },
		{ kind: "microphone", consent: true }, { kind: "microphone", video: true },
		{ kind: "microphone", path: "/tmp/audio.wav" },
		{ kind: "microphone", bufferSeconds: 10 },
		{ kind: "system", video: true }, { kind: "system", bufferSeconds: 10 },
		{ kind: "file", path: "https://example.com/audio.wav" }, { kind: "file", path: "relative.wav" },
		{ kind: "file", path: "/tmp/audio\0.wav" },
		{ kind: "file", path: "/tmp/audio.wav", startSeconds: 5, endSeconds: 5 },
		{ kind: "file", path: "/tmp/audio.wav", startSeconds: 2, endSeconds: 123 },
		{ kind: "file", path: "/tmp/audio.wav", audioTrack: -1 },
	])("rejects unsupported or unsafe source %j", (source) => {
		expect(() => parseListenerRequest({ ...start, source })).toThrow(ListenerError);
	});

	test("rejects multiple sources in one job", () => {
		const source = [{ kind: "system" }, { kind: "microphone" }];
		expect(() => parseListenerRequest({ ...start, source })).toThrow(ListenerError);
	});

	test("preserves original file offsets and explicitly selected track", () => {
		const source = { kind: "file", path: "/tmp/media.mov", startSeconds: 700, endSeconds: 820, audioTrack: 1 };
		expect(parseListenerRequest({ ...start, source })).toEqual({ ...start, source });
	});

	test("allows lifecycle operations but not a start payload on status", () => {
		for (const operation of ["status", "stop", "cancel"]) {
			expect(parseListenerRequest({ operation, jobId: "job-123" })).toEqual({ operation, jobId: "job-123" });
		}
		expect(parseListenerRequest({ operation: "capabilities" })).toEqual({ operation: "capabilities" });
		expect(() => parseListenerRequest({ ...start, operation: "status", jobId: "job-123" })).toThrow(ListenerError);
		expect(() => parseListenerRequest({ operation: "cancel", jobId: "../other" })).toThrow(ListenerError);
	});
});

describe("listener engine policy", () => {
	test("configured Deepgram always wins, without exposing its key", () => {
		expect(chooseListenerEngine("ru", { ...capabilities, deepgramConfigured: true }, options).engine).toBe("deepgram");
	});
	test("prefers local system speech, requesting authorization if needed", () => {
		expect(chooseListenerEngine("ru", capabilities, options)).toMatchObject({ engine: "apple", mode: "local" });
		const caps = { ...capabilities, system: { ...capabilities.system, authorization: "not_determined" as const } };
		expect(chooseListenerEngine("ru", caps, options).needsSpeechAuthorization).toBe(true);
	});
	test("remote Apple requires host consent; otherwise local Vosk", () => {
		const caps = { ...capabilities, system: { ...capabilities.system, onDevice: false } };
		expect(chooseListenerEngine("ru", caps, options)).toMatchObject({ engine: "vosk", reason: "apple_remote_declined" });
		expect(chooseListenerEngine("ru", caps, { ...options, appleRemoteConsent: true })).toMatchObject({ engine: "apple", mode: "cloud" });
	});
	test.each(["denied", "restricted"] as const)("authorization %s falls back locally", (authorization) => {
		expect(chooseListenerEngine("ru", { ...capabilities, system: { ...capabilities.system, authorization } }, options).engine).toBe("vosk");
	});
	test("unavailable or wrong-language system probe does not get reused", () => {
		for (const system of [{ ...capabilities.system, available: false }, { ...capabilities.system, language: "en" }]) {
			expect(chooseListenerEngine("ru", { ...capabilities, system }, options).engine).toBe("vosk");
		}
	});
	test("never substitutes a model language or initiates work after cancel", () => {
		expect(() => chooseListenerEngine("de", capabilities, options)).toThrow("No verified small Vosk model");
		expect(() => chooseListenerEngine("en-US", capabilities, options)).toThrow("No verified small Vosk model");
		expect(() => chooseListenerEngine("ru", capabilities, { ...options, cancelled: true })).toThrow("cancelled");
	});
	test("Deepgram error, cancellation, timeout and unclassified failure never silently fallback", () => {
		const errors = ["unsupported_language", "unavailable", "permission_denied", "cancelled", "timeout", "failed"] as const;
		for (const error of errors) {
			expect(canFallbackToVosk("deepgram", error, false)).toBe(false);
			expect(canFallbackToVosk("apple", error, true)).toBe(false);
			expect(canFallbackToVosk("vosk", error, false)).toBe(false);
		}
		for (const error of ["cancelled", "timeout", "failed"] as const) expect(canFallbackToVosk("apple", error, false)).toBe(false);
		for (const error of ["unsupported_language", "unavailable", "permission_denied"] as const) expect(canFallbackToVosk("apple", error, false)).toBe(true);
	});
});
