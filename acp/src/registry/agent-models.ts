import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { parseAgentMarkdown } from "./agent-markdown.js";
import { validateName } from "./paths.js";
import type { RegistryUiItem } from "./model.js";

const OVERRIDES_FILE = "agent-model-overrides.json";
const MAX_BYTES = 64 * 1024;

export function validAgentModelRef(value: unknown): value is string {
	return typeof value === "string" && value.length <= 512
		&& /^[^\s/:]+\/[^\s:]+(?::(?:off|minimal|low|medium|high|xhigh|max))?$/.test(value)
		&& !value.startsWith("pix:");
}

/** Separate project state: never hash, install, or publish this with agent Markdown. */
export async function readAgentModelOverrides(cwd: string): Promise<Record<string, string>> {
	const file = join(cwd, ".pi", OVERRIDES_FILE);
	let stat;
	try { stat = await fs.lstat(file); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw error;
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) {
		throw new Error(`Invalid ${OVERRIDES_FILE}: expected a regular project-local file under 64 KiB`);
	}
	const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.models)
		|| Object.keys(value).some((key) => key !== "version" && key !== "models")) {
		throw new Error(`Invalid ${OVERRIDES_FILE} schema`);
	}
	const models: Record<string, string> = Object.create(null);
	for (const [name, model] of Object.entries(value.models)) {
		validateName(name);
		if (!validAgentModelRef(model)) throw new Error(`Invalid model override for agent ${name}`);
		models[name] = model;
	}
	return models;
}

export async function readAgentModelState(file: string, override?: string): Promise<RegistryUiItem["agentModel"]> {
	const profile = parseAgentMarkdown(await fs.readFile(file, "utf8"), file)?.frontmatter;
	if (!profile || profile.modelSelection === "frontier") return undefined;
	const branchModels = isRecord(profile.modelByParent)
		? Object.values(profile.modelByParent).map((entry) => typeof entry === "string" ? entry : isRecord(entry) ? entry.model : undefined)
		: [];
	const original = (Array.isArray(profile.models) ? profile.models[0] : undefined) ?? profile.model ?? branchModels[0];
	if (typeof original !== "string" || !original.trim()) return undefined;
	return { original: original.trim(), parentAware: branchModels.length > 0, ...(override ? { override } : {}) };
}

/** Caller holds the Registry operation lock; atomic replacement gives launch readers a complete version. */
export async function setAgentModelOverride(cwd: string, name: string, model?: string): Promise<void> {
	validateName(name);
	if (model !== undefined && !validAgentModelRef(model)) throw new Error("Expected a provider/model reference");
	const directory = join(cwd, ".pi");
	const agent = join(directory, "agents", `${name}.md`);
	const stat = await fs.lstat(agent);
	if (!stat.isFile() || stat.isSymbolicLink() || !await readAgentModelState(agent)) {
		throw new Error(`Agent ${name} must be installed with an explicit model profile`);
	}
	const models = await readAgentModelOverrides(cwd);
	if (model === undefined) delete models[name];
	else models[name] = model;
	const source = JSON.stringify({ version: 1, models }, null, 2) + "\n";
	if (Buffer.byteLength(source) > MAX_BYTES) throw new Error("Agent model overrides exceed 64 KiB");
	const file = join(directory, OVERRIDES_FILE);
	const temporary = join(directory, `.${OVERRIDES_FILE}.${randomUUID()}.tmp`);
	try {
		await fs.writeFile(temporary, source, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await fs.rename(temporary, file);
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
