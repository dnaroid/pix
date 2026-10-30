import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";

/** A model the user can actually run (provider has credentials). */
export type CandidateModel = {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
	/** Catalog output price per million tokens; 0/undefined for subscription providers. */
	costOutput?: number;
	contextWindow?: number;
	vision?: boolean;
};

export type ModelRoles = {
	/** Everyday coding model. */
	main: string;
	/** Cheap and fast: autocomplete, titles, commit messages, prompt enhancer. */
	fast: string;
	/** Strongest: review, oracle, frontier selection. */
	strong: string;
};

const FAST_HINT = /(?:^|[^a-z])(?:flash|mini|luna|haiku|turbo|lite|nano|small|instant)(?:$|[^a-z])/i;
const STRONG_HINT = /(?:^|[^a-z])(?:opus|astra|pro|max|ultra|large)(?:$|[^a-z])/i;

export function modelRefOf(model: Pick<CandidateModel, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function tierScore(model: CandidateModel): number {
	const label = `${model.id} ${model.name ?? ""}`;
	if (FAST_HINT.test(label)) return -1;
	if (STRONG_HINT.test(label)) return 1;
	return 0;
}

function compareByTier(a: CandidateModel, b: CandidateModel): number {
	return tierScore(a) - tierScore(b)
		|| (a.costOutput ?? 0) - (b.costOutput ?? 0)
		|| (a.reasoning ? 1 : 0) - (b.reasoning ? 1 : 0)
		|| (a.contextWindow ?? 0) - (b.contextWindow ?? 0)
		|| modelRefOf(a).localeCompare(modelRefOf(b));
}

/**
 * Suggest role assignments from the user's own available models.
 * Pure heuristic: name hints first (works for subscription providers whose cost is 0),
 * then catalog price, reasoning support and context size.
 */
export function suggestModelRoles(candidates: readonly CandidateModel[]): ModelRoles | undefined {
	if (candidates.length === 0) return undefined;
	const sorted = [...candidates].sort(compareByTier);
	const fast = sorted[0]!;
	const strong = sorted[sorted.length - 1]!;
	const main = sorted[Math.floor((sorted.length - 1) * 0.66)]!;
	return { main: modelRefOf(main), fast: modelRefOf(fast), strong: modelRefOf(strong) };
}

const FMT = { insertSpaces: true, tabSize: 2 };

function set(source: string, path: (string | number)[], value: unknown): string {
	return applyEdits(source, modify(source, path, value, { formattingOptions: FMT }));
}

export type SlotOverrides = Readonly<Record<string, string | readonly string[]>>;
type Cfg = Record<string, any>;
type Path = (string | number)[];

export interface ModelSlot {
	readonly id: string;
	readonly label: string;
	readonly group: string;
	/** Role whose model this slot takes unless overridden. */
	readonly role: keyof ModelRoles;
	readonly file: "pix" | "suite" | "desktop";
	readonly emptyLabel?: string;
	readonly thinkingDefaultLabel?: string;
	/** No role default: written only when the user picks a value (empty clears it). */
	readonly optional?: boolean;
	/** Offer only vision-capable models. */
	readonly vision?: boolean;
	/** Offer only OpenRouter models (called through the OpenRouter API directly). */
	readonly openrouter?: boolean;
	/** Slot this one is a fallback chain for; shown right after it. */
	readonly parent?: string;
	/** Holds an ordered, de-duplicated list of models. */
	readonly list?: boolean;
	/** A thinking level can be chosen (override key `<id>:thinking`). */
	readonly thinking?: boolean;
}

interface SlotDef extends ModelSlot {
	path(cfg: Cfg): Path | undefined;
	suffix?: string;
}

const fixed = (...p: Path) => (): Path => p;
const objectAt = (key: string, p: Path) => (cfg: Cfg): Path | undefined =>
	cfg[key] && typeof cfg[key] === "object" ? p : undefined;
const tierPath = (id: string) => (cfg: Cfg): Path | undefined => {
	const tiers: unknown[] = Array.isArray(cfg.modelRouting?.tiers) ? cfg.modelRouting.tiers : [];
	const i = tiers.findIndex((t) => (t as { id?: string } | null)?.id === id);
	return i >= 0 ? ["modelRouting", "tiers", i, "modelRef"] : undefined;
};
const pixSlot = (id: string, label: string, group: string, role: keyof ModelRoles, path: SlotDef["path"], suffix?: string): SlotDef =>
	({ id, label, group, role, file: "pix", path, ...(suffix ? { suffix } : {}) });
const suiteSlot = (id: string, label: string, group: string, role: keyof ModelRoles, path: SlotDef["path"]): SlotDef =>
	({ id, label, group, role, file: "suite", path });

const optSlot = (file: ModelSlot["file"], id: string, label: string, group: string, path: SlotDef["path"], extra: { list?: boolean; vision?: boolean; parent?: string; openrouter?: boolean; emptyLabel?: string; thinkingDefaultLabel?: string } = {}): SlotDef =>
	({ id, label, group, role: "main", file, path, optional: true, ...extra });
const listPath = (key: string, p: Path) => (cfg: Cfg): Path | undefined =>
	(key === "" || (cfg[key] === undefined || (cfg[key] && typeof cfg[key] === "object"))) ? p : undefined;

// Order matters: it is the write order, and tests/model-setup-parity.test.ts pins it to src/setup.
const PIX_SLOTS: readonly SlotDef[] = [
	pixSlot("default", "Default model", "Sessions", "main", fixed("defaultModel", "modelRef")),
	pixSlot("prompt-enhancer", "Prompt enhancer", "Assistant", "fast", fixed("promptEnhancer", "modelRef")),
	pixSlot("autocomplete", "Autocomplete", "Assistant", "fast", fixed("autocomplete", "modelRef")),
	pixSlot("selection-assist", "Explain & translate", "Assistant", "fast", objectAt("selectionAssist", ["selectionAssist", "modelRef"])),
	pixSlot("session-title", "Session titles", "Assistant", "fast", fixed("sessionTitle", "modelRef")),
	pixSlot("git-review", "Git review", "Git", "strong", fixed("desktop", "git", "reviewModelRef"), ":medium"),
	pixSlot("git-commit", "Commit messages", "Git", "fast", fixed("desktop", "git", "commitMessageModelRef"), ":minimal"),
	pixSlot("routing", "Model router", "Routing", "fast", objectAt("modelRouting", ["modelRouting", "modelRef"])),
	pixSlot("tier-simple", "Routing tier: simple", "Routing", "fast", tierPath("simple")),
	pixSlot("tier-standard", "Routing tier: standard", "Routing", "main", tierPath("standard")),
	pixSlot("tier-complex", "Routing tier: complex", "Routing", "strong", tierPath("complex")),
	pixSlot("tier-expert", "Routing tier: expert", "Routing", "strong", tierPath("expert")),
	pixSlot("heads-up", "Heads-up observer", "Desktop", "fast", objectAt("headsUp", ["headsUp", "model"])),
	pixSlot("ci-fix", "CI fix sessions", "Desktop", "main", objectAt("headsUp", ["desktop", "git", "ciFixModelRef"])),
	pixSlot("rag", "Search answers (RAG)", "Desktop", "fast", objectAt("search", ["search", "ragModelRef"])),
	optSlot("pix", "search-intent", "Search & task classifier", "Desktop", fixed("search", "intentModelRef"), { openrouter: true }),
	optSlot("pix", "default-fallback", "Default model fallback", "Sessions", listPath("defaultModel", ["defaultModel", "fallbackModels"]), { list: true, parent: "default" }),
	optSlot("pix", "prompt-enhancer-fallback", "Prompt enhancer fallback", "Assistant", fixed("promptEnhancer", "fallbackModels"), { list: true, parent: "prompt-enhancer" }),
	optSlot("pix", "autocomplete-fallback", "Autocomplete fallback", "Assistant", fixed("autocomplete", "fallbackModels"), { list: true, parent: "autocomplete" }),
	optSlot("pix", "selection-assist-fallback", "Explain & translate fallback", "Assistant", objectAt("selectionAssist", ["selectionAssist", "fallbackModels"]), { list: true, parent: "selection-assist" }),
	optSlot("pix", "session-title-fallback", "Session titles fallback", "Assistant", fixed("sessionTitle", "fallbackModels"), { list: true, parent: "session-title" }),
	optSlot("pix", "git-review-fallback", "Git review fallback", "Git", fixed("desktop", "git", "reviewFallbackModels"), { list: true, parent: "git-review" }),
	optSlot("pix", "git-commit-fallback", "Commit messages fallback", "Git", fixed("desktop", "git", "commitMessageFallbackModels"), { list: true, parent: "git-commit" }),
	optSlot("pix", "routing-fallback", "Model router fallback", "Routing", objectAt("modelRouting", ["modelRouting", "fallbackModels"]), { list: true, parent: "routing" }),
];

const AGENT_ROLES: ReadonlyArray<readonly [string, keyof ModelRoles]> = [
	["research", "fast"], ["verify", "fast"], ["knowledge-auditor", "fast"], ["ui-qa", "fast"],
	["implement-core", "main"], ["mechanical", "main"],
];
const SUITE_SLOTS: readonly SlotDef[] = [
	optSlot("suite", "knowledge-judge", "Contradiction judge", "Assistant", fixed("knowledgeCheck", "modelRef"), { emptyLabel: "No judge selected", thinkingDefaultLabel: "Low (default)" }),
	suiteSlot("frontier-primary", "Frontier model (primary)", "Frontier", "strong", fixed("frontierModels", 0, "model")),
	// Extra frontier entries have no role default: only models the user lists stay frontier.
	optSlot("suite", "frontier-extra", "More frontier models", "Frontier", fixed("frontierModels"), { list: true, parent: "frontier-primary" }),
	...AGENT_ROLES.map(([agent, role]) => suiteSlot(`agent-${agent}`, `Sub-agent: ${agent}`, "Sub-agents", role, fixed("builtinAgentModels", agent))),
	suiteSlot("summarizer", "Context summarizer", "Context", "fast", fixed("dcp", "compress", "autoCompress", "summarizerModel", 0)),
	{ ...suiteSlot("summarizer-fallback", "Summarizer fallback", "Context", "main", fixed("dcp", "compress", "autoCompress", "summarizerFallbackModels", 0)), parent: "summarizer" },
	optSlot("suite", "lookup", "Lookup (vision) model", "Vision", fixed("lookupModel"), { vision: true }),
	optSlot("suite", "lookup-fallback", "Lookup fallback", "Vision", fixed("lookupFallbackModels"), { list: true, vision: true, parent: "lookup" }),
];

const DESKTOP_SLOTS: readonly SlotDef[] = [
	optSlot("desktop", "knowledge-judge-desktop", "Contradiction judge (Desktop override)", "Assistant", fixed("knowledgeCheck", "modelRef"), { parent: "knowledge-judge", emptyLabel: "Use Tools Suite setting", thinkingDefaultLabel: "Use Tools Suite setting" }),
];

const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** field: sibling `thinking` key next to modelRef; suffix: `provider/model:level`. */
const THINKING_KIND: Readonly<Record<string, "field" | "suffix">> = {
	"knowledge-judge": "field", "knowledge-judge-desktop": "field",
	default: "field", "tier-simple": "field", "tier-standard": "field", "tier-complex": "field", "tier-expert": "field",
	"git-review": "suffix", "git-commit": "suffix",
	...Object.fromEntries(AGENT_ROLES.map(([agent]) => [`agent-${agent}`, "suffix" as const])),
};
const thinkingOf = (overrides: SlotOverrides, id: string): string | undefined => {
	const v = overrides[`${id}:thinking`];
	return typeof v === "string" && THINKING_LEVELS.includes(v) ? v : undefined;
};

const at = (cfg: Cfg, path: Path): unknown => path.reduce<any>((o, k) => (o == null ? undefined : o[k]), cfg);

/** Optional slot: skip when untouched; an empty pick clears. Lists are de-duplicated and never repeat the primary. */
function applyOptional(out: string, cfg: Cfg, slot: SlotDef, value: string | readonly string[] | undefined, primary?: string, thinking?: SlotOverrides[string]): string {
	const path = slot.path(cfg);
	if (!path) return out;
	if (THINKING_KIND[slot.id] === "field" && typeof thinking === "string"
		&& (thinking === "" || THINKING_LEVELS.includes(thinking))) {
		out = set(out, [...path.slice(0, -1), "thinking"], thinking || undefined);
	}
	if (value === undefined) return out;
	if (slot.list) {
		const raw = typeof value === "string" ? [value] : value;
		const list = [...new Set(raw.map((v) => v.trim()).filter((v) => v && v !== primary))];
		if (list.length === 0) return at(cfg, path) === undefined ? out : set(out, path, []);
		return set(out, path, list);
	}
	const single = (typeof value === "string" ? value : value[0] ?? "").trim();
	if (!single) return at(cfg, path) === undefined ? out : set(out, path, undefined);
	return set(out, path, single);
}

export const MODEL_SLOTS: readonly ModelSlot[] = [...PIX_SLOTS, ...SUITE_SLOTS, ...DESKTOP_SLOTS].map(({ id, label, group, role, file, optional, vision, parent, list, openrouter, emptyLabel, thinkingDefaultLabel }) => ({ ...(openrouter ? { openrouter } : {}), id, label, group, role, file, ...(THINKING_KIND[id] ? { thinking: true } : {}), ...(optional ? { optional } : {}), ...(vision ? { vision } : {}), ...(parent ? { parent } : {}), ...(list ? { list } : {}), ...(emptyLabel ? { emptyLabel } : {}), ...(thinkingDefaultLabel ? { thinkingDefaultLabel } : {}) }));

const slotValue = (slot: ModelSlot, roles: ModelRoles, overrides: SlotOverrides): string =>
	(typeof overrides[slot.id] === "string" ? (overrides[slot.id] as string).trim() : "") || roles[slot.role];

/** Value of the slot a fallback list hangs off, to keep it out of the list. */
const primaryOf = (slot: SlotDef, all: readonly SlotDef[], roles: ModelRoles, overrides: SlotOverrides): string | undefined => {
	const parent = slot.parent ? all.find((s) => s.id === slot.parent) : undefined;
	if (!parent) return undefined;
	if (parent.optional) { const o = overrides[parent.id]; return typeof o === "string" && o.trim() ? o.trim() : undefined; }
	return slotValue(parent, roles, overrides);
};

export function applyModelRolesToPixConfig(source: string, roles: ModelRoles, overrides: SlotOverrides = {}): string {
	let out = source.trim() ? source : "{\n}\n";
	const cfg = (parseJsonc(out) ?? {}) as Cfg;
	for (const slot of PIX_SLOTS) {
		if (slot.optional) { out = applyOptional(out, cfg, slot, overrides[slot.id], primaryOf(slot, PIX_SLOTS, roles, overrides)); continue; }
		const path = slot.path(cfg);
		if (!path) continue;
		const value = slotValue(slot, roles, overrides);
		const level = thinkingOf(overrides, slot.id);
		const kind = THINKING_KIND[slot.id];
		out = set(out, path, value + (kind === "suffix" && level ? `:${level}` : slot.suffix ?? ""));
		if (kind === "field" && level) out = set(out, [...path.slice(0, -1), "thinking"], level);
		if (slot.id === "session-title") out = set(out, ["sessionTitle", "fallbackModels"], value === roles.main ? [] : [roles.main]);
	}
	return out;
}

/** Desktop-only overrides must never be written to pix.jsonc. */
export function applyModelRolesToDesktopConfig(source: string, roles: ModelRoles, overrides: SlotOverrides = {}): string {
	let out = applyModelRolesToPixConfig(source, roles, overrides);
	const cfg = (parseJsonc(out) ?? {}) as Cfg;
	for (const slot of DESKTOP_SLOTS) out = applyOptional(out, cfg, slot, overrides[slot.id], undefined, overrides[`${slot.id}:thinking`]);
	return out;
}

const modelOf = (e: unknown): string | undefined => typeof e === "string" ? e : (e as { model?: string } | null)?.model;

/** Primary first; keeps existing entries' flags/aliases. Untouched extras stay as they are. */
function mergeFrontier(existing: unknown, primary: string, extras: SlotOverrides[string] | undefined): unknown[] {
	const list: unknown[] = Array.isArray(existing) ? existing : [];
	const entry = (m: string) => list.find((e) => modelOf(e) === m) ?? { model: m };
	if (extras === undefined) return [entry(primary), ...list.filter((e) => modelOf(e) !== primary)];
	const picked = (typeof extras === "string" ? [extras] : extras).map((m) => m.trim()).filter((m) => m && m !== primary);
	return [primary, ...new Set(picked)].map(entry);
}

export function applyModelRolesToSuiteConfig(source: string, roles: ModelRoles, overrides: SlotOverrides = {}): string {
	let out = source.trim() ? source : "{\n}\n";
	const suiteCfg = (parseJsonc(out) ?? {}) as Cfg;
	const v = (id: string): string => slotValue(SUITE_SLOTS.find((slot) => slot.id === id)!, roles, overrides);
	out = set(out, ["frontierModels"], mergeFrontier(suiteCfg.frontierModels, v("frontier-primary"), overrides["frontier-extra"]));
	for (const [agent] of AGENT_ROLES) { const level = thinkingOf(overrides, `agent-${agent}`); out = set(out, ["builtinAgentModels", agent], v(`agent-${agent}`) + (level ? `:${level}` : "")); }
	out = set(out, ["dcp", "compress", "autoCompress", "summarizerModel"], [v("summarizer")]);
	out = set(out, ["dcp", "compress", "autoCompress", "summarizerFallbackModels"], v("summarizer-fallback") === v("summarizer") ? [] : [v("summarizer-fallback")]);
	for (const slot of SUITE_SLOTS) if (slot.optional && slot.id !== "frontier-extra") out = applyOptional(out, suiteCfg, slot, overrides[slot.id], primaryOf(slot, SUITE_SLOTS, roles, overrides), overrides[`${slot.id}:thinking`]);
	return out;
}

export interface SearchSetup {
	readonly provider: "openrouter" | "ollama";
	readonly model: string;
	readonly vectorSize: number;
	readonly knowledgeModel?: string;
	readonly reranker?: string;
}

/** Embeddings/reranker are not chat models and authorise uploads, so they are written only on explicit request. */
export function applySearchToSuiteConfig(source: string, search: SearchSetup): string {
	let out = source.trim() ? source : "{\n}\n";
	out = set(out, ["search", "embedding"], {
		embeddingProvider: search.provider,
		embeddingModel: search.model,
		vectorSize: search.vectorSize,
		...(search.knowledgeModel ? { knowledgeEmbeddingModel: search.knowledgeModel } : {}),
	});
	if (search.reranker !== undefined) out = set(out, ["search", "rerankerModel"], search.reranker.trim() || undefined);
	return out;
}
