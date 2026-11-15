import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { RegistryContext, RegistryExecutor } from "./context.js";
import { loadRuntimeConfig, saveProjectKeyConfig } from "./config.js";
import { ensureRegistryCache, projectArtifactRevision, resourceRevision, runGit } from "./git.js";
import { REGISTRY_PROJECTS_DIR, type RegistryRuntime } from "./model.js";
import { pathExists, projectKeyFromGitRemote, validateName } from "./paths.js";
import { readProvenance, writeProvenance } from "./provenance.js";
import { resolveProjectKey } from "./git.js";

/** Keys under which this project's current publications are tracked, for the active remote/branch. */
async function trackedKeys(ctx: RegistryContext, runtime: RegistryRuntime): Promise<{ keys: Set<string>; provenance: Awaited<ReturnType<typeof readProvenance>> }> {
	const provenance = await readProvenance(ctx);
	const keys = new Set<string>();
	const entries = [
		...Object.values(provenance.projectResources),
		...Object.values(provenance.resources).filter((entry) => entry.publicationScope === "project"),
	];
	for (const entry of entries) {
		if (!entry?.projectKey) continue;
		if (entry.remote !== runtime.remote || entry.branch !== runtime.branch) {
			throw new Error("Tracked state belongs to a different registry remote/branch; resolve it manually.");
		}
		keys.add(entry.projectKey);
	}
	return { keys, provenance };
}

function singleKey(keys: Set<string>): string {
	if (keys.size !== 1) throw new Error(keys.size === 0 ? "No tracked project key to keep." : "Project state is tracked under several keys; resolve it manually.");
	return [...keys][0]!;
}

/** Pin the project to the key its publications already use. */
export async function keepProjectKey(ctx: RegistryContext): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	const { keys } = await trackedKeys(ctx, runtime);
	await saveProjectKeyConfig(ctx.cwd, singleKey(keys));
}

/** Move published project state to the key derived from Git origin; the caller holds the cache lock. */
export async function migrateProjectKey(executor: RegistryExecutor, ctx: RegistryContext): Promise<void> {
	const runtime = loadRuntimeConfig(ctx.cwd);
	await ensureRegistryCache(executor, runtime);
	const origin = (await runGit(executor, ctx.cwd, ["remote", "get-url", "origin"], { allowFailure: true })).stdout.trim();
	const target = projectKeyFromGitRemote(origin);
	if (!target) throw new Error("Git origin is not configured; there is no key to migrate to.");
	validateName(target);
	const { keys, provenance } = await trackedKeys(ctx, runtime);
	const previous = singleKey(keys);
	if (previous === target) throw new Error("Project state already uses the Git origin key.");

	const oldDir = join(runtime.cacheDir, REGISTRY_PROJECTS_DIR, previous);
	const newDir = join(runtime.cacheDir, REGISTRY_PROJECTS_DIR, target);
	if (!await pathExists(oldDir)) throw new Error(`Registry has no state under ${previous}.`);
	if (await pathExists(newDir)) throw new Error(`Registry already has state under ${target}; resolve it before migrating.`);
	await fs.mkdir(dirname(newDir), { recursive: true });
	await fs.rename(oldDir, newDir);
	const oldRel = `${REGISTRY_PROJECTS_DIR}/${previous}`;
	const newRel = `${REGISTRY_PROJECTS_DIR}/${target}`;
	await runGit(executor, runtime.cacheDir, ["add", "-A", "--", oldRel, newRel]);
	await runGit(executor, runtime.cacheDir, ["commit", "-m", `Migrate project key ${previous} to ${target}`, "--", oldRel, newRel]);
	try {
		await runGit(executor, runtime.cacheDir, ["push", "-u", "origin", runtime.branch], { timeout: 180_000 });
	} catch (error) {
		throw new Error(`Migration commit was created in the disposable cache but push failed; local .pi state is unchanged. ${error instanceof Error ? error.message : String(error)}`);
	}

	// Registry content is identical, so hashes stay; only key and revision change.
	const scoped: RegistryRuntime = { ...runtime, publicationScope: "project", projectKey: target };
	for (const [artifact, entry] of Object.entries(provenance.projectResources)) {
		if (!entry) continue;
		const revision = await projectArtifactRevision(executor, runtime, target, entry.artifact);
		if (!revision) throw new Error(`Cannot determine registry revision for migrated ${artifact} state.`);
		provenance.projectResources[entry.artifact] = { ...entry, projectKey: target, revision };
	}
	for (const entry of Object.values(provenance.resources)) {
		if (entry.publicationScope !== "project" || entry.projectKey !== previous) continue;
		const revision = await resourceRevision(executor, scoped, entry.type, entry.name);
		if (!revision) throw new Error(`Cannot determine registry revision for migrated ${entry.type} ${entry.name}.`);
		entry.projectKey = target;
		entry.revision = revision;
	}
	await writeProvenance(ctx, provenance);
	// Let the Git-origin key take effect (an explicit override would win over it).
	await saveProjectKeyConfig(ctx.cwd, undefined);
	if (await resolveProjectKey(executor, ctx.cwd) !== target) {
		throw new Error(`Migrated to ${target}, but an explicit project key override from another config still applies.`);
	}
}
