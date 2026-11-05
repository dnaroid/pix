import { ListenerError, normalizeListenerLanguage, type ListenerEngine } from "./contract.js";

export interface ListenerCapabilities {
	/** Resolved by Desktop backend; no credential value crosses the bridge. */
	deepgramConfigured: boolean;
	/** A fresh, language-specific probe, not a promise that Apple will succeed. */
	system: {
		language: string;
		available: boolean;
		onDevice: boolean;
		authorization: "not_determined" | "authorized" | "denied" | "restricted";
	};
	/** Verified small-model manifest languages, not guessed URLs or download state. */
	voskLanguages: readonly string[];
}

export interface ListenerEngineChoice {
	engine: ListenerEngine;
	mode: "local" | "cloud";
	needsSpeechAuthorization: boolean;
	reason: "configured" | "system_local" | "system_remote_consent" | "system_unavailable" | "apple_remote_declined";
}

/** Pure preflight policy. Consent is supplied by the host, never parsed from agent arguments. */
export function chooseListenerEngine(
	language: string,
	capabilities: ListenerCapabilities,
	options: { appleRemoteConsent: boolean; cancelled: boolean },
): ListenerEngineChoice {
	if (options.cancelled) throw new ListenerError("cancelled", "Listener job cancelled.");
	const normalized = normalizeListenerLanguage(language);
	if (capabilities.deepgramConfigured) {
		return { engine: "deepgram", mode: "cloud", needsSpeechAuthorization: false, reason: "configured" };
	}
	const system = capabilities.system;
	const usable = system.language === normalized && system.available
		&& (system.authorization === "authorized" || system.authorization === "not_determined");
	if (usable && (system.onDevice || options.appleRemoteConsent)) {
		return {
			engine: "apple",
			mode: system.onDevice ? "local" : "cloud",
			needsSpeechAuthorization: system.authorization === "not_determined",
			reason: system.onDevice ? "system_local" : "system_remote_consent",
		};
	}
	// Catalog resolution is exact. A regional language must not silently select another model.
	if (!capabilities.voskLanguages.includes(normalized)) {
		throw new ListenerError("model_unavailable", "No verified small Vosk model for the requested language.");
	}
	return {
		engine: "vosk", mode: "local", needsSpeechAuthorization: false,
		reason: usable ? "apple_remote_declined" : "system_unavailable",
	};
}

/** Only these Apple failures may re-enter routing with system.available=false. */
export function canFallbackToVosk(
	engine: ListenerEngine,
	error: "unsupported_language" | "unavailable" | "permission_denied" | "cancelled" | "timeout" | "failed",
	cancelled: boolean,
): boolean {
	return !cancelled && engine === "apple"
		&& (error === "unsupported_language" || error === "unavailable" || error === "permission_denied");
}
