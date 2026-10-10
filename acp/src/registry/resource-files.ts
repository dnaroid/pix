import { basename, dirname, join } from "node:path";
import { promises as fs } from "node:fs";
import { parseAgentMarkdown } from "./agent-markdown.js";
import { PROJECT_AGENTS_DIR, PROJECT_DIR, PROJECT_SKILLS_DIR, REGISTRY_AGENTS_DIR, REGISTRY_SKILLS_DIR, RegistryRuntime, ResourceEntry, ResourceType, SAFE_NAME, SKILL_FILE, canonicalPlanFileName, canonicalRegistryEntryName } from "./model.js";
import { ProjectContext, hasTrackableFiles, pathExists, projectCwd, registryResourceRelativePath, registryResourceNamespace } from "./paths.js";
import { assertPublicationDirectories } from "./publication-location.js";
import { readResourceTagsFile } from "./metadata.js";
import { createHash } from "node:crypto";
import { RegistryExecutor } from "./context.js";
import { runGit } from "./git.js";

export function parseFrontmatterDescription(content: string): string {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return "";
	const lines = (match[1] ?? "").split(/\r?\n/);
	const idx = lines.findIndex((line) => /^\s*description:\s*/.test(line));
	if (idx === -1) return "";
	const headerLine = lines[idx] ?? "";
	const after = headerLine.replace(/^\s*description:\s*/, "");
	if (/^[>|]/.test(after)) {
		const block: string[] = [];
		for (let i = idx + 1; i < lines.length; i += 1) {
			const line = lines[i] ?? "";
			if (line === "") {
				block.push(" ");
				continue;
			}
			if (/^\s+/.test(line)) {
				block.push(line.replace(/^\s+/, ""));
				continue;
			}
			break;
		}
		return block.join(" ").trim();
	}
	let value = after.trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
	return value;
}

export async function readDescription(path: string): Promise<string> {
	try {
		return parseFrontmatterDescription(await fs.readFile(path, "utf8"));
	} catch {
		return "";
	}
}

export async function validAgentDefinition(path: string, name: string): Promise<boolean> {
	try {
		const parsed = parseAgentMarkdown(await fs.readFile(path, "utf8"), path);
		if (!parsed) return false;
		const declaredName = parsed.frontmatter.name;
		return declaredName === undefined || declaredName === name;
	} catch {
		return false;
	}
}

export async function assertValidAgentDefinition(path: string, name: string): Promise<void> {
	if (!(await validAgentDefinition(path, name))) {
		throw new Error(`Agent "${name}" must be a valid .pi/agents Markdown definition with YAML frontmatter matching its filename.`);
	}
}

export async function scanSkills(dir: string): Promise<ResourceEntry[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const resources: ResourceEntry[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.isSymbolicLink() || !canonicalRegistryEntryName(entry.name)) continue;
		if (!SAFE_NAME.test(entry.name) || entry.name.includes("..")) continue;
		const skillPath = join(dir, entry.name);
		const skillFile = join(skillPath, SKILL_FILE);
		if (!(await pathExists(skillFile))) continue;
		resources.push({ type: "skill", name: entry.name, path: skillPath, description: await readDescription(skillFile), tags: await readResourceTagsFile(skillFile) });
	}
	return resources.sort((a, b) => a.name.localeCompare(b.name));
}

export async function scanAgents(dir: string): Promise<ResourceEntry[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const resources: ResourceEntry[] = [];
	for (const entry of entries) {
		if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".md") || !canonicalRegistryEntryName(entry.name)) continue;
		const name = basename(entry.name, ".md");
		if (!SAFE_NAME.test(name) || name.includes("..")) continue;
		const filePath = join(dir, entry.name);
		if (!(await validAgentDefinition(filePath, name))) continue;
		resources.push({ type: "agent", name, path: filePath, description: await readDescription(filePath), tags: await readResourceTagsFile(filePath) });
	}
	return resources.sort((a, b) => a.name.localeCompare(b.name));
}

export async function scanRegistry(runtime: RegistryRuntime): Promise<ResourceEntry[]> {
	await assertPublicationDirectories(runtime);
	const global = [
		...(await scanSkills(join(runtime.cacheDir, REGISTRY_SKILLS_DIR))),
		...(await scanAgents(join(runtime.cacheDir, REGISTRY_AGENTS_DIR))),
	].map((entry): ResourceEntry => ({ ...entry, publicationScope: "global" }));
	if (!runtime.projectKey) return global;
	const scopedRuntime: RegistryRuntime = { ...runtime, publicationScope: "project" };
	const root = join(runtime.cacheDir, registryResourceNamespace(scopedRuntime));
	const scoped = [
		...(await scanSkills(join(root, REGISTRY_SKILLS_DIR))),
		...(await scanAgents(join(root, REGISTRY_AGENTS_DIR))),
	].map((entry): ResourceEntry => ({ ...entry, publicationScope: "project", projectKey: runtime.projectKey! }));
	const names = new Set(global.map((entry) => `${entry.type}:${entry.name}`));
	for (const entry of scoped) {
		if (names.has(`${entry.type}:${entry.name}`)) throw new Error(`Publication name collision: ${entry.type} "${entry.name}" exists in both Global and Project scopes. Resolve the collision without overwriting either copy.`);
	}
	return [...global, ...scoped];
}

export async function scanProject(project: ProjectContext): Promise<ResourceEntry[]> {
	const cwd = projectCwd(project);
	return [
		...(await scanSkills(join(cwd, PROJECT_DIR, PROJECT_SKILLS_DIR))),
		...(await scanAgents(join(cwd, PROJECT_DIR, PROJECT_AGENTS_DIR))),
	];
}

/** Empty/generated-only resource folders do not affect the Registry hash.
 * Keep directory decisions consistent across hashing, copying and native polls.
 */
export async function hasCanonicalResourceFiles(path: string): Promise<boolean> {
	const stat = await fs.lstat(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
	for (const entry of await fs.readdir(path, { withFileTypes: true })) {
		if (!canonicalRegistryEntryName(entry.name)) continue;
		if (!entry.isDirectory() || entry.isSymbolicLink() || await hasCanonicalResourceFiles(join(path, entry.name))) return true;
	}
	return false;
}

export async function copyTree(source: string, destination: string, relativePath = "", mode: "resource" | "plans" = "resource"): Promise<void> {
	const stat = await fs.lstat(source);
	if (stat.isSymbolicLink()) throw new Error(`Registry resources cannot contain symbolic links: ${relativePath || source}`);
	if (stat.isFile()) {
		await fs.mkdir(dirname(destination), { recursive: true });
		if (mode === "plans" && await pathExists(destination)) {
			const current = await fs.lstat(destination);
			if (!current.isFile() || current.isSymbolicLink()) throw new Error(`Plan destination must be a regular file: ${destination}`);
		}
		await fs.copyFile(source, destination);
		return;
	}
	if (!stat.isDirectory()) throw new Error(`Unsupported registry resource entry: ${relativePath || source}`);
	await fs.mkdir(destination, { recursive: true });
	if (mode === "plans") {
		const actual = await fs.lstat(destination);
		if (!actual.isDirectory() || actual.isSymbolicLink()) throw new Error(`Plan destination must be a real directory: ${destination}`);
	}
	const entries = (await fs.readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (!canonicalRegistryEntryName(entry.name)) continue;
		if (mode === "resource" && entry.isDirectory() && !(await hasCanonicalResourceFiles(join(source, entry.name)))) continue;
		if (mode === "plans") {
			if (entry.isFile() && !canonicalPlanFileName(entry.name)) continue;
			if (entry.isDirectory() && !(await hasTrackableFiles(join(source, entry.name)))) continue;
			if (entry.isSymbolicLink() && !canonicalPlanFileName(entry.name)) continue;
		}
		const childRel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
		if (entry.isSymbolicLink()) throw new Error(`Registry resources cannot contain symbolic links: ${childRel}`);
		await copyTree(join(source, entry.name), join(destination, entry.name), childRel, mode);
	}
}

export async function replaceResource(source: string, destination: string, mode: "resource" | "plans" = "resource"): Promise<void> {
	await fs.rm(destination, { recursive: true, force: true });
	await copyTree(source, destination, "", mode);
}

/** A plan pull replaces only managed Markdown, retaining local scratch output.
 * In particular, syncing Registry must never delete an untracked backup or
 * tool-owned file merely because it shares the .pi/plans directory.
 */
export async function replaceLocalPlans(source: string, destination: string): Promise<void> {
	async function removePublishedMarkdown(directory: string): Promise<void> {
		let stat: import("node:fs").Stats;
		try { stat = await fs.lstat(directory); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Plan directory must be a real directory: ${directory}`);
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (!canonicalRegistryEntryName(entry.name)) continue;
			const child = join(directory, entry.name);
			if (entry.isDirectory()) await removePublishedMarkdown(child);
			else if (canonicalPlanFileName(entry.name)) {
				if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Plan Markdown must be a regular file: ${child}`);
				await fs.unlink(child);
			}
		}
	}
	// Validate all published paths before removing any local plan. A remote
	// symlink or unreadable canonical file must not cause partial local deletion.
	await hashPath(source, "plans");
	await removePublishedMarkdown(destination);
	await copyTree(source, destination, "", "plans");
}

export function agentCompanion(file: string): string {
	return join(dirname(file), basename(file, ".md"));
}

export async function agentCompanionStat(file: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
	try {
		const stat = await fs.lstat(agentCompanion(file));
		if (!stat.isDirectory()) throw new Error(`Agent companion must be a regular directory: ${agentCompanion(file)}`);
		return await hasCanonicalResourceFiles(agentCompanion(file)) ? stat : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export async function replaceAgent(source: string, destination: string): Promise<void> {
	const sourceDir = agentCompanion(source);
	const destDir = agentCompanion(destination);
	const stat = await agentCompanionStat(source);
	await replaceResource(source, destination);
	await fs.rm(destDir, { recursive: true, force: true });
	if (stat) await copyTree(sourceDir, destDir);
}

export async function hashResource(type: ResourceType, path: string): Promise<string> {
	const fileHash = await hashPath(path);
	if (type !== "agent" || !(await agentCompanionStat(path))) return fileHash;
	const hash = createHash("sha256");
	hash.update(`agent-file\0${fileHash}\0companion\0`);
	hash.update(await hashPath(agentCompanion(path)));
	return hash.digest("hex");
}

export async function agentGitPaths(executor: RegistryExecutor, runtime: RegistryRuntime, name: string): Promise<string[]> {
	const file = registryResourceRelativePath("agent", name, runtime);
	const dir = file.slice(0, -3);
	const tracked = await runGit(executor, runtime.cacheDir, ["ls-files", "--", dir]);
	return (await pathExists(join(runtime.cacheDir, dir))) || tracked.stdout.trim() ? [file, dir] : [file];
}

export async function hashPath(path: string, mode: "resource" | "plans" = "resource"): Promise<string> {
	const hash = createHash("sha256");
	async function visit(current: string, rel: string): Promise<void> {
		const stat = await fs.lstat(current);
		if (stat.isSymbolicLink()) throw new Error(`Resource cannot contain symbolic links: ${rel || current}`);
		if (stat.isFile()) {
			hash.update(`file\0${rel}\0`);
			hash.update(await fs.readFile(current));
			return;
		}
		if (!stat.isDirectory()) throw new Error(`Unsupported resource entry: ${rel || current}`);
		hash.update(`dir\0${rel}\0`);
		const names = (await fs.readdir(current)).filter(canonicalRegistryEntryName).sort();
		for (const name of names) {
			const child = join(current, name);
			if (mode === "resource") {
				const childStat = await fs.lstat(child);
				if (childStat.isDirectory() && !(await hasCanonicalResourceFiles(child))) continue;
			}
			if (mode === "plans") {
				const childStat = await fs.lstat(child);
				if (childStat.isDirectory() && !(await hasTrackableFiles(child))) continue;
				if (!childStat.isDirectory() && !canonicalPlanFileName(name)) continue;
			}
			await visit(child, rel ? `${rel}/${name}` : name);
		}
	}
	await visit(path, "");
	return hash.digest("hex");
}
