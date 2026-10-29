import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

// Mirrors src/setup/model-profile.ts + model-wizard.ts (the acp package cannot import root src).
// tests/model-setup-parity.test.ts keeps the two writers in sync.

export interface SetupModel {
	readonly provider: string;
	readonly id: string;
	readonly name?: string;
	readonly reasoning?: boolean;
	readonly costOutput?: number;
	readonly contextWindow?: number;
	readonly vision?: boolean;
}

export interface ModelRoles {
	readonly main: string;
	readonly fast: string;
	readonly strong: string;
}

export interface ModelSetupStatus {
	readonly configured: boolean;
	readonly models: readonly { ref: string; label: string; vision: boolean }[];
	readonly suggested?: ModelRoles;
	/** Roles currently written in the user's config, when all three can be read. */
	readonly current?: ModelRoles;
	/** Every model field the setup writes, and the values currently in the configs. */
	readonly slots: readonly ModelSlot[];
	readonly currentSlots: Readonly<Record<string, string>>;
	readonly currentThinking: Readonly<Record<string, string>>;
	readonly currentLists: Readonly<Record<string, readonly string[]>>;
	readonly currentSearch?: SearchSetup;
}

const FAST_HINT = /(?:^|[^a-z])(?:flash|mini|luna|haiku|turbo|lite|nano|small|instant)(?:$|[^a-z])/i;
const STRONG_HINT = /(?:^|[^a-z])(?:opus|astra|pro|max|ultra|large)(?:$|[^a-z])/i;
const FMT = { insertSpaces: true, tabSize: 2 };

export const modelRef = (m: Pick<SetupModel, "provider" | "id">): string => `${m.provider}/${m.id}`;

function tier(m: SetupModel): number {
	const label = `${m.id} ${m.name ?? ""}`;
	if (FAST_HINT.test(label)) return -1;
	if (STRONG_HINT.test(label)) return 1;
	return 0;
}

function compare(a: SetupModel, b: SetupModel): number {
	return tier(a) - tier(b)
		|| (a.costOutput ?? 0) - (b.costOutput ?? 0)
		|| (a.reasoning ? 1 : 0) - (b.reasoning ? 1 : 0)
		|| (a.contextWindow ?? 0) - (b.contextWindow ?? 0)
		|| modelRef(a).localeCompare(modelRef(b));
}

export function suggestRoles(models: readonly SetupModel[]): ModelRoles | undefined {
	if (models.length === 0) return undefined;
	const sorted = [...models].sort(compare);
	return {
		main: modelRef(sorted[Math.floor((sorted.length - 1) * 0.66)]!),
		fast: modelRef(sorted[0]!),
		strong: modelRef(sorted[sorted.length - 1]!),
	};
}

const set = (source: string, path: (string | number)[], value: unknown): string =>
	applyEdits(source, modify(source, path, value, { formattingOptions: FMT }));

export type SlotOverrides = Readonly<Record<string, string | readonly string[]>>;
type Cfg = Record<string, any>;
type Path = (string | number)[];

export interface ModelSlot {
	readonly id: string;
	readonly label: string;
	readonly group: string;
	/** Role whose model this slot takes unless overridden. */
	readonly role: keyof ModelRoles;
	readonly file: "pix" | "suite";
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

const optSlot = (file: "pix" | "suite", id: string, label: string, group: string, path: SlotDef["path"], extra: { list?: boolean; vision?: boolean; parent?: string; openrouter?: boolean } = {}): SlotDef =>
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
	suiteSlot("frontier-primary", "Frontier model (primary)", "Frontier", "strong", fixed("frontierModels", 0, "model")),
	// Extra frontier entries have no role default: only models the user lists stay frontier.
	optSlot("suite", "frontier-extra", "More frontier models", "Frontier", fixed("frontierModels"), { list: true, parent: "frontier-primary" }),
	...AGENT_ROLES.map(([agent, role]) => suiteSlot(`agent-${agent}`, `Sub-agent: ${agent}`, "Sub-agents", role, fixed("builtinAgentModels", agent))),
	suiteSlot("summarizer", "Context summarizer", "Context", "fast", fixed("dcp", "compress", "autoCompress", "summarizerModel", 0)),
	{ ...suiteSlot("summarizer-fallback", "Summarizer fallback", "Context", "main", fixed("dcp", "compress", "autoCompress", "summarizerFallbackModels", 0)), parent: "summarizer" },
	optSlot("suite", "lookup", "Lookup (vision) model", "Vision", fixed("lookupModel"), { vision: true }),
	optSlot("suite", "lookup-fallback", "Lookup fallback", "Vision", fixed("lookupFallbackModels"), { list: true, vision: true, parent: "lookup" }),
];

const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** field: sibling `thinking` key next to modelRef; suffix: `provider/model:level`. */
const THINKING_KIND: Readonly<Record<string, "field" | "suffix">> = {
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
function applyOptional(out: string, cfg: Cfg, slot: SlotDef, value: string | readonly string[] | undefined, primary?: string): string {
	const path = slot.path(cfg);
	if (!path || value === undefined) return out;
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

export const MODEL_SLOTS: readonly ModelSlot[] = [...PIX_SLOTS, ...SUITE_SLOTS].map(({ id, label, group, role, file, optional, vision, parent, list, openrouter }) => ({ ...(openrouter ? { openrouter } : {}), id, label, group, role, file, ...(THINKING_KIND[id] ? { thinking: true } : {}), ...(optional ? { optional } : {}), ...(vision ? { vision } : {}), ...(parent ? { parent } : {}), ...(list ? { list } : {}) }));

const slotValue = (slot: ModelSlot, roles: ModelRoles, overrides: SlotOverrides): string =>
	(typeof overrides[slot.id] === "string" ? (overrides[slot.id] as string).trim() : "") || roles[slot.role];

/** Value of the slot a fallback list hangs off, to keep it out of the list. */
const primaryOf = (slot: SlotDef, all: readonly SlotDef[], roles: ModelRoles, overrides: SlotOverrides): string | undefined => {
	const parent = slot.parent ? all.find((s) => s.id === slot.parent) : undefined;
	if (!parent) return undefined;
	if (parent.optional) { const o = overrides[parent.id]; return typeof o === "string" && o.trim() ? o.trim() : undefined; }
	return slotValue(parent, roles, overrides);
};

export function applyRolesToPixConfig(source: string, roles: ModelRoles, overrides: SlotOverrides = {}): string {
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

const modelOf = (e: unknown): string | undefined => typeof e === "string" ? e : (e as { model?: string } | null)?.model;

/** Primary first; keeps existing entries' flags/aliases. Untouched extras stay as they are. */
function mergeFrontier(existing: unknown, primary: string, extras: SlotOverrides[string] | undefined): unknown[] {
	const list: unknown[] = Array.isArray(existing) ? existing : [];
	const entry = (m: string) => list.find((e) => modelOf(e) === m) ?? { model: m };
	if (extras === undefined) return [entry(primary), ...list.filter((e) => modelOf(e) !== primary)];
	const picked = (typeof extras === "string" ? [extras] : extras).map((m) => m.trim()).filter((m) => m && m !== primary);
	return [primary, ...new Set(picked)].map(entry);
}

export function applyRolesToSuiteConfig(source: string, roles: ModelRoles, overrides: SlotOverrides = {}): string {
	let out = source.trim() ? source : "{\n}\n";
	const suiteCfg = (parseJsonc(out) ?? {}) as Cfg;
	const v = (id: string): string => slotValue(SUITE_SLOTS.find((slot) => slot.id === id)!, roles, overrides);
	out = set(out, ["frontierModels"], mergeFrontier(suiteCfg.frontierModels, v("frontier-primary"), overrides["frontier-extra"]));
	for (const [agent] of AGENT_ROLES) { const level = thinkingOf(overrides, `agent-${agent}`); out = set(out, ["builtinAgentModels", agent], v(`agent-${agent}`) + (level ? `:${level}` : "")); }
	out = set(out, ["dcp", "compress", "autoCompress", "summarizerModel"], [v("summarizer")]);
	out = set(out, ["dcp", "compress", "autoCompress", "summarizerFallbackModels"], v("summarizer-fallback") === v("summarizer") ? [] : [v("summarizer-fallback")]);
	for (const slot of SUITE_SLOTS) if (slot.optional && slot.id !== "frontier-extra") out = applyOptional(out, suiteCfg, slot, overrides[slot.id], primaryOf(slot, SUITE_SLOTS, roles, overrides));
	return out;
}

export function setupConfigPaths(homeDir = homedir()): { pix: string; desktop: string; suite: string } {
	const dir = join(homeDir, ".config", "pi");
	return { pix: join(dir, "pix.jsonc"), desktop: join(dir, "pix-desktop.jsonc"), suite: join(dir, "pi-tools-suite.jsonc") };
}

function update(path: string, transform: (s: string) => string, createIfMissing: boolean): boolean {
	const exists = existsSync(path);
	if (!exists && !createIfMissing) return false;
	const current = exists ? readFileSync(path, "utf8") : "";
	const errors: ParseError[] = [];
	const parsed = current.trim() ? parseJsonc(current, errors) : {};
	if (errors.length > 0 || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, transform(current), "utf8");
	return true;
}

export function writeRoles(roles: ModelRoles, homeDir = homedir(), overrides: SlotOverrides = {}, search?: SearchSetup): string[] {
	const p = setupConfigPaths(homeDir);
	const written: string[] = [];
	if (update(p.pix, (s) => applyRolesToPixConfig(s, roles, overrides), true)) written.push(p.pix);
	if (update(p.desktop, (s) => applyRolesToPixConfig(s, roles, overrides), false)) written.push(p.desktop);
	if (update(p.suite, (s) => (search ? applySearchToSuiteConfig(applyRolesToSuiteConfig(s, roles, overrides), search) : applyRolesToSuiteConfig(s, roles, overrides)), true)) written.push(p.suite);
	return written;
}

function refFrom(path: string): string | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = parseJsonc(readFileSync(path, "utf8")) as { defaultModel?: { modelRef?: unknown } | string } | null;
		const m = parsed?.defaultModel;
		const ref = typeof m === "string" ? m : m?.modelRef;
		return typeof ref === "string" && ref.trim() ? ref : undefined;
	} catch {
		return undefined;
	}
}

/** Configured when the Desktop profile (or, absent that, the TUI profile) names a default model. */
export function modelsConfigured(homeDir = homedir()): boolean {
	const p = setupConfigPaths(homeDir);
	return refFrom(p.desktop) !== undefined || refFrom(p.pix) !== undefined;
}

function readJson(path: string): Record<string, any> | undefined {
	try {
		const parsed = parseJsonc(readFileSync(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, any> : undefined;
	} catch {
		return undefined;
	}
}

/** Current roles: main=defaultModel, fast=autocomplete, strong=first frontier model. */
export function currentRoles(homeDir = homedir()): ModelRoles | undefined {
	const p = setupConfigPaths(homeDir);
	const str = (x: unknown): string | undefined => typeof x === "string" && x.trim() ? x.trim() : undefined;
	const pick = (read: (c: Record<string, any>) => unknown): string | undefined => {
		for (const path of [p.desktop, p.pix]) {
			const c = existsSync(path) ? readJson(path) : undefined;
			const v = c ? str(read(c)) : undefined;
			if (v) return v;
		}
		return undefined;
	};
	const dm = (c: Record<string, any>) => typeof c.defaultModel === "string" ? c.defaultModel : c.defaultModel?.modelRef;
	const main = pick(dm);
	const fast = pick((c) => c.autocomplete?.modelRef) ?? main;
	const suite = existsSync(p.suite) ? readJson(p.suite) : undefined;
	const first = suite?.frontierModels?.[0];
	const strong = str(typeof first === "string" ? first : first?.model) ?? main;
	return main && fast && strong ? { main, fast, strong } : undefined;
}

/** Values currently stored for each slot (Desktop profile wins over TUI for Pix keys). */
export function currentSlotValues(homeDir = homedir()): Record<string, string> {
	const p = setupConfigPaths(homeDir);
	const read = (path: string): Cfg | undefined => (existsSync(path) ? readJson(path) : undefined);
	const pixCfgs = [read(p.desktop), read(p.pix)].filter((c): c is Cfg => c !== undefined);
	const suiteCfg = read(p.suite);
	const out: Record<string, string> = {};
	for (const slot of [...PIX_SLOTS, ...SUITE_SLOTS]) {
		if (slot.list) continue;
		const cfgs = slot.file === "pix" ? pixCfgs : suiteCfg ? [suiteCfg] : [];
		for (const cfg of cfgs) {
			let path = slot.path(cfg);
			if (slot.id === "default" && typeof cfg.defaultModel === "string") { out[slot.id] = cfg.defaultModel; break; }
			if (slot.id.startsWith("frontier-")) {
				const entry = at(cfg, path ? path.slice(0, 2) : []);
				path = typeof entry === "string" ? [] : path;
				if (typeof entry === "string") { out[slot.id] = entry; break; }
			}
			const raw = path ? at(cfg, path) : undefined;
			const value = Array.isArray(raw) ? raw[0] : raw;
			if (typeof value === "string" && value.trim()) {
				const kind = THINKING_KIND[slot.id];
				const m = kind === "suffix" ? /^(.*):(off|minimal|low|medium|high|xhigh|max)$/.exec(value) : null;
				out[slot.id] = m ? m[1]! : value;
				const t = m ? m[2] : kind === "field" && path ? at(cfg, [...path.slice(0, -1), "thinking"]) : undefined;
				if (typeof t === "string" && THINKING_LEVELS.includes(t)) out[`${slot.id}:thinking`] = t;
				break;
			}
		}
	}
	return out;
}

export function currentSlotLists(homeDir = homedir()): Record<string, string[]> {
	const p = setupConfigPaths(homeDir);
	const read = (path: string): Cfg | undefined => (existsSync(path) ? readJson(path) : undefined);
	const pixCfgs = [read(p.desktop), read(p.pix)].filter((c): c is Cfg => c !== undefined);
	const suiteCfg = read(p.suite);
	const out: Record<string, string[]> = {};
	for (const slot of [...PIX_SLOTS, ...SUITE_SLOTS]) {
		if (!slot.list) continue;
		for (const cfg of slot.file === "pix" ? pixCfgs : suiteCfg ? [suiteCfg] : []) {
			const path = slot.path(cfg);
			const raw = path ? at(cfg, path) : undefined;
			if (Array.isArray(raw) && slot.id === "frontier-extra") { out[slot.id] = raw.slice(1).map(modelOf).filter((m): m is string => typeof m === "string"); break; }
			if (Array.isArray(raw)) { out[slot.id] = raw.filter((e): e is string => typeof e === "string"); break; }
		}
	}
	return out;
}

export function currentSearch(homeDir = homedir()): SearchSetup | undefined {
	const path = setupConfigPaths(homeDir).suite;
	const search = existsSync(path) ? readJson(path)?.search : undefined;
	const e = search?.embedding;
	if (!e || typeof e.embeddingModel !== "string" || (e.embeddingProvider !== "openrouter" && e.embeddingProvider !== "ollama")) return undefined;
	return {
		provider: e.embeddingProvider, model: e.embeddingModel, vectorSize: Number(e.vectorSize) || 1536,
		...(typeof e.knowledgeEmbeddingModel === "string" ? { knowledgeModel: e.knowledgeEmbeddingModel } : {}),
		...(typeof search.rerankerModel === "string" ? { reranker: search.rerankerModel } : {}),
	};
}

export async function loadModelSetupStatus(
	homeDir = homedir(),
	createRuntime: () => Promise<ModelRuntime> = () => ModelRuntime.create(),
): Promise<ModelSetupStatus> {
	const configured = modelsConfigured(homeDir);
	const runtime = await createRuntime();
	const available = await runtime.getAvailable();
	const models: SetupModel[] = available.map((m) => ({
		provider: m.provider, id: m.id, name: m.name, reasoning: m.reasoning,
		costOutput: m.cost?.output, contextWindow: m.contextWindow,
		vision: Array.isArray((m as { input?: unknown }).input) && ((m as { input: unknown[] }).input).includes("image"),
	}));
	const suggested = suggestRoles(models);
	const current = currentRoles(homeDir);
	return {
		configured,
		...(current ? { current } : {}),
		slots: MODEL_SLOTS,
		currentSlots: Object.fromEntries(Object.entries(currentSlotValues(homeDir)).filter(([k]) => !k.endsWith(":thinking"))),
		currentThinking: Object.fromEntries(Object.entries(currentSlotValues(homeDir)).filter(([k]) => k.endsWith(":thinking")).map(([k, v]) => [k.slice(0, -9), v])),
		currentLists: currentSlotLists(homeDir),
		...(() => { const cs = currentSearch(homeDir); return cs ? { currentSearch: cs } : {}; })(),
		models: models.map((m) => ({ ref: modelRef(m), label: m.name ? m.name : modelRef(m), vision: m.vision === true })),
		...(suggested ? { suggested } : {}),
	};
}

export function parseRoles(value: unknown): ModelRoles {
	const v = value as Record<string, unknown> | null;
	const ok = (x: unknown): x is string => typeof x === "string" && /^[^\s/]+\/\S+$/.test(x);
	if (!v || typeof v !== "object" || !ok(v.main) || !ok(v.fast) || !ok(v.strong)) {
		throw new Error("pix/setup/models/apply requires main, fast and strong provider/model refs");
	}
	return { main: v.main, fast: v.fast, strong: v.strong };
}

export interface SearchSetup {
	readonly provider: "openrouter" | "ollama";
	readonly model: string;
	readonly vectorSize: number;
	readonly knowledgeModel?: string;
	readonly reranker?: string;
}

export interface ModelSetupApplyRequest {
	readonly roles: ModelRoles;
	readonly overrides: SlotOverrides;
	readonly search?: SearchSetup;
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

function parseSearch(value: unknown): SearchSetup | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as Record<string, unknown>;
	const str = (x: unknown): string | undefined => typeof x === "string" && x.trim() ? x.trim() : undefined;
	const model = str(v.model);
	if ((v.provider !== "openrouter" && v.provider !== "ollama") || !model || model.length > 256) throw new Error("pix/setup/models/apply: invalid search embedding settings");
	const vectorSize = Number(v.vectorSize);
	if (!Number.isInteger(vectorSize) || vectorSize < 1 || vectorSize > 8192) throw new Error("pix/setup/models/apply: invalid vectorSize");
	const knowledgeModel = str(v.knowledgeModel);
	const reranker = typeof v.reranker === "string" ? v.reranker.trim() : undefined;
	return { provider: v.provider, model, vectorSize, ...(knowledgeModel ? { knowledgeModel } : {}), ...(reranker !== undefined ? { reranker } : {}) };
}

export function parseSetupRequest(value: unknown): ModelSetupApplyRequest {
	const roles = parseRoles(value);
	const raw = (value as { overrides?: unknown }).overrides;
	const slots = new Map(MODEL_SLOTS.map((slot) => [slot.id, slot]));
	const overrides: Record<string, string | string[]> = {};
	const ok = (x: unknown): x is string => typeof x === "string" && /^[^\s/]+\/\S+$/.test(x);
	if (raw && typeof raw === "object") {
		for (const [id, ref] of Object.entries(raw)) {
			if (id.endsWith(":thinking")) {
				if (slots.get(id.slice(0, -9))?.thinking && typeof ref === "string" && (ref === "" || THINKING_LEVELS.includes(ref))) overrides[id] = ref;
				continue;
			}
			const slot = slots.get(id);
			if (!slot) continue;
			if (Array.isArray(ref)) {
				if (!slot.list || !ref.every(ok)) throw new Error(`pix/setup/models/apply: invalid model list for ${id}`);
				overrides[id] = [...new Set(ref)];
			} else if (typeof ref === "string" && (ok(ref) || (slot.optional && ref === ""))) overrides[id] = ref;
			else throw new Error(`pix/setup/models/apply: invalid model ref for ${id}`);
		}
	}
	const search = parseSearch((value as { search?: unknown }).search);
	return { roles, overrides, ...(search ? { search } : {}) };
}
