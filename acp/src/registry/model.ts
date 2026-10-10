

export const PROJECT_DIR = ".pi";

export const PROJECT_SKILLS_DIR = "skills";

export const PROJECT_AGENTS_DIR = "agents";

export const REGISTRY_SKILLS_DIR = "skills";

export const REGISTRY_AGENTS_DIR = "agents";

export const REGISTRY_PROJECTS_DIR = "projects";

export const SKILL_FILE = "SKILL.md";

export const PROJECT_TASKS_FILE = "tasks.sqlite";

export const PROJECT_TASK_ATTACHMENTS_DIR = "task-attachments";

export const PROJECT_PLANS_DIR = "plans";

export const PROJECT_TODO_FILE = "TODO.md";

export const PROJECT_WORKSPACE_FILE = "workspace.jsonc";

export const REGISTRY_TASK_ATTACHMENT_SCHEME = "pix-task-attachment:";

export const PROVENANCE_FILE = "registry.json";

export const PROVENANCE_VERSION = 1;

export const DESC_MAX = 90;

export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export const SKIP_NAMES = new Set([".DS_Store"]);

/** Registry payloads contain authored project content, never generated scratch.
 * Keep this identical to Desktop's native Registry indicator filter.
 * A skill/agent package itself is canonical; only its non-service entries count.
 */
const SERVICE_DIRECTORIES = new Set(["node_modules", "__pycache__", "artifacts", "cache", "tmp", "temp", "coverage", "build", "dist", "out", "target", "venv"]);
const SERVICE_FILENAMES = new Set(["thumbs.db", "desktop.ini"]);

export function canonicalRegistryEntryName(name: string): boolean {
	return Boolean(name)
		&& !name.startsWith(".")
		&& !name.endsWith("~")
		&& !/\.(?:tmp|temp|bak|backup|lock|swp|swo|orig|log|pid|pyc|pyo)$/i.test(name)
		&& !/-(?:wal|shm|journal)$/i.test(name)
		&& !SERVICE_FILENAMES.has(name.toLowerCase())
		&& !SERVICE_DIRECTORIES.has(name.toLowerCase());
}

/** Plans are the Markdown documents exposed in the Desktop plan manager. */
export function canonicalPlanFileName(name: string): boolean {
	return canonicalRegistryEntryName(name) && name.toLowerCase().endsWith(".md");
}

export type ResourceType = "skill" | "agent";
export type PublicationScope = "global" | "project";

export type ResourceScope = ResourceType | "all";

export type ProjectArtifact = "tasks" | "plans" | "todo" | "workspace";

export type ProjectScope = ProjectArtifact | "project";

export type RegistryAction = "install" | "push" | "pull" | "remove" | "uninstall" | "status" | "update" | "configure" | "remote" | "project-key" | "make-local" | "tags";

export type ResourceEntry = {
	type: ResourceType;
	name: string;
	path: string;
	description: string;
	tags: string[];
	publicationScope?: PublicationScope;
	projectKey?: string;
};

export type ProvenanceEntry = {
	type: ResourceType;
	name: string;
	remote: string;
	branch: string;
	revision: string;
	hash: string;
	publicationScope?: PublicationScope;
	projectKey?: string;
};

export type Provenance = {
	version: 1;
	resources: Record<string, ProvenanceEntry>;
	projectResources: Partial<Record<ProjectArtifact, ProjectProvenanceEntry>>;
};

export type ProjectProvenanceEntry = {
	artifact: ProjectArtifact;
	projectKey: string;
	remote: string;
	branch: string;
	revision: string;
	hash: string;
};

export type RegistryStatusKind =
	| "up-to-date"
	| "update-available"
	| "local-changes"
	| "diverged"
	| "not-installed"
	| "local-only"
	| "untracked-local"
	| "missing-local"
	| "removed-remote"
	| "registry-changed";

export type RegistryStatus = {
	type: ResourceType;
	name: string;
	kind: RegistryStatusKind;
	local?: ResourceEntry | undefined;
	remote?: ResourceEntry | undefined;
	provenance?: ProvenanceEntry;
	remoteRevision?: string | undefined;
};

export type RegistryRuntime = {
	remote: string;
	branch: string;
	cacheDir: string;
	projectKey?: string;
	publicationScope?: PublicationScope;
};

export type ProjectArtifactStatus = {
	artifact: ProjectArtifact;
	kind: RegistryStatusKind;
	localExists: boolean;
	remoteExists: boolean;
	provenance?: ProjectProvenanceEntry;
	remoteRevision?: string | undefined;
};

export type ProjectStatusBundle = {
	projectKey?: string;
	statuses: ProjectArtifactStatus[];
	issue?: string;
};

export type RegistryUiAction = "install" | "update" | "push" | "pull" | "uninstall" | "remove" | "make-local" | "tags" | "toggle-scope";

export interface RegistryUiItem {
	readonly id: string;
	readonly type: ResourceType | "project";
	readonly name: string;
	readonly artifact?: ProjectArtifact;
	readonly status: RegistryStatusKind;
	readonly statusLabel: string;
	readonly icon: string;
	readonly description?: string | undefined;
	readonly tags?: readonly string[];
	readonly local: boolean;
	readonly remote: boolean;
	readonly publicationScope?: PublicationScope;
	readonly actions: readonly RegistryUiAction[];
}

export interface RegistryUiSnapshot {
	readonly version: 1;
	readonly configured: boolean;
	readonly remote?: string;
	readonly branch: string;
	readonly projectKey?: string;
	readonly projectIssue?: string;
	readonly items: readonly RegistryUiItem[];
	readonly checkedAt: string;
	readonly error?: string;
}
