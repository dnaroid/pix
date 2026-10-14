import { lstat, mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { checkedPath, contained, privateJson, readJson, safePath } from "./paths.mjs";

export const PROFILE_DIRECTORIES = ["home", "home/.pi", "home/.pi/agent", "home/.config", "home/.config/pi"];
export const PERSISTENT_QA_CONTRACT = "PIX_DESKTOP_PERSISTENT_QA_V1";

export async function privatePath(root, path, kind) {
	await safePath(root, path, kind);
	const stat = await lstat(path);
	if ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error("QA profile and manifest must be private and owned by this user");
}

export async function persistentProjectOption(checkout, options) {
	if (options.temporary && options.persistentProject) throw new Error("--temporary conflicts with --persistent-project");
	if (options.temporary) return undefined;
	let project = options.persistentProject;
	if (!project) {
		try {
			const path = join(checkout, ".pi", "qa-desktop.json");
			await safePath(checkout, path, "file");
			const settings = await readJson(path);
			if (settings.version !== 1 || typeof settings.persistentProject !== "string") throw new Error("invalid QA desktop settings");
			project = settings.persistentProject;
		} catch (error) { if (error.code !== "ENOENT") throw error; }
	}
	if (project && (options.emptyWorkspace || options.seedConfig || options.seedApiKeys)) throw new Error("persistent QA does not overwrite workspace/config/credentials; use --temporary for disposable seeding");
	return project ? checkedPath(project) : undefined;
}

function projectLayout(checkout, workspace) {
	workspace = checkedPath(workspace);
	if (workspace === checkout || contained(checkout, workspace) || contained(workspace, checkout)) throw new Error("persistent QA project must be separate from the source checkout");
	return { workspace, ownerDir: join(workspace, ".pix-qa"), profileDir: join(workspace, ".pix-qa", "profile") };
}

/** Validate without reading any configuration, credentials or conversation files. */
export async function validatePersistentProject(checkout, workspace) {
	const layout = projectLayout(checkout, workspace);
	if (await realpath(layout.workspace) !== layout.workspace) throw new Error("persistent QA project must be canonical, not redirected");
	await safePath(layout.workspace, layout.workspace, "directory");
	for (const path of [layout.ownerDir, layout.profileDir, ...PROFILE_DIRECTORIES.map((dir) => join(layout.profileDir, dir))]) await privatePath(layout.workspace, path, "directory");
	const marker = join(layout.profileDir, "profile.json");
	await privatePath(layout.workspace, marker, "file");
	const profile = await readJson(marker);
	if (profile.version !== 1 || profile.persistentWebview !== true || profile.checkoutRoot !== checkout || profile.workspace !== layout.workspace
		|| typeof profile.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(profile.id)) throw new Error("persistent QA profile ownership does not match project/checkout");
	return { ...layout, profileId: profile.id, persistentWebview: true };
}

/** Exclusive initialization. Partial/crashed initialization is never adopted. */
export async function preparePersistentProject(checkout, workspace) {
	const layout = projectLayout(checkout, workspace);
	await mkdir(layout.workspace, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
	if (await realpath(layout.workspace) !== layout.workspace) throw new Error("persistent QA project must be canonical, not redirected");
	await safePath(layout.workspace, layout.workspace, "directory");
	try { await mkdir(layout.ownerDir, { mode: 0o700 }); }
	catch (error) {
		if (error.code !== "EEXIST") throw error;
		return validatePersistentProject(checkout, workspace);
	}
	try {
		await mkdir(layout.profileDir, { mode: 0o700 });
		for (const directory of PROFILE_DIRECTORIES) await mkdir(join(layout.profileDir, directory), { mode: 0o700 });
		await privateJson(join(layout.profileDir, "profile.json"), {
			version: 1, id: randomUUID(), persistentWebview: true, workspace: layout.workspace, checkoutRoot: checkout,
		});
		return await validatePersistentProject(checkout, workspace);
	} catch (error) {
		await rm(layout.ownerDir, { recursive: true, force: true });
		throw error;
	}
}
