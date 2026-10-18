import { ProjectContext, resourceKey } from "./paths.js";
import { LEGACY_PROVENANCE_FILE, PROVENANCE_VERSION, REGISTRY_SCHEMA_URL, ProjectArtifact, Provenance, RegistryRuntime, ResourceEntry, ResourceType } from "./model.js";
import { promises as fs } from "node:fs";
import { provenancePath } from "./config.js";
import { RegistryContext } from "./context.js";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { acpFileLogger } from "../logging.js";

async function readDocument(project: ProjectContext): Promise<{ source: string; path: string; provenance: Provenance }> {
	const canonical = provenancePath(project);
	for (const path of [canonical, join(dirname(canonical), LEGACY_PROVENANCE_FILE)]) {
		let source: string;
		try {
			source = await fs.readFile(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const errors: ParseError[] = [];
		const parsed: unknown = parse(source, errors, { allowTrailingComma: true });
		if (errors.length || !isRecord(parsed) || parsed.version !== PROVENANCE_VERSION
			|| !isRecord(parsed.resources)
			|| (parsed.projectResources !== undefined && !isRecord(parsed.projectResources))) {
			throw new Error(`Invalid Registry provenance in ${path}; fix it before syncing.`);
		}
		return { source, path, provenance: {
			version: PROVENANCE_VERSION,
			resources: parsed.resources as Provenance["resources"],
			projectResources: (parsed.projectResources ?? {}) as Provenance["projectResources"],
		} };
	}
	return { source: "{}\n", path: canonical, provenance: { version: PROVENANCE_VERSION, resources: {}, projectResources: {} } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readProvenance(project: ProjectContext): Promise<Provenance> {
	return (await readDocument(project)).provenance;
}

/** Caller holds the Registry operation lock. Publish complete JSONC before removing legacy state. */
export async function writeProvenance(ctx: RegistryContext, provenance: Provenance): Promise<void> {
	const filePath = provenancePath(ctx);
	const document = await readDocument(ctx);
	let source = document.source;
	const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" };
	const set = (path: string[], value: unknown): void => {
		source = applyEdits(source, modify(source, path, value, { formattingOptions }));
	};
	if (parse(source).$schema === undefined) set(["$schema"], REGISTRY_SCHEMA_URL);
	set(["version"], PROVENANCE_VERSION);
	for (const field of ["resources", "projectResources"] as const) {
		const before: Readonly<Record<string, unknown>> = document.provenance[field];
		const after: Readonly<Record<string, unknown>> = provenance[field];
		if (parse(source)[field] === undefined) set([field], {});
		for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
			if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
				set([field, key], after[key]);
			}
		}
	}
	await fs.mkdir(dirname(filePath), { recursive: true });
	const temporary = join(dirname(filePath), `.registry.jsonc.${randomUUID()}.tmp`);
	try {
		await fs.writeFile(temporary, source.endsWith("\n") ? source : `${source}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		if (document.path !== filePath) {
			// Never overwrite a canonical file created while reading the legacy document.
			await fs.link(temporary, filePath);
			try {
				if (await fs.readFile(document.path, "utf8") === document.source) await fs.unlink(document.path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					// Canonical state is committed; a legacy backup must not turn success into failure.
					try {
						await acpFileLogger.log("warn", "registry:legacy-cleanup-failed", { code: (error as NodeJS.ErrnoException).code });
					} catch { /* Diagnostics never change the committed operation. */ }
				}
			}
		} else {
			await fs.rename(temporary, filePath);
		}
	} finally {
		await fs.rm(temporary, { force: true });
	}
}

export async function recordProvenance(
	ctx: RegistryContext,
	runtime: RegistryRuntime,
	type: ResourceType,
	name: string,
	revision: string,
	hash: string,
): Promise<void> {
	const provenance = await readProvenance(ctx);
	provenance.resources[resourceKey(type, name)] = {
		type,
		name,
		remote: runtime.remote,
		branch: runtime.branch,
		revision,
		hash,
		publicationScope: runtime.publicationScope ?? "global",
		...(runtime.publicationScope === "project" && runtime.projectKey ? { projectKey: runtime.projectKey } : {}),
	};
	await writeProvenance(ctx, provenance);
}

export async function clearResourceProvenance(ctx: RegistryContext, type: ResourceType, name: string): Promise<void> {
	const provenance = await readProvenance(ctx);
	const key = resourceKey(type, name);
	if (!(key in provenance.resources)) return;
	delete provenance.resources[key];
	await writeProvenance(ctx, provenance);
}

export async function clearResourceProvenanceEntries(ctx: RegistryContext, entries: ResourceEntry[]): Promise<void> {
	const provenance = await readProvenance(ctx);
	let changed = false;
	for (const entry of entries) {
		const key = resourceKey(entry.type, entry.name);
		if (!(key in provenance.resources)) continue;
		delete provenance.resources[key];
		changed = true;
	}
	if (changed) await writeProvenance(ctx, provenance);
}

export async function clearProjectProvenanceEntries(ctx: RegistryContext, artifacts: ProjectArtifact[]): Promise<void> {
	if (artifacts.length === 0) return;
	const provenance = await readProvenance(ctx);
	let changed = false;
	for (const artifact of artifacts) {
		if (!(artifact in provenance.projectResources)) continue;
		delete provenance.projectResources[artifact];
		changed = true;
	}
	if (changed) await writeProvenance(ctx, provenance);
}

export async function recordProjectProvenance(
	ctx: RegistryContext,
	runtime: RegistryRuntime,
	projectKey: string,
	artifact: ProjectArtifact,
	revision: string,
	hash: string,
): Promise<void> {
	const provenance = await readProvenance(ctx);
	provenance.projectResources[artifact] = {
		artifact,
		projectKey,
		remote: runtime.remote,
		branch: runtime.branch,
		revision,
		hash,
	};
	await writeProvenance(ctx, provenance);
}
