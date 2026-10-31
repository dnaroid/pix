import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
	applyModelRolesToPixConfig,
	applyModelRolesToDesktopConfig,
	applyModelRolesToSuiteConfig,
	applySearchToSuiteConfig,
	MODEL_SLOTS,
	type SearchSetup,
	type ModelSlot,
	type SlotOverrides,
	modelRefOf,
	suggestModelRoles,
	type CandidateModel,
	type ModelRoles,
} from "./model-profile.js";

export type WizardPaths = { pix: string; desktop: string; suite: string };

export function wizardConfigPaths(homeDir = homedir()): WizardPaths {
	const dir = join(homeDir, ".config", "pi");
	return { pix: join(dir, "pix.jsonc"), desktop: join(dir, "pix-desktop.jsonc"), suite: join(dir, "pi-tools-suite.jsonc") };
}

/** Models whose provider has working credentials for this user. */
export async function listAvailableModels(agentDir = getAgentDir()): Promise<CandidateModel[]> {
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		refreshOnCreate: false,
	});
	const models = await runtime.getAvailable();
	return models.map((m) => ({
		provider: m.provider,
		id: m.id,
		name: m.name,
		reasoning: m.reasoning,
		costOutput: m.cost?.output,
		contextWindow: m.contextWindow,
		vision: Array.isArray((m as { input?: unknown }).input) && ((m as { input: unknown[] }).input).includes("image"),
	}));
}

export type WizardIo = {
	/** Returns the user's raw answer; empty string accepts the default. */
	ask(question: string): Promise<string>;
	print(line: string): void;
};

export function createReadlineIo(): WizardIo & { close(): void } {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return { ask: (q) => rl.question(q), print: (l) => console.log(l), close: () => rl.close() };
}

const ROLE_LABELS: ReadonlyArray<readonly [keyof ModelRoles, string]> = [
	["main", "main (everyday coding)"],
	["fast", "fast (autocomplete, titles, commit messages)"],
	["strong", "strong (review, oracle, frontier)"],
];

/** Resolve an answer (number from the list or a provider/model ref) to a model ref. */
export function resolveModelAnswer(answer: string, models: readonly CandidateModel[]): string | undefined {
	const text = answer.trim();
	if (!text) return undefined;
	if (/^\d+$/.test(text)) {
		const picked = models[Number(text) - 1];
		return picked ? modelRefOf(picked) : undefined;
	}
	return models.map(modelRefOf).find((ref) => ref === text);
}

export type WizardResult = { roles: ModelRoles; overrides?: SlotOverrides; search?: SearchSetup; written: string[] } | { skipped: string };

const THINKING_CHOICES = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Fallback chains follow the slot they belong to. */
function orderedSlots(): ModelSlot[] {
	const top = MODEL_SLOTS.filter((s) => !s.parent);
	const kids = MODEL_SLOTS.filter((s) => s.parent);
	return [...top.flatMap((s) => [s, ...kids.filter((k) => k.parent === s.id)]), ...kids.filter((k) => !top.some((t) => t.id === k.parent))];
}

async function askSlots(io: WizardIo, models: readonly CandidateModel[], roles: ModelRoles): Promise<SlotOverrides> {
	const overrides: Record<string, string | string[]> = {};
	const chosen: Record<string, string> = {};
	let group = "";
	for (const slot of orderedSlots()) {
		if (slot.group !== group) { group = slot.group; io.print(`\n${group}`); }
		const pool = models.filter((m) => (!slot.vision || m.vision) && (!slot.openrouter || m.provider === "openrouter")
			&& (!slot.id.startsWith("knowledge-judge") || (modelRefOf(m).length <= 256 && /^[^\s/:]+\/[^\s:]+$/u.test(modelRefOf(m)))));
		if (slot.list) {
			const primary = (slot.parent && chosen[slot.parent]) || "";
			for (;;) {
				const answer = (await io.ask(`    ${slot.label} [none] (comma-separated, Enter keeps, '-' clears): `)).trim();
				if (!answer) break;
				if (answer === "-") { overrides[slot.id] = []; break; }
				const refs = answer.split(",").map((part) => resolveModelAnswer(part.trim(), models));
				if (refs.every((ref) => ref && pool.some((m) => modelRefOf(m) === ref))) {
					overrides[slot.id] = [...new Set(refs as string[])].filter((ref) => ref !== primary);
					break;
				}
				io.print("    Enter numbers or provider/model refs separated by commas.");
			}
			continue;
		}
		const base = slot.optional ? slot.emptyLabel ?? "none" : roles[slot.role];
		chosen[slot.id] = slot.optional ? "" : base;
		for (;;) {
			const hint = slot.optional ? "Enter keeps current, '-' clears" : "Enter keeps";
			const answer = (await io.ask(`  ${slot.label} [${base}] (${hint}): `)).trim();
			if (!answer) break;
			if (answer === "-" && slot.optional) { overrides[slot.id] = ""; chosen[slot.id] = ""; break; }
			const ref = resolveModelAnswer(answer, models);
			if (ref && pool.some((m) => modelRefOf(m) === ref)) { chosen[slot.id] = ref; if (ref !== base) overrides[slot.id] = ref; break; }
			io.print("    Enter a number from the list or a full provider/model ref" + (slot.vision ? " of a vision-capable model." : "."));
		}
		if (slot.thinking) {
			for (;;) {
				const level = (await io.ask(`    Thinking for ${slot.label} (${THINKING_CHOICES.join("/")}, Enter keeps): `)).trim().toLowerCase();
				if (!level) break;
				if (THINKING_CHOICES.includes(level)) { overrides[`${slot.id}:thinking`] = level; break; }
				io.print("    Unknown level.");
			}
		}
	}
	return overrides;
}

async function askSearch(io: WizardIo): Promise<SearchSetup | undefined> {
	const provider = (await io.ask("  Embedding provider (openrouter/ollama) [openrouter]: ")).trim() || "openrouter";
	if (provider !== "openrouter" && provider !== "ollama") { io.print("  Unknown provider; skipping embeddings."); return undefined; }
	const model = (await io.ask("  Embedding model: ")).trim();
	if (!model) { io.print("  No model given; skipping embeddings."); return undefined; }
	const vectorSize = Number((await io.ask("  Vector size [1536]: ")).trim() || "1536");
	if (!Number.isInteger(vectorSize) || vectorSize < 1 || vectorSize > 8192) { io.print("  Invalid vector size; skipping embeddings."); return undefined; }
	const knowledgeModel = (await io.ask("  Knowledge embedding model (optional): ")).trim();
	const reranker = (await io.ask("  Reranker model (optional): ")).trim();
	return { provider, model, vectorSize, ...(knowledgeModel ? { knowledgeModel } : {}), reranker };
}

/**
 * Interactive model setup. Suggests roles from the user's own models, lets them
 * adjust each one, then writes all three configs. Never touches credentials.
 */
export async function runModelWizard(options: {
	io: WizardIo;
	models: readonly CandidateModel[];
	homeDir?: string;
	/** Accept suggestions without prompting (non-interactive installs). */
	assumeYes?: boolean;
}): Promise<WizardResult> {
	const { io, models } = options;
	const suggested = suggestModelRoles(models);
	if (!suggested) {
		return { skipped: "No models with configured credentials. Run /login in Pi, then `pix install` again." };
	}
	const sorted = [...models].sort((a, b) => modelRefOf(a).localeCompare(modelRefOf(b)));
	io.print("\nAvailable models:");
	sorted.forEach((m, i) => io.print(`  ${String(i + 1).padStart(2)}. ${modelRefOf(m)}`));

	const roles: ModelRoles = { ...suggested };
	for (const [key, label] of ROLE_LABELS) {
		if (options.assumeYes) continue;
		for (;;) {
			const answer = await io.ask(`Model for ${label} [${roles[key]}]: `);
			if (!answer.trim()) break;
			const resolved = resolveModelAnswer(answer, sorted);
			if (resolved) {
				roles[key] = resolved;
				break;
			}
			io.print("  Enter a number from the list, a full provider/model ref, or press Enter to keep the default.");
		}
	}
	let overrides: SlotOverrides = {};
	let search: SearchSetup | undefined;
	if (!options.assumeYes) {
		if (/^y/i.test((await io.ask("Customize individual models (fallbacks, lookup, per-feature)? [y/N]: ")).trim())) {
			overrides = await askSlots(io, sorted, roles);
		}
		if (/^y/i.test((await io.ask("Configure search embeddings? Sends project text to the provider [y/N]: ")).trim())) {
			search = await askSearch(io);
		}
	}
	const written = writeModelRoles(roles, options.homeDir, overrides, search);
	return { roles, ...(Object.keys(overrides).length ? { overrides } : {}), ...(search ? { search } : {}), written };
}

function update(path: string, transform: (source: string) => string, createIfMissing: boolean): boolean {
	const exists = existsSync(path);
	if (!exists && !createIfMissing) return false;
	const current = exists ? readFileSync(path, "utf8") : "";
	// Never rewrite a file we cannot parse: the user's content must survive.
	const errors: ParseError[] = [];
	const parsed = current.trim() ? parseJsonc(current, errors) : {};
	if (errors.length > 0 || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	const next = transform(current);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, next, "utf8");
	return true;
}

/** Write roles into pix.jsonc, pix-desktop.jsonc (only if it exists) and pi-tools-suite.jsonc. */
export function writeModelRoles(roles: ModelRoles, homeDir = homedir(), overrides: SlotOverrides = {}, search?: SearchSetup): string[] {
	const paths = wizardConfigPaths(homeDir);
	const written: string[] = [];
	if (update(paths.pix, (s) => applyModelRolesToPixConfig(s, roles, overrides), true)) written.push(paths.pix);
	// A partial desktop file would stop Desktop from creating its full template, so only update an existing one.
	if (update(paths.desktop, (s) => applyModelRolesToDesktopConfig(s, roles, overrides), false)) written.push(paths.desktop);
	if (update(paths.suite, (s) => search ? applySearchToSuiteConfig(applyModelRolesToSuiteConfig(s, roles, overrides), search) : applyModelRolesToSuiteConfig(s, roles, overrides), true)) written.push(paths.suite);
	return written;
}

/** True when pix.jsonc already names a default model, so the wizard must not overwrite it. */
export function modelsAlreadyConfigured(homeDir = homedir()): boolean {
	const path = wizardConfigPaths(homeDir).pix;
	if (!existsSync(path)) return false;
	try {
		const parsed = parseJsonc(readFileSync(path, "utf8")) as { defaultModel?: { modelRef?: unknown } | string } | null;
		const model = parsed?.defaultModel;
		const ref = typeof model === "string" ? model : model?.modelRef;
		return typeof ref === "string" && ref.trim().length > 0;
	} catch {
		return false;
	}
}
