import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { ProjectArtifact, REGISTRY_TASK_ATTACHMENT_SCHEME, RegistryRuntime } from "./model.js";
import { pathExists, projectArtifactLocalPath, projectArtifactRegistryPath, projectTaskAttachmentsLocalPath, projectTaskAttachmentsRegistryPath } from "./paths.js";
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { hashPath } from "./resource-files.js";

export type TaskBundle = {
	source: string;
	attachments: Map<string, string>;
};

export function pathIsWithin(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function registryTaskAttachmentMarker(name: string): string {
	return `[Pix attachment: ${REGISTRY_TASK_ATTACHMENT_SCHEME}${encodeURIComponent(name)}]`;
}

export function registryTaskAttachmentName(encoded: string): string {
	let name: string;
	try {
		name = decodeURIComponent(encoded);
	} catch {
		throw new Error(`Invalid registry task attachment name: ${encoded}`);
	}
	if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || basename(name) !== name) {
		throw new Error(`Invalid registry task attachment name: ${encoded}`);
	}
	return name;
}

export async function readLocalTaskBundle(cwd: string): Promise<TaskBundle> {
	const tasksPath = projectArtifactLocalPath(cwd, "tasks");
	const source = await fs.readFile(tasksPath, "utf8");
	const attachmentsRoot = projectTaskAttachmentsLocalPath(cwd);
	const attachments = new Map<string, string>();
	const replacements = new Map<string, string>();
	const rootExists = await pathExists(attachmentsRoot);
	let canonicalRoot: string | undefined;
	if (rootExists) {
		const rootStat = await fs.lstat(attachmentsRoot);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
			throw new Error(`Project task attachment storage must be a regular directory: ${attachmentsRoot}`);
		}
		const [canonicalCwd, resolvedRoot] = await Promise.all([
			fs.realpath(cwd),
			fs.realpath(attachmentsRoot),
		]);
		if (!pathIsWithin(canonicalCwd, resolvedRoot)) {
			throw new Error(`Project task attachment storage resolves outside the project: ${attachmentsRoot}`);
		}
		canonicalRoot = resolvedRoot;
	}

	for (const match of source.matchAll(/\[Pix attachment: (file:\/\/[^\]]+)\]/g)) {
		const marker = match[0];
		const uri = match[1];
		if (!uri || replacements.has(marker)) continue;
		let candidate: string;
		try {
			candidate = fileURLToPath(uri);
		} catch {
			continue;
		}
		if (!canonicalRoot) continue;
		const lexicalProjectAttachment = pathIsWithin(attachmentsRoot, candidate);

		let canonicalFile: string;
		try {
			canonicalFile = await fs.realpath(candidate);
		} catch (error) {
			if (lexicalProjectAttachment) {
				throw new Error(`Task attachment is missing: ${candidate}. ${error instanceof Error ? error.message : String(error)}`);
			}
			continue;
		}
		if (!pathIsWithin(canonicalRoot, canonicalFile)) {
			if (lexicalProjectAttachment) throw new Error(`Task attachment resolves outside project task storage: ${candidate}`);
			continue;
		}
		const stat = await fs.lstat(candidate);
		if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Task attachment is not a regular file: ${candidate}`);
		const name = basename(canonicalFile);
		const previous = attachments.get(name);
		if (previous && previous !== canonicalFile) {
			throw new Error(`Task attachments contain duplicate file name "${name}".`);
		}
		attachments.set(name, canonicalFile);
		replacements.set(marker, registryTaskAttachmentMarker(name));
	}

	let normalizedSource = source;
	for (const [marker, portableMarker] of replacements) {
		normalizedSource = normalizedSource.split(marker).join(portableMarker);
	}
	return { source: normalizedSource, attachments };
}

export async function readRemoteTaskBundle(runtime: RegistryRuntime, projectKey: string): Promise<TaskBundle> {
	const tasksPath = projectArtifactRegistryPath(runtime.cacheDir, projectKey, "tasks");
	const source = await fs.readFile(tasksPath, "utf8");
	const attachmentsRoot = projectTaskAttachmentsRegistryPath(runtime.cacheDir, projectKey);
	const attachments = new Map<string, string>();
	for (const match of source.matchAll(/\[Pix attachment: pix-task-attachment:([^\]]+)\]/g)) {
		const encoded = match[1];
		if (!encoded) continue;
		const name = registryTaskAttachmentName(encoded);
		if (attachments.has(name)) continue;
		const filePath = join(attachmentsRoot, name);
		let stat: import("node:fs").Stats;
		try {
			stat = await fs.lstat(filePath);
		} catch (error) {
			throw new Error(`Registry task attachment is missing: ${name}. ${error instanceof Error ? error.message : String(error)}`);
		}
		if (stat.isSymbolicLink() || !stat.isFile()) {
			throw new Error(`Registry task attachment is not a regular file: ${name}`);
		}
		attachments.set(name, filePath);
	}
	return { source, attachments };
}

export async function hashTaskBundle(bundle: TaskBundle): Promise<string> {
	const hash = createHash("sha256");
	hash.update("tasks-bundle\0");
	hash.update(bundle.source);
	for (const name of [...bundle.attachments.keys()].sort()) {
		hash.update(`\0attachment\0${name}\0`);
		hash.update(await fs.readFile(bundle.attachments.get(name)!));
	}
	return hash.digest("hex");
}

export async function hashProjectArtifactLocal(cwd: string, artifact: ProjectArtifact): Promise<string> {
	return artifact === "tasks"
		? hashTaskBundle(await readLocalTaskBundle(cwd))
		: hashPath(projectArtifactLocalPath(cwd, artifact));
}

export async function hashProjectArtifactRemote(
	runtime: RegistryRuntime,
	projectKey: string,
	artifact: ProjectArtifact,
): Promise<string> {
	return artifact === "tasks"
		? hashTaskBundle(await readRemoteTaskBundle(runtime, projectKey))
		: hashPath(projectArtifactRegistryPath(runtime.cacheDir, projectKey, artifact));
}

export async function replaceRemoteTaskBundle(cwd: string, runtime: RegistryRuntime, projectKey: string): Promise<void> {
	const bundle = await readLocalTaskBundle(cwd);
	const tasksPath = projectArtifactRegistryPath(runtime.cacheDir, projectKey, "tasks");
	const attachmentsPath = projectTaskAttachmentsRegistryPath(runtime.cacheDir, projectKey);
	await fs.rm(tasksPath, { recursive: true, force: true });
	await fs.rm(attachmentsPath, { recursive: true, force: true });
	await fs.mkdir(dirname(tasksPath), { recursive: true });
	await fs.writeFile(tasksPath, bundle.source, "utf8");
	if (bundle.attachments.size === 0) return;
	await fs.mkdir(attachmentsPath, { recursive: true });
	for (const name of [...bundle.attachments.keys()].sort()) {
		await fs.copyFile(bundle.attachments.get(name)!, join(attachmentsPath, name));
	}
}

export async function replaceLocalTaskBundle(cwd: string, runtime: RegistryRuntime, projectKey: string): Promise<void> {
	const bundle = await readRemoteTaskBundle(runtime, projectKey);
	const tasksPath = projectArtifactLocalPath(cwd, "tasks");
	const attachmentsPath = projectTaskAttachmentsLocalPath(cwd);
	await fs.mkdir(dirname(tasksPath), { recursive: true });

	let materializedSource = bundle.source;
	for (const name of bundle.attachments.keys()) {
		materializedSource = materializedSource
			.split(registryTaskAttachmentMarker(name))
			.join(`[Pix attachment: ${pathToFileURL(join(attachmentsPath, name)).href}]`);
	}

	const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	const stagedTasks = join(dirname(tasksPath), `.tasks.registry-${stamp}.tmp`);
	const stagedAttachments = join(dirname(tasksPath), `.task-attachments.registry-${stamp}.tmp`);
	const backupTasks = join(dirname(tasksPath), `.tasks.registry-${stamp}.bak`);
	const backupAttachments = join(dirname(tasksPath), `.task-attachments.registry-${stamp}.bak`);
	let tasksBackedUp = false;
	let attachmentsBackedUp = false;
	let tasksInstalled = false;
	let attachmentsInstalled = false;
	try {
		await fs.writeFile(stagedTasks, materializedSource, "utf8");
		if (bundle.attachments.size > 0) {
			await fs.mkdir(stagedAttachments, { recursive: true });
			for (const name of [...bundle.attachments.keys()].sort()) {
				await fs.copyFile(bundle.attachments.get(name)!, join(stagedAttachments, name));
			}
		}

		if (await pathExists(tasksPath)) {
			await fs.rename(tasksPath, backupTasks);
			tasksBackedUp = true;
		}
		if (await pathExists(attachmentsPath)) {
			await fs.rename(attachmentsPath, backupAttachments);
			attachmentsBackedUp = true;
		}
		if (bundle.attachments.size > 0) {
			await fs.rename(stagedAttachments, attachmentsPath);
			attachmentsInstalled = true;
		}
		await fs.rename(stagedTasks, tasksPath);
		tasksInstalled = true;
	} catch (error) {
		if (tasksInstalled) await fs.rm(tasksPath, { recursive: true, force: true }).catch(() => undefined);
		if (attachmentsInstalled) await fs.rm(attachmentsPath, { recursive: true, force: true }).catch(() => undefined);
		if (tasksBackedUp) await fs.rename(backupTasks, tasksPath).catch(() => undefined);
		if (attachmentsBackedUp) await fs.rename(backupAttachments, attachmentsPath).catch(() => undefined);
		throw error;
	} finally {
		await fs.rm(stagedTasks, { recursive: true, force: true }).catch(() => undefined);
		await fs.rm(stagedAttachments, { recursive: true, force: true }).catch(() => undefined);
	}
	await fs.rm(backupTasks, { recursive: true, force: true }).catch(() => undefined);
	await fs.rm(backupAttachments, { recursive: true, force: true }).catch(() => undefined);
}
