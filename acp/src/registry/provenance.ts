import { ProjectContext, resourceKey } from "./paths.js";
import { PROVENANCE_VERSION, ProjectArtifact, Provenance, RegistryRuntime, ResourceEntry, ResourceType } from "./model.js";
import { promises as fs } from "node:fs";
import { provenancePath } from "./config.js";
import { RegistryContext } from "./context.js";
import { dirname } from "node:path";

export async function readProvenance(project: ProjectContext): Promise<Provenance> {
	try {
		const parsed = JSON.parse(await fs.readFile(provenancePath(project), "utf8")) as Partial<Provenance>;
		if (parsed.version !== PROVENANCE_VERSION || !parsed.resources || typeof parsed.resources !== "object") {
			return { version: PROVENANCE_VERSION, resources: {}, projectResources: {} };
		}
		return {
			version: PROVENANCE_VERSION,
			resources: parsed.resources,
			projectResources: parsed.projectResources && typeof parsed.projectResources === "object" ? parsed.projectResources : {},
		};
	} catch {
		return { version: PROVENANCE_VERSION, resources: {}, projectResources: {} };
	}
}

export async function writeProvenance(ctx: RegistryContext, provenance: Provenance): Promise<void> {
	const filePath = provenancePath(ctx);
	await fs.mkdir(dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
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
