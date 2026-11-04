import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { matchesRuntime, validateManifest } from "./launch.mjs";
import { readJson } from "./paths.mjs";
import { privatePath } from "./persistent.mjs";

const exec = promisify(execFile);

async function inspectProcess(pid) {
	const options = { timeout: 2000, maxBuffer: 8192 };
	const { stdout: command } = await exec("/bin/ps", ["-p", String(pid), "-o", "comm="], options);
	const { stdout: parent } = await exec("/bin/ps", ["-p", String(pid), "-o", "ppid="], options);
	return { executable: command.trim(), parentPid: Number(parent.trim()) };
}

/** Fresh attach proof, not permission to reuse a historical identity/PID. */
export async function sessionTarget(options, dependencies = {}) {
	const { now = Date.now, inspect = inspectProcess } = dependencies;
	const manifest = await validateManifest(options.manifest, options.checkout);
	const identityPath = join(manifest.runDir, "identity.json");
	const runtimePath = join(manifest.profileDir, "runtime.json");
	const ownerPath = join(manifest.profileDir, "launch.lock", "owner.json");
	for (const path of [identityPath, runtimePath, ownerPath]) await privatePath(path === identityPath ? manifest.runDir : manifest.profileDir, path, "file");
	const identity = await readJson(identityPath);
	const owner = await readJson(ownerPath);
	const matchesOwner = (value) => value.version === 1 && value.pid === identity.ownerPid
		&& value.profileId === manifest.profileId && value.stopping === undefined;
	if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0
		|| !Number.isSafeInteger(identity.ownerPid) || identity.ownerPid <= 0
		|| !Number.isSafeInteger(identity.expiresAt) || now() >= identity.expiresAt
		|| !matchesOwner(owner)
		|| identity.profileId !== manifest.profileId || !matchesRuntime(identity, manifest, identity.pid)) throw new Error("no live owned QA session; do not attach using retained identity");
	const actual = await inspect(identity.pid);
	if (actual.executable !== manifest.executable || actual.parentPid !== identity.ownerPid
		|| now() >= identity.expiresAt || !matchesRuntime(await readJson(runtimePath), manifest, identity.pid)
		|| !matchesOwner(await readJson(ownerPath))) throw new Error("QA session process/runtime no longer matches its owner");
	return { pid: identity.pid, ownerPid: identity.ownerPid, expiresAt: identity.expiresAt, target: { application: { pid: identity.pid } } };
}
