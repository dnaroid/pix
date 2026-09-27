/**
 * Frontier model catalog shared by sub-agent roles.
 *
 * The suite config (`frontierModels`, `economy`) names the strongest models
 * once, so roles such as oracle and frontier-review do not hard-code them and
 * a new frontier release is a config edit. Model identity is compared by
 * vendor and normalized model id rather than by provider string: the same
 * model reached through `openai`, `openai-codex`, `github-copilot` or
 * `openrouter` is still the same model.
 */

export interface FrontierModelEntry {
	/** Exact provider/model reference used when this entry is selected. */
	model: string;
	/** Model family owner. Inferred from the model id when omitted. */
	vendor?: string;
	/** Excluded from every role's automatic selection while economy mode is on. */
	expensive?: boolean;
	/** false keeps the entry recognized as frontier but never selects it. */
	enabled?: boolean;
	/** Glob patterns identifying the same model under other refs (e.g. OpenRouter aliases). */
	aliases?: string[];
	/** Optional role allow-list. Omitted means every frontier-selecting role. */
	roles?: string[];
}

export interface FrontierConfig {
	models: FrontierModelEntry[];
	economy: boolean;
}

export const DEFAULT_FRONTIER_MODELS: readonly FrontierModelEntry[] = Object.freeze([
	{ model: "openai-codex/gpt-6-astra", expensive: true, aliases: ["*gpt*astra*"], roles: ["oracle"] },
	{ model: "openai-codex/gpt-6-sol", expensive: true, aliases: ["*gpt-6-sol*"] },
	{ model: "zai/glm-5.3" },
]);

export function defaultFrontierConfig(): FrontierConfig {
	return { models: DEFAULT_FRONTIER_MODELS.map(cloneEntry), economy: false };
}

/** Ordered by specificity: the first matching family wins. */
const VENDOR_FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
	[/(?:^|[^a-z0-9])claude(?:$|[^a-z])/, "anthropic"],
	[/(?:^|[^a-z0-9])gemini(?:$|[^a-z])/, "google"],
	[/(?:^|[^a-z0-9])gemma(?:$|[^a-z])/, "google"],
	[/(?:^|[^a-z0-9])glm(?:$|[^a-z])/, "zai"],
	[/(?:^|[^a-z0-9])(?:gpt|chatgpt|codex)(?:$|[^a-z])/, "openai"],
	[/^o\d(?:$|[^a-z0-9])/, "openai"],
	[/(?:^|[^a-z0-9])grok(?:$|[^a-z])/, "xai"],
	[/(?:^|[^a-z0-9])deepseek(?:$|[^a-z])/, "deepseek"],
	[/(?:^|[^a-z0-9])(?:qwen|qwq)(?:$|[^a-z])/, "qwen"],
	[/(?:^|[^a-z0-9])kimi(?:$|[^a-z])/, "moonshot"],
	[/(?:^|[^a-z0-9])(?:mistral|codestral|devstral|magistral)(?:$|[^a-z])/, "mistral"],
	[/(?:^|[^a-z0-9])llama(?:$|[^a-z])/, "meta"],
];

/** Provider id of a provider/model reference (first path segment). */
export function providerOfModelRef(ref: string | undefined): string | undefined {
	const trimmed = ref?.trim();
	if (!trimmed || /[\s*]/.test(trimmed)) return undefined;
	const slash = trimmed.indexOf("/");
	if (slash <= 0 || slash === trimmed.length - 1) return undefined;
	return trimmed.slice(0, slash).toLowerCase();
}

/** Provider-independent model id: last path segment, lowercased, without OpenRouter's `~`. */
export function normalizedModelId(ref: string | undefined): string | undefined {
	const trimmed = ref?.trim().toLowerCase();
	if (!trimmed) return undefined;
	const id = trimmed.slice(trimmed.lastIndexOf("/") + 1).replace(/^~+/, "");
	return id || undefined;
}

function inferVendorFromId(id: string): string | undefined {
	for (const [pattern, vendor] of VENDOR_FAMILIES) {
		if (pattern.test(id)) return vendor;
	}
	return undefined;
}

/**
 * Vendor (model family owner) of a model reference. Configured frontier
 * entries win, then the model-id family table, then the provider id.
 */
export function modelVendor(ref: string | undefined, frontier?: FrontierConfig): string | undefined {
	if (!ref?.trim()) return undefined;
	const entry = frontier ? findFrontierEntry(ref, frontier) : undefined;
	if (entry?.vendor) return entry.vendor.toLowerCase();
	const id = normalizedModelId(ref);
	return (id ? inferVendorFromId(id) : undefined) ?? providerOfModelRef(ref);
}

/** Same model regardless of the provider that serves it. */
export function isSameModel(left: string | undefined, right: string | undefined, frontier?: FrontierConfig): boolean {
	const leftId = normalizedModelId(left);
	const rightId = normalizedModelId(right);
	if (!leftId || !rightId) return false;
	if (leftId === rightId) return true;
	if (!frontier) return false;
	const leftEntry = findFrontierEntry(left!, frontier);
	return leftEntry !== undefined && leftEntry === findFrontierEntry(right!, frontier);
}

/** The frontier entry describing `ref`, matched by exact ref, normalized id, or alias. */
export function findFrontierEntry(ref: string, frontier: FrontierConfig): FrontierModelEntry | undefined {
	const trimmed = ref.trim();
	const id = normalizedModelId(trimmed);
	return frontier.models.find((entry) => entry.model === trimmed
		|| (id !== undefined && normalizedModelId(entry.model) === id)
		|| (entry.aliases ?? []).some((pattern) => globRegExp(pattern).test(trimmed)));
}

export function isFrontierModel(ref: string | undefined, frontier: FrontierConfig): boolean {
	return Boolean(ref?.trim()) && findFrontierEntry(ref!, frontier) !== undefined;
}

/**
 * Why automatic selection must skip `ref`, or undefined when it may run.
 * Economy mode blocks expensive frontier models for every role.
 */
export function economyBlockReason(ref: string, frontier: FrontierConfig): string | undefined {
	if (!frontier.economy) return undefined;
	const entry = findFrontierEntry(ref, frontier);
	return entry?.expensive ? `${ref} is marked expensive and economy mode is on` : undefined;
}

/** Enabled frontier models offered to `role`, in configured preference order. */
export function frontierCandidatesForRole(role: string | undefined, frontier: FrontierConfig): string[] {
	return frontier.models
		.filter((entry) => entry.enabled !== false)
		.filter((entry) => !entry.roles || (role !== undefined && entry.roles.includes(role)))
		.map((entry) => entry.model);
}

/**
 * Apply a concrete parent-vendor policy to an ordered candidate list.
 * `prefer-other` keeps every candidate: other vendors, then the parent's
 * vendor, then the parent's own model. `require-other` keeps only candidates
 * of a known other vendor that are not the parent's model.
 */
export function applyVendorPolicy(
	candidates: readonly string[],
	policy: "prefer-other" | "require-other",
	parentRef: string | undefined,
	frontier: FrontierConfig,
): string[] {
	const parentVendor = modelVendor(parentRef, frontier);
	if (policy === "require-other") {
		return candidates.filter((ref) => {
			const vendor = modelVendor(ref, frontier);
			return vendor !== undefined && vendor !== parentVendor && !isSameModel(ref, parentRef, frontier);
		});
	}
	if (!parentVendor) return [...candidates];
	const rank = (ref: string) => isSameModel(ref, parentRef, frontier) ? 2 : modelVendor(ref, frontier) === parentVendor ? 1 : 0;
	return [0, 1, 2].flatMap((level) => candidates.filter((ref) => rank(ref) === level));
}

/**
 * The configured oracle chain for a parent before runtime availability
 * checks: frontier candidates for `role`, minus economy-blocked models, with
 * another vendor required for a frontier parent and preferred otherwise.
 */
export function frontierOracleCandidates(parentRef: string, frontier: FrontierConfig, role = "oracle"): string[] {
	const candidates = frontierCandidatesForRole(role, frontier).filter((ref) => !economyBlockReason(ref, frontier));
	return applyVendorPolicy(candidates, isFrontierModel(parentRef, frontier) ? "require-other" : "prefer-other", parentRef, frontier);
}

/**
 * Normalize a raw `frontierModels` config value. Invalid entries are dropped
 * rather than failing config load, matching the suite's lenient layering.
 */
export function normalizeFrontierModels(raw: unknown): FrontierModelEntry[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const seen = new Set<string>();
	const entries: FrontierModelEntry[] = [];
	for (const item of raw) {
		const entry = typeof item === "string" ? { model: item } : item;
		if (!isRecord(entry) || typeof entry.model !== "string") continue;
		const model = entry.model.trim();
		if (!providerOfModelRef(model) || seen.has(model)) continue;
		seen.add(model);
		const normalized: FrontierModelEntry = { model };
		if (typeof entry.vendor === "string" && entry.vendor.trim()) normalized.vendor = entry.vendor.trim().toLowerCase();
		if (typeof entry.expensive === "boolean") normalized.expensive = entry.expensive;
		if (typeof entry.enabled === "boolean") normalized.enabled = entry.enabled;
		const aliases = stringList(entry.aliases);
		if (aliases) normalized.aliases = aliases;
		const roles = stringList(entry.roles);
		if (roles) normalized.roles = roles;
		entries.push(normalized);
	}
	return entries;
}

function stringList(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const list = [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
	return list.length > 0 ? list : undefined;
}

function cloneEntry(entry: FrontierModelEntry): FrontierModelEntry {
	return {
		...entry,
		...(entry.aliases ? { aliases: [...entry.aliases] } : {}),
		...(entry.roles ? { roles: [...entry.roles] } : {}),
	};
}

function globRegExp(pattern: string): RegExp {
	const escaped = pattern.trim().replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*");
	return new RegExp(`^${escaped}$`, "i");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
