export type StorelessCapabilityStatus = "supported" | "limited" | "unsupported";
export type StorelessCapabilityStrategy = "native-passthrough" | "metadata-only" | "pure-parser-candidate" | "none";

export interface StorelessCapabilityEntry {
	surface:
		| "test-build"
		| "mutation-lsp"
		| "web-document"
		| "structured-json"
		| "subagent-result"
		| "visual"
		| "browser-direct"
		| "mcp-direct";
	status: StorelessCapabilityStatus;
	strategy: StorelessCapabilityStrategy;
	lifetime: "current-result" | "producer-managed" | "visual-message" | "none";
	reason: string;
}

/**
 * Storeless capability claims proven or deliberately limited by P01-R.
 *
 * This table is documentation/doctor-ready metadata only. It does not register
 * adapters, readers, grants, fetchers, parsers, or filesystem capabilities.
 */
export const STORELESS_CAPABILITIES: readonly StorelessCapabilityEntry[] = Object.freeze([
	{
		surface: "test-build",
		status: "limited",
		strategy: "pure-parser-candidate",
		lifetime: "current-result",
		reason: "Bun/TAP/bounded TypeScript parsing is observe-only; production delivery remains passthrough without a recovery/lifetime contract.",
	},
	{
		surface: "mutation-lsp",
		status: "supported",
		strategy: "native-passthrough",
		lifetime: "current-result",
		reason: "Execution outcome, actual changedFiles and appended diagnostics stay in the native tool result; Context Gateway adds no diff or mutation retry.",
	},
	{
		surface: "web-document",
		status: "limited",
		strategy: "native-passthrough",
		lifetime: "current-result",
		reason: "Existing web tools own fetch, URL/provider metadata and truncation. Storeless Gateway does not refetch, archive, or claim stable pagination of omitted content.",
	},
	{
		surface: "structured-json",
		status: "limited",
		strategy: "native-passthrough",
		lifetime: "current-result",
		reason: "No generic JSON field-selection adapter is enabled. JSON text/numbers pass through exactly as delivered by the producer.",
	},
	{
		surface: "subagent-result",
		status: "limited",
		strategy: "native-passthrough",
		lifetime: "producer-managed",
		reason: "The producer already returns a compact result and artifact paths. P01-R neither reads internal history nor grants/extends artifact lifetime by path.",
	},
	{
		surface: "visual",
		status: "supported",
		strategy: "native-passthrough",
		lifetime: "visual-message",
		reason: "Image parts remain image parts; storeless text accounting/cleanup does not replace them with textual summaries.",
	},
	{
		surface: "browser-direct",
		status: "unsupported",
		strategy: "none",
		lifetime: "none",
		reason: "Current browser QA executes in a child Pi process without the parent extension result boundary; no direct DOM/network/console Gateway adapter is claimed.",
	},
	{
		surface: "mcp-direct",
		status: "unsupported",
		strategy: "none",
		lifetime: "none",
		reason: "No supported direct MCP execution/result boundary was proven in P00 for the current Pix adapter.",
	},
]);

export function storelessCapability(surface: StorelessCapabilityEntry["surface"]): StorelessCapabilityEntry {
	const entry = STORELESS_CAPABILITIES.find((candidate) => candidate.surface === surface);
	if (!entry) throw new Error(`Unknown storeless capability surface: ${surface}`);
	return entry;
}
