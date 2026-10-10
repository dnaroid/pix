import { RegistryExecutor } from "./context.js";
import { ProjectContext, hasTrackableFiles, pathExists, projectArtifactDisplayName, projectArtifactLocalPath, projectArtifactRegistryPath, projectCwd, resourceKey } from "./paths.js";
import { ProjectArtifact, ProjectArtifactStatus, ProjectScope, ProjectStatusBundle, RegistryRuntime, RegistryStatus, RegistryStatusKind, RegistryUiAction, RegistryUiItem, RegistryUiSnapshot } from "./model.js";
import { hashResource, scanProject, scanRegistry } from "./resource-files.js";
import { readProvenance } from "./provenance.js";
import { ensureRegistryCache, projectArtifactRevision, resolveProjectKey, resourceRevision } from "./git.js";
import { hashProjectArtifactLocal } from "./task-bundle.js";
import { loadRegistryConfig } from "./config-reader.js";
import { loadRuntimeConfig } from "./config.js";
import { resolvePublicationProjectKey, samePublication } from "./publication-location.js";
import { localTasksExist } from "./task-database.js";

export async function collectStatuses(executor: RegistryExecutor, project: ProjectContext, runtime: RegistryRuntime): Promise<RegistryStatus[]> {
	const projectKey = await resolvePublicationProjectKey(executor, project);
	runtime = { ...runtime, ...(projectKey ? { projectKey } : {}) };
	const [remoteResources, localResources, provenance] = await Promise.all([
		scanRegistry(runtime),
		scanProject(project),
		readProvenance(project),
	]);
	const remoteMap = new Map(remoteResources.map((entry) => [resourceKey(entry.type, entry.name), entry]));
	const localMap = new Map(localResources.map((entry) => [resourceKey(entry.type, entry.name), entry]));
	const keys = new Set([...remoteMap.keys(), ...localMap.keys(), ...Object.keys(provenance.resources)]);
	const statuses: RegistryStatus[] = [];

	for (const key of [...keys].sort()) {
		const remote = remoteMap.get(key);
		const local = localMap.get(key);
		const tracked = provenance.resources[key];
		const type = remote?.type ?? local?.type ?? tracked?.type;
		const name = remote?.name ?? local?.name ?? tracked?.name;
		if (!type || !name) continue;

		const resourceRuntime: RegistryRuntime = { ...runtime, publicationScope: remote?.publicationScope ?? tracked?.publicationScope ?? "global" };
		if (tracked && !samePublication(tracked, resourceRuntime)) {
			statuses.push({ type, name, kind: "registry-changed", local, remote, provenance: tracked });
			continue;
		}

		if (!local && !tracked) {
			statuses.push({ type, name, kind: "not-installed", remote });
			continue;
		}
		if (local && !tracked) {
			statuses.push({ type, name, kind: remote ? "untracked-local" : "local-only", local, remote });
			continue;
		}
		if (tracked && !local) {
			statuses.push({ type, name, kind: remote ? "missing-local" : "removed-remote", remote, provenance: tracked });
			continue;
		}
		if (!tracked || !local) continue;
		if (!remote) {
			statuses.push({ type, name, kind: "removed-remote", local, provenance: tracked });
			continue;
		}

		const [localHash, remoteRevision] = await Promise.all([
			hashResource(type, local.path),
			resourceRevision(executor, resourceRuntime, type, name),
		]);
		const localChanged = localHash !== tracked.hash;
		const remoteChanged = remoteRevision !== tracked.revision;
		const kind: RegistryStatusKind = localChanged && remoteChanged
			? "diverged"
			: localChanged
				? "local-changes"
				: remoteChanged
					? "update-available"
					: "up-to-date";
		statuses.push({ type, name, kind, local, remote, provenance: tracked, remoteRevision });
	}

	return statuses;
}

export function projectArtifacts(scope: ProjectScope): ProjectArtifact[] {
	return scope === "project" ? ["tasks", "plans", "todo", "workspace"] : [scope];
}

export async function collectProjectStatuses(
	executor: RegistryExecutor,
	project: ProjectContext,
	runtime: RegistryRuntime,
): Promise<ProjectStatusBundle> {
	const cwd = projectCwd(project);
	let projectKey: string;
	try {
		projectKey = await resolveProjectKey(executor, cwd);
	} catch (error) {
		return { statuses: [], issue: error instanceof Error ? error.message : String(error) };
	}
	const provenance = await readProvenance(cwd);
	const statuses: ProjectArtifactStatus[] = [];
	for (const artifact of ["tasks", "plans", "todo", "workspace"] as const) {
		const localPath = projectArtifactLocalPath(cwd, artifact);
		const remotePath = projectArtifactRegistryPath(runtime.cacheDir, projectKey, artifact);
		const [localPathExists, remoteExists] = await Promise.all([
			artifact === "tasks" ? localTasksExist(cwd) : pathExists(localPath),
			pathExists(remotePath),
		]);
		const tracked = provenance.projectResources[artifact];
		const localExists = localPathExists && (
			artifact !== "plans"
			|| await hasTrackableFiles(localPath)
			|| Boolean(tracked)
		);
		if (!localExists && !remoteExists && !tracked) continue;
		if (tracked && (tracked.remote !== runtime.remote || tracked.branch !== runtime.branch || tracked.projectKey !== projectKey)) {
			statuses.push({ artifact, kind: "registry-changed", localExists, remoteExists, provenance: tracked });
			continue;
		}
		if (!localExists && !tracked) {
			statuses.push({ artifact, kind: "not-installed", localExists, remoteExists });
			continue;
		}
		if (localExists && !tracked) {
			statuses.push({ artifact, kind: remoteExists ? "untracked-local" : "local-only", localExists, remoteExists });
			continue;
		}
		if (tracked && !localExists) {
			statuses.push({ artifact, kind: remoteExists ? "missing-local" : "removed-remote", localExists, remoteExists, provenance: tracked });
			continue;
		}
		if (!tracked || !localExists) continue;
		if (!remoteExists) {
			statuses.push({ artifact, kind: "removed-remote", localExists, remoteExists, provenance: tracked });
			continue;
		}
		const [localHash, remoteRevision] = await Promise.all([
			hashProjectArtifactLocal(cwd, artifact),
			projectArtifactRevision(executor, runtime, projectKey, artifact),
		]);
		const localChanged = localHash !== tracked.hash;
		const remoteChanged = remoteRevision !== tracked.revision;
		const kind: RegistryStatusKind = localChanged && remoteChanged
			? "diverged"
			: localChanged
				? "local-changes"
				: remoteChanged
					? "update-available"
					: "up-to-date";
		statuses.push({ artifact, kind, localExists, remoteExists, provenance: tracked, remoteRevision });
	}
	return { projectKey, statuses };
}

export const STATUS_GROUP_ORDER: readonly RegistryStatusKind[] = [
	"diverged",
	"update-available",
	"local-changes",
	"missing-local",
	"registry-changed",
	"removed-remote",
	"untracked-local",
	"local-only",
	"not-installed",
	"up-to-date",
];

export function registryStatusRank(kind: RegistryStatusKind): number {
	const index = STATUS_GROUP_ORDER.indexOf(kind);
	return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

export function reusableUiActions(status: RegistryStatus, remoteConfigured = true): RegistryUiAction[] {
	const actions: RegistryUiAction[] = [];
	if (remoteConfigured) {
		switch (status.kind) {
			case "not-installed":
				actions.push("install");
				break;
			case "update-available":
			case "missing-local":
				actions.push("update");
				break;
			case "local-changes":
			case "local-only":
			case "untracked-local":
			case "removed-remote":
				actions.push("push");
				break;
			case "up-to-date":
			case "diverged":
			case "registry-changed":
				break;
		}
	}
	if (status.local) actions.push("tags", "uninstall");
	if (remoteConfigured && status.remote) actions.push("toggle-scope", "make-local", "remove");
	return actions;
}

export function projectUiActions(status: ProjectArtifactStatus): RegistryUiAction[] {
	switch (status.kind) {
		case "not-installed":
		case "update-available":
		case "missing-local":
			return ["pull"];
		case "local-changes":
		case "local-only":
		case "removed-remote":
			return ["push"];
		case "untracked-local":
			return status.remoteExists ? ["push", "pull"] : ["push"];
		case "up-to-date":
		case "diverged":
		case "registry-changed":
			return [];
	}
}

function statusIcon(kind: RegistryStatusKind): string {
	switch (kind) {
		case "up-to-date": return "✓";
		case "update-available": return "↓";
		case "local-changes": return "↑";
		case "diverged": return "↕";
		case "not-installed": return "·";
		case "local-only": return "+";
		case "untracked-local": return "?";
		case "missing-local": return "!";
		case "removed-remote": return "×";
		case "registry-changed": return "!";
	}
}

function statusLabel(kind: RegistryStatusKind): string {
	switch (kind) {
		case "up-to-date": return "UP TO DATE";
		case "update-available": return "OUTDATED";
		case "local-changes": return "LOCAL CHANGES";
		case "diverged": return "CONFLICT";
		case "not-installed": return "NOT INSTALLED";
		case "local-only": return "LOCAL ONLY";
		case "untracked-local": return "UNTRACKED LOCAL";
		case "missing-local": return "MISSING LOCALLY";
		case "removed-remote": return "REMOVED FROM REGISTRY";
		case "registry-changed": return "OTHER REGISTRY";
	}
}

export function registryUiItems(
	statuses: RegistryStatus[],
	projectStatus?: ProjectStatusBundle,
	remoteConfigured = true,
): RegistryUiItem[] {
	const items: RegistryUiItem[] = [
		...statuses.map((status): RegistryUiItem => ({
			id: `${status.type}:${status.name}`,
			type: status.type,
			name: status.name,
			status: status.kind,
			statusLabel: statusLabel(status.kind),
			icon: statusIcon(status.kind),
			...(status.local?.description || status.remote?.description
				? { description: status.local?.description || status.remote?.description }
				: {}),
			local: Boolean(status.local),
			remote: Boolean(status.remote),
			...(status.remote ? { publicationScope: status.remote.publicationScope ?? "global" } : {}),
			tags: (status.local ?? status.remote)?.tags ?? [],
			actions: reusableUiActions(status, remoteConfigured),
		})),
		...(projectStatus?.statuses ?? []).map((status): RegistryUiItem => ({
			id: `project:${status.artifact}`,
			type: "project",
			name: projectArtifactDisplayName(status.artifact),
			artifact: status.artifact,
			status: status.kind,
			statusLabel: statusLabel(status.kind),
			icon: statusIcon(status.kind),
			local: status.localExists,
			remote: status.remoteExists,
			actions: projectUiActions(status),
		})),
	];
	return items.sort((left, right) => {
		const byStatus = registryStatusRank(left.status) - registryStatusRank(right.status);
		if (byStatus !== 0) return byStatus;
		const byName = left.name.localeCompare(right.name);
		return byName !== 0 ? byName : left.id.localeCompare(right.id);
	});
}

export async function collectLocalRegistryStatuses(project: ProjectContext): Promise<RegistryStatus[]> {
	return (await scanProject(project)).map((local) => ({
		type: local.type,
		name: local.name,
		kind: "local-only",
		local,
	}));
}

export async function collectRegistryUiSnapshot(
	executor: RegistryExecutor,
	project: ProjectContext,
	error?: string,
): Promise<RegistryUiSnapshot> {
	const cwd = projectCwd(project);
	const config = loadRegistryConfig(cwd);
	const checkedAt = new Date().toISOString();
	if (!config.remote) {
		const statuses = await collectLocalRegistryStatuses(cwd);
		return {
			version: 1,
			configured: false,
			branch: config.branch,
			items: registryUiItems(statuses, undefined, false),
			checkedAt,
			...(error ? { error } : {}),
		};
	}
	const runtime = loadRuntimeConfig(cwd);
	await ensureRegistryCache(executor, runtime);
	const [statuses, projectStatus] = await Promise.all([
		collectStatuses(executor, cwd, runtime),
		collectProjectStatuses(executor, cwd, runtime),
	]);
	// A missing project key only disables project-scoped artifacts, not resources.
	const snapshotError = error && error !== projectStatus.issue ? error : undefined;
	return {
		version: 1,
		configured: true,
		remote: runtime.remote,
		branch: runtime.branch,
		...(projectStatus.projectKey ? { projectKey: projectStatus.projectKey } : {}),
		...(projectStatus.issue ? { projectIssue: projectStatus.issue } : {}),
		items: registryUiItems(statuses, projectStatus),
		checkedAt,
		...(snapshotError ? { error: snapshotError } : {}),
	};
}
