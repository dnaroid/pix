export const DEFAULT_SPAWN_WATCH_SECONDS = 300;
export const DEFAULT_UPDATE_INTERVAL_SECONDS = 1;
export const MAX_WATCH_SECONDS = 300;

export const INLINE_RENDERING = {
	// Newer runtimes use inline/mergeCallAndResult, older runtimes use renderShell: "self".
	// Keep all three so extension tools render without the default tinted tool box where supported.
	mergeCallAndResult: true,
	inline: true,
	renderShell: "self",
} as const;
