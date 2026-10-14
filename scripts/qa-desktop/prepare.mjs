import { cp, mkdir, rename, rm, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createRun, privateJson, validateBundle } from "./paths.mjs";
import { discoverWatcher, successfulState } from "./watch.mjs";
import { seedProfile } from "./seed.mjs";
import { seedQaWorkspace } from "../qa-workspace.mjs";
import { persistentProjectOption, preparePersistentProject, PERSISTENT_QA_CONTRACT } from "./persistent.mjs";
import { requireNativeIsolation } from "./launch.mjs";

export function boundedTimeout(value = 120000) {
	const timeout = Number(value);
	if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300000) throw new Error("--timeout-ms must be an integer from 100 to 300000");
	return timeout;
}

/** Only pin an idle successful copied watch bundle; never mutate watcher ownership. */
export async function prepareDesktop(options, dependencies = {}) {
	const checkout = await realpath(options.checkout);
	const persistentProject = await persistentProjectOption(checkout, options);
	const timeout = boundedTimeout(options.timeoutMs);
	const { now = Date.now, wait = sleep, copy = cp, probe, tempRoot } = dependencies;
	const deadline = now() + timeout;
	const watcher = await discoverWatcher({ checkout, state: options.state, tempRoot, probe, deadline, now });
	const runDir = await createRun(checkout, options.runDir);
	try {
		let profileDir = join(runDir, "profile");
		for (const directory of persistentProject ? [] : ["profile", "profile/home", "profile/home/.pi", "profile/home/.pi/agent", "profile/home/.config", "profile/home/.config/pi", "workspace"]) {
			await mkdir(join(runDir, directory), { mode: 0o700 });
		}
		let profileId = randomUUID();
		let workspace = join(runDir, "workspace");
		const projectSeed = persistentProject || options.emptyWorkspace ? null : await seedQaWorkspace(workspace);
		let seed = { configFiles: 0, apiKeyCount: 0 };
		if (!persistentProject) {
			await privateJson(join(profileDir, "profile.json"), { version: 1, id: profileId });
			seed = await seedProfile(profileDir, { seedConfig: options.seedConfig, seedApiKeys: options.seedApiKeys, ...dependencies.seed });
		}
		let selected;
		let app;
		while (now() < deadline) {
			const staging = join(runDir, `.snapshot-${randomUUID()}`);
			try {
				selected = await successfulState(watcher, checkout, probe, { deadline, now });
				if (!selected) { await wait(Math.min(100, Math.max(1, deadline - now()))); continue; }
				await validateBundle(selected.bundle, deadline, now);
				await mkdir(staging, { mode: 0o700 });
				const snapshot = join(staging, basename(selected.bundle));
				await copy(selected.bundle, snapshot, { recursive: true, force: false, errorOnExist: true, dereference: false });
				await validateBundle(snapshot, deadline, now);
				// Pruning may race the copy. Publication/status must still select this exact immutable artifact.
				const after = await successfulState(watcher, checkout, probe, { deadline, now });
				if (!after || after.target !== selected.target) { await wait(Math.min(100, Math.max(1, deadline - now()))); continue; }
				if (now() >= deadline) break;
				await rename(staging, join(runDir, "native"));
				app = join(runDir, "native", basename(selected.bundle));
				break;
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
				await wait(Math.min(100, Math.max(1, deadline - now())));
			} finally { await rm(staging, { recursive: true, force: true }); }
		}
		if (!app) throw new Error("timed out waiting for an idle successful watch:all bundle; check watcher terminal and retry prepare");
		if (persistentProject) {
			await requireNativeIsolation(join(app, "Contents", "MacOS", "pix-desktop"), PERSISTENT_QA_CONTRACT);
			({ profileDir, profileId, workspace } = await preparePersistentProject(checkout, persistentProject));
		}
		const manifest = {
			version: 1, kind: "pix-desktop-qa", checkoutRoot: checkout, runDir, profileDir, profileId,
			workspace, projectSeed, app, executable: join(app, "Contents", "MacOS", "pix-desktop"),
			source: { statePath: watcher.statePath, ownerPid: watcher.ownerPid, target: selected.target, buildStatus: "idle" },
			pinScope: "native-and-embedded-web; development ACP resolves from checkout", seed,
			...(persistentProject ? { persistentWebview: true } : {}),
		};
		const manifestPath = join(runDir, "manifest.json");
		await privateJson(manifestPath, manifest);
		return { manifestPath, workspace, projectSeed, testedSource: manifest.source, pinScope: manifest.pinScope, seed };
	} catch (error) {
		// Only a directory we created in this invocation can be removed.
		await rm(runDir, { recursive: true, force: true });
		throw error;
	}
}
