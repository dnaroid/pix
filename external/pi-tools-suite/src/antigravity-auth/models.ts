// Antigravity model catalog, synced with the upstream cortexkit registry
// (packages/core/src/model-registry.ts + transform/model-resolver.ts at
// commit fa48c66f2d931a9182d9c2fa38cdb1d9c4d61f10).
//
// Only models the Pi protocol can represent are advertised: the upstream
// image-output model is intentionally NOT registered because Pi has no way to
// express image-only output. Live route resolution for these public IDs lives
// in payload.ts (resolveActualModel).
export const modelDefinitions = [
	{
		id: "antigravity-gemini-3.8-flash",
		name: "Gemini 3.8 Flash (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" },
	},
	{
		id: "antigravity-gemini-3.7-flash",
		name: "Gemini 3.7 Flash (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" },
	},
	{
		id: "antigravity-gemini-3.6-flash",
		name: "Gemini 3.6 Flash (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" },
	},
	{
		id: "antigravity-gemini-3.5-flash",
		name: "Gemini 3.5 Flash (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high" },
	},
	{
		id: "antigravity-gemini-3.1-pro",
		name: "Gemini 3.1 Pro (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
		thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", xhigh: "high" },
	},
	{
		id: "antigravity-claude-sonnet-4-6-thinking",
		name: "Claude Sonnet 4.6 Thinking (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "high" },
	},
	{
		id: "antigravity-claude-opus-4-6-thinking",
		name: "Claude Opus 4.6 Thinking (Antigravity)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "high" },
	},
	{
		// GPT-OSS 120B with reasoning effort "medium" baked into the live route.
		// Pi gets no thinkingConfig for it; the map pins every level to medium
		// so the UI stays honest without changing routing.
		id: "antigravity-gpt-oss-120b-medium",
		name: "GPT-OSS 120B Medium (Antigravity)",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 32_768,
		thinkingLevelMap: { minimal: "medium", low: "medium", medium: "medium", high: "medium", xhigh: "medium" },
	},
	// Legacy Antigravity entries kept as aliases; both live routes still exist
	// upstream (gemini-3-flash is also the target of the 3.5-flash high tier).
	{
		id: "antigravity-gemini-3-flash",
		name: "Gemini 3 Flash (Antigravity, legacy)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null },
	},
	{
		id: "antigravity-claude-sonnet-4-6",
		name: "Claude Sonnet 4.6 (Antigravity, legacy)",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	// These Gemini CLI-named models mirror opencode's provider surface, but opencode
	// routes them Antigravity-first unless cli_first is enabled.
	{
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash (Gemini CLI)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
		antigravityHeaderStyle: "antigravity",
	},
	{
		id: "gemini-3-flash-preview",
		name: "Gemini 3 Flash Preview (Gemini CLI)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		thinkingLevelMap: { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null },
		antigravityHeaderStyle: "antigravity",
	},
	{
		id: "gemini-3.1-pro-preview",
		name: "Gemini 3.1 Pro Preview (Gemini CLI)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
		thinkingLevelMap: { minimal: null, low: "low", medium: null, high: null, xhigh: null },
		antigravityHeaderStyle: "antigravity",
	},
	{
		id: "gemini-3.1-pro-preview-customtools",
		name: "Gemini 3.1 Pro Preview Custom Tools (Gemini CLI)",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_535,
		thinkingLevelMap: { minimal: null, low: "low", medium: null, high: null, xhigh: null },
		antigravityHeaderStyle: "antigravity",
	},
];
